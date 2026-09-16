/**
 * P1 状态收敛 · M5 —— llm 阶段模块（槽位 `llm`，模块 id `builtin:provider-stream`）。
 *
 * 职责（P1-状态收敛方案.md §三）：Provider 路由结果消费、thinking 配置、LLM 流式消费、
 * 流内工具执行（inline）、fallback 统计、assistant 消息落盘。从 runTurn 摘出（原 ~1827-2090）。
 *
 * ## 依赖注入（StageContext.get/require）
 * - 'conversationStore' / 'eventStore' / 'statsManager' / 'configCenter' / 'sessionDir'(每轮刷新) /
 *   'loopHooks'(onStreamEvent) / 'outputHandler'(可选)
 * - 'toolService'：流内工具执行（executeSingleInline / flushInline / executeTools，
 *   P5-13 闭包触手正规化后收敛为具名服务）
 * * ## 状态通道（TurnState）
 * - 输入：messages / toolDefinitions / activeProvider / cacheStats / inlineToolExecuted / inlineToolResults
 * - 产出：streamText(join 后) / toolCalls / stopReason / cacheStats / inlineToolExecuted / inlineToolResults
 *
 * 行为与原 runTurn 内联代码逐位等价（M5 只迁移不改语义；中断判定改用 ctx.signal）。
 */

import type { Message, ToolCall, ThinkingContent, TextContent, ToolUseContent } from '../../types.js';
import { OutputRouter } from '../../parser/router.js';
import { getModelInfo } from '../../provider/catalog.js';
import { scavengeToolCalls } from '../../repair/scavenge.js';
import { isFlowTool } from '../../tools/flow.js';
import { appendEvent } from '../../memory/events.js';
import { formatTimestamp, summarizeToolInput } from '../../utils/misc.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { ToolService } from '../tool-service.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState, CacheStats, CacheTurnRecord } from '../turn-state.js';

export const LLM_STAGE_ID = 'builtin:provider-stream';

/**
 * 逐轮缓存记录的环形上限。
 *
 * 命中率平均值与 `(Nt)` 轮次计数依赖轮次历史（`cacheStats.turns`）。该历史现在**始终记录**
 * （不再受 `logging.logCacheHits` 开关控制，见 onUsage 处注释），因此需要一个上限避免超长
 * 会话内存无界增长：只保留最近 200 轮。200 轮足以让平均值稳定，且每轮记录仅一个小对象。
 */
export const CACHE_TURNS_MAX = 200;

export function createLlmStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: LLM_STAGE_ID,
    name: 'provider-stream',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['messages', 'toolDefinitions', 'activeProvider', 'turn', 'cacheStats', 'inlineToolExecuted', 'inlineToolResults'],
    writes: ['streamText', 'toolCalls', 'stopReason', 'cacheStats', 'inlineToolExecuted', 'inlineToolResults'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      const configCenter = ctx.get('configCenter');
      const store = ctx.require('conversationStore');
      const eventStore = ctx.require('eventStore');
      const statsManager = ctx.require('statsManager');
      const loopHooks = ctx.require('loopHooks');
      const sessionDir = ctx.require('sessionDir');
      const oh = ctx.get('outputHandler');
      // 流内工具执行：收敛为 toolService（闭包触手正规化）
      const toolService = ctx.get('toolService');

      const activeProvider = state.activeProvider;
      const messages = state.messages;
      const toolDefinitions = state.toolDefinitions;

      // ── 1. thinking 配置（TUI /think 命令可运行时切换） ──
      const thinkingEnabled = (configCenter?.get('provider.enableThinking') as boolean) ?? false;
      const thinkingEffort = thinkingEnabled
        ? getModelInfo(activeProvider.getProviderType(), activeProvider.getModel())?.reasoningEffort
        : undefined;
      activeProvider.setThinking?.(thinkingEnabled, thinkingEffort);

      // ── 2. 流式请求 LLM ──
      const stream = activeProvider.createStream(messages, toolDefinitions, ctx.signal);

      // ── 3. OutputRouter 解析 + 回调（事件落盘 / cache 统计） ──
      const router = new OutputRouter();
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      let usageInput = 0;
      let usageOutput = 0;
      let stopReason: string | undefined;
      let inlineToolExecuted = state.inlineToolExecuted;
      const inlineToolResults = state.inlineToolResults;
      const cacheStats: CacheStats = { ...state.cacheStats, turns: [...state.cacheStats.turns] };

      oh?.onTurnStart?.();

      router.onText = (content: string) => {
        oh?.onText?.(content);
        textParts.push(content);
        // Write event (fire-and-forget)
        appendEvent(sessionDir, {
          type: 'text',
          content,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      };

      router.onThinking = (content: string) => {
        oh?.onThinking?.(content);
        thinkingParts.push(content);
        appendEvent(sessionDir, {
          type: 'thinking',
          content,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      };

      router.onToolUse = (id: string, name: string, input: Record<string, unknown>) => {
        const inputSummary = summarizeToolInput(input);
        oh?.onToolUse?.(name, inputSummary, id);
        toolCalls.push({ id, name, input });
        appendEvent(sessionDir, {
          type: 'tool_call',
          id,
          name,
          input,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      };

      router.onUsage = (
        inputTokens: number,
        outputTokens: number,
        hit?: number,
        miss?: number,
        anthroRead?: number,
        anthroCreation?: number,
      ) => {
        usageInput = inputTokens;
        usageOutput = outputTokens;

        // 归一化：DeepSeek/OpenAI 用 cache_hit_tokens/cache_miss_tokens，
        // Anthropic 用 cache_read_input_tokens（命中）/ cache_creation_input_tokens（新建）。
        let effectiveHit: number | undefined;
        let effectiveMiss: number | undefined;

        if (hit !== undefined && miss !== undefined) {
          effectiveHit = hit;
          effectiveMiss = miss;
        } else if (anthroRead !== undefined && inputTokens > 0) {
          effectiveHit = anthroRead;
          effectiveMiss = Math.max(0, inputTokens - anthroRead);
        }

        if (effectiveHit !== undefined && effectiveMiss !== undefined) {
          cacheStats.hitTokens = effectiveHit;
          cacheStats.missTokens = effectiveMiss;

          // 逐轮缓存记录**始终记录**（与日志开关解耦）：
          //   1) 命中率平均值需要轮次历史，否则 UI 只能看到"最近一轮"（噪声大）；
          //   2) UI 的 `(Nt)` 轮次计数同样依赖它；
          //   3) 记录体积极小（每轮一个对象），因此用环形上限控制，而不是用开关一刀切。
          // `logging.logCacheHits` 保留其**日志/落盘**语义（见下方 stats 记账处的 gate），
          // 不再作为历史记录的门 —— 历史上它默认为 false，导致 (Nt) 与平均值全程不可用。
          const total = effectiveHit + effectiveMiss;
          const hitRate = total > 0 ? (effectiveHit / total) * 100 : 0;

          const record: CacheTurnRecord = {
            turn: state.turn,
            timestamp: new Date().toISOString(),
            inputTokens,
            outputTokens,
            hitTokens: effectiveHit,
            missTokens: effectiveMiss,
            hitRate: Math.round(hitRate * 100) / 100,
          };
          cacheStats.turns.push(record);
          if (cacheStats.turns.length > CACHE_TURNS_MAX) {
            cacheStats.turns.splice(0, cacheStats.turns.length - CACHE_TURNS_MAX);
          }
        }
      };

      router.onStop = (reason: string) => {
        stopReason = reason;
      };

      // ── 4. 消费流（inline tool execution: TOOL_USE 到达即执行） ──
      const inlineToolPromises: Promise<void>[] = [];

      try {
        for await (const event of stream) {
          if (ctx.signal?.aborted) break;
          router.route(event);
          // ── 钩子：流事件（scavenge 修复、事件落盘、inline 执行可在此观察） ──
          await loopHooks.emit('onStreamEvent', { turn: state.turn, event });

          if (event.type === 'TOOL_USE') {
            const { id, name, input } = event;
            if (id && name) {
              inlineToolExecuted = true;
              if (toolService) {
                inlineToolPromises.push(toolService.executeSingleInline(id, name, input));
              }
            }
          }
        }
      } catch (err) {
        const name = (err instanceof Error) ? err.name : '';
        if (name !== 'AbortError' && name !== 'APIUserAbortError') {
          // 非用户中断 → 重新抛出（调用方 catch 兜底通知）
          throw err;
        }
      }

      // Wait for all inline tool executions to complete before proceeding
      if (inlineToolPromises.length > 0) {
        await Promise.allSettled(inlineToolPromises);
      }

      // ── 5. 去重：ResilientProvider 重试流时可能累积重复 toolCalls（保留 last-wins） ──
      if (toolCalls.length > 0) {
        const seen = new Map<string, number>();
        for (let i = 0; i < toolCalls.length; i++) {
          const key = `${toolCalls[i].name}|${JSON.stringify(toolCalls[i].input)}`;
          seen.set(key, i);
        }
        const deduped = new Set(seen.values());
        const orphanIds = new Set<string>();
        for (let i = 0; i < toolCalls.length; i++) {
          if (!deduped.has(i)) {
            orphanIds.add(toolCalls[i].id);
          }
        }
        if (orphanIds.size > 0) {
          ctx.logger.debug(`Deduped ${orphanIds.size} orphan tool call(s) from stream retry`);
          for (const id of orphanIds) {
            inlineToolResults.delete(id);
          }
          const kept = toolCalls.filter((_, i) => deduped.has(i));
          toolCalls.length = 0;
          toolCalls.push(...kept);
        }
      }

      // ── 6. Scavenge：从 thinking/text 内容恢复模型漏声明的工具调用 ──
      const scavengeEnabled = configCenter
        ? (configCenter.get('repair.scavenge.enabled') as boolean)
        : true;

      if (scavengeEnabled !== false && toolCalls.length === 0 && thinkingParts.length > 0) {
        const scavenged = scavengeToolCalls(thinkingParts, textParts, toolCalls);
        if (scavenged.length > toolCalls.length) {
          const newCalls = scavenged.filter((c) => c.id.startsWith('scvg_'));
          ctx.logger.debug(`Scavenged ${newCalls.length} tool(s) from thinking: ${newCalls.map((c) => c.name).join(', ')}`);
          newCalls.forEach((c) => {
            oh?.onToolUse?.(c.name, JSON.stringify(c.input).slice(0, 80), c.id);
          });
          toolCalls.length = 0;
          toolCalls.push(...scavenged);
        }
      }

      // ── 7. thinking-only 模型兜底：thinking 有内容但 text 为空时提升为 text ──
      if (textParts.length === 0 && thinkingParts.length > 0) {
        const thinkingText = thinkingParts.join('');
        textParts.push(thinkingText);
        oh?.onText?.(thinkingText);
      }

      // ── 8. 输出刷新 ──
      if (textParts.length > 0 || thinkingParts.length > 0) {
        oh?.onFlush?.();
      }

      // ── 9. stats 记账（token 累计） ──
      const currentStats = await statsManager.get(sessionDir);
      const statsUpdate: Record<string, unknown> = {
        input_tokens: currentStats.input_tokens + usageInput,
        output_tokens: currentStats.output_tokens + usageOutput,
      };
      if (cacheStats.logHits) {
        statsUpdate.cache_turns = cacheStats.turns.length > 0 ? cacheStats.turns : currentStats.cache_turns;
      }
      await statsManager.update(sessionDir, statsUpdate as never);

      // ── 10. usage 事件 ──
      if (usageInput > 0 || usageOutput > 0) {
        await eventStore.append(sessionDir, {
          type: 'usage',
          input_tokens: usageInput,
          output_tokens: usageOutput,
          timestamp: formatTimestamp(),
        });
      }

      // ── 12. assistant 消息构建 + 落盘 ──
      const assistantContent: (ThinkingContent | TextContent | ToolUseContent)[] = [];

      if (thinkingParts.length > 0) {
        assistantContent.push({ type: 'thinking', thinking: thinkingParts.join('') });
      }
      if (textParts.length > 0) {
        assistantContent.push({ type: 'text', text: textParts.join('') });
      }

      // 添加工具调用（Flow 工具不记入历史，只记事件）
      for (const tc of toolCalls) {
        if (!isFlowTool(tc.name)) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        // 事件记录保留全部（含 Flow 工具），用于诊断
        await eventStore.append(sessionDir, {
          type: 'tool_call',
          tool_name: tc.name,
          tool_use_id: tc.id,
          timestamp: formatTimestamp(),
        });
      }

      if (assistantContent.length > 0) {
        const assistantMessage: Message = {
          role: 'assistant',
          content: assistantContent,
        };
        await store.append(sessionDir, assistantMessage);
      }

      return {
        ...state,
        streamText: textParts.join(''),
        toolCalls,
        stopReason,
        cacheStats,
        inlineToolExecuted,
        inlineToolResults,
        usageInput,
        usageOutput,
      };
    },
  };
}

/** llm 阶段服务键声明（装配方注册时对照） */
export const LLM_STAGE_SERVICES = [
  'conversationStore', 'eventStore', 'statsManager', 'configCenter', 'sessionDir',
  'loopHooks', 'outputHandler', 'toolService',
] as const;
