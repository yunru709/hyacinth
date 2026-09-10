/**
 * P1 状态收敛 · M6 —— bypass 阶段模块（槽位 `bypass`，模块 id `builtin:bypass-preturn`）。
 *
 * 职责（P1-状态收敛方案.md §三）：preTurn（仅首轮）、注入合并、意图消费。
 * 从 runTurn 摘出（原 ~1771-1812）：
 * - 首轮（bypassInjectionsCache 未建立）经 bypassManager.preTurn 产出：
 *   transformedInput 改写 userInput、注入缓存、orchestrator 意图消费（intent + bypass_intent 事件）
 * - 每次迭代合并 preTurn 缓存注入 + postTurn 运行时注入（consumeInjections）
 *
 * ## 依赖注入（StageContext.get/require）
 * - 'bypassManager'：惰性闭包 `() => this.bypassManager`（factory 构造后注入，存值会过期）
 * - 'eventStore' / 'sessionDir'(每轮刷新) / 'maxContextTokens' / 'outputHandler'(可选)
 *
 * ## 状态通道（TurnState）
 * - 输入：userInput / history / recentToolNames / lastContextTokens / bypassInjectionsCache
 * - 产出：userInput(可能改写) / bypassInjections / bypassInjectionsCache / intent / intentLabel
 *
 * 行为与原 runTurn 内联代码逐位等价（M6 只迁移不改语义）。
 */

import path from 'node:path';
import type { Injection, PreTurnContext } from '../../bypass/types.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const BYPASS_STAGE_ID = 'builtin:bypass-preturn';

export function createBypassStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: BYPASS_STAGE_ID,
    name: 'bypass-preturn',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['userInput', 'history', 'recentToolNames', 'lastContextTokens', 'bypassInjectionsCache'],
    writes: ['userInput', 'bypassInjections', 'bypassInjectionsCache', 'intent', 'intentLabel'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      const getBypassManager = ctx.get('bypassManager');
      const bypassManager = getBypassManager?.();
      const output = ctx.get('outputHandler');
      const eventStore = ctx.require('eventStore');
      const sessionDir = ctx.require('sessionDir');
      const maxContextTokens = ctx.require('maxContextTokens');

      let userInput = state.userInput;
      let cachedInjections = state.bypassInjectionsCache;
      let intent = state.intent;
      let intentLabel = state.intentLabel;

      // ── preTurn：仅在首轮迭代运行（缓存未建立），后续迭代复用缓存 ──
      if (cachedInjections === undefined && bypassManager) {
        const preTurnCtx: PreTurnContext = {
          userInput,
          recentHistory: (state.history ?? []).slice(-20),
          contextBudget: { used: state.lastContextTokens, total: maxContextTokens },
          recentToolCalls: state.recentToolNames ?? [],
          sessionId: path.basename(sessionDir),
        };
        output?.onStatus?.('bypass-start', 'info');
        const preTurnResult = await bypassManager.preTurn(preTurnCtx);
        output?.onStatus?.('bypass-end', 'info');
        if (preTurnResult.transformedInput !== undefined) {
          userInput = preTurnResult.transformedInput;
        }
        cachedInjections = preTurnResult.injections;
        // 消费 orchestrator 意图（用于意图簇过滤）
        if (preTurnResult.intent) {
          const cap = preTurnResult.intent.capability;
          intent = { capability: cap, confidence: preTurnResult.intent.confidence };
          intentLabel = `[${cap}] ${userInput.slice(0, 80)}`;
          // 写入 bypass_intent 事件
          try {
            await eventStore.append(sessionDir, {
              type: 'bypass_intent',
              capability: cap,
              confidence: preTurnResult.intent.confidence,
              sessionId: path.basename(sessionDir),
              timestamp: new Date().toISOString(),
            });
          } catch { /* 非关键 */ }
        }
      }

      // 合并 preTurn 产出 + postTurn 运行时注入（如纠正）
      const runtimeInjections = bypassManager?.consumeInjections() ?? [];
      const bypassInjections = [
        ...(cachedInjections ?? []),
        ...runtimeInjections,
      ];
      // 运行时注入消费后即清空，不带到下一轮（不修改缓存，只在本轮使用合并结果）

      return {
        ...state,
        userInput,
        bypassInjections,
        bypassInjectionsCache: cachedInjections,
        intent,
        intentLabel,
      };
    },
  };
}

/** bypass 阶段服务键声明（装配方注册时对照） */
export const BYPASS_STAGE_SERVICES = ['bypassManager', 'eventStore', 'sessionDir', 'maxContextTokens', 'outputHandler'] as const;

export type { Injection, PreTurnContext };
