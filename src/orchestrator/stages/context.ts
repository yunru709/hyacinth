/**
 * P1 状态收敛 · M4 —— context 阶段模块（槽位 `context`，模块 id `builtin:layered-composer`）。
 *
 * 职责（P1-状态收敛方案.md §三）：工具过滤、历史预处理（effectiveHistory）、图片注入、
 * compose、压缩消费与触发、cluster 摘要。从 runTurn 摘出（原 loop.ts ~1714-2149，约 435 行）。
 *
 * ## 依赖注入（StageContext.get/require 服务表）
 * - 'conversationStore' / 'toolRegistry' / 'contextComposer' / 'compressor' / 'summaryStore' /
 *   'statsManager' / 'configCenter' / 'gitManager' / 'sessionDir'(每轮刷新) / 'maxContextTokens' /
 *   'loopHooks'(before/afterContextAssemble 钩子) / 'kbState'(引用) / 'bundleRegistry'(可选) /
 *   'outputHandler'(可选) / 'personaDir'(可选)
 * - 'getRouter'：惰性闭包 `() => this.activeRouter`（activeRouter 是 getter，随 companion 模式切换）
 * - 'clusterService'：意图簇 + deep 压缩（buildClusterHistoryTransform / restoreSummary，
 *   P5-13 闭包触手正规化后收敛为具名服务）
 *
 * ## 状态通道（TurnState）
 * - 输入：history / historyWithoutLastUser / userInput / uncompressedMsgs / hasPendingToolCalls /
 *   lastUserTextMsg / summary / impactInfo / needsCompression / needsAggressiveCompress /
 *   pendingCompression / compressCount / lastSavedSummary / lastContextTokens / activeProvider /
 *   bypassInjections / activePlan / kbQuery / pendingImageInjections（数组引用，消费后由调用方清空）
 * - 产出：toolDefinitions / messages / zoneBreakdown / summary / lastSavedSummary / lastContextTokens /
 *   needsCompression / needsAggressiveCompress / pendingCompression / compressCount / impactInfo(null 已消费) /
 *   uncompressedMsgs / kbQuery / userInput
 *
 * 行为与原 runTurn 内联代码逐位等价（M4 只迁移不改语义）。
 */

import type { Message, ToolDefinition } from '../../types.js';
import type { ToolBundleRegistry } from '../../tools/bundle-registry.js';
import type { ZoneBreakdown } from '../../context/composer.js';
import type { CompressorOrchestrator, CompressionResult } from '../../context/compressor.js';
import type { Injection } from '../../bypass/types.js';
import { getActiveProfile } from '../../context/profiles.js';
import { compressorUserId } from '../../provider/user-id.js';
import { basename } from 'node:path';
import { zone5TailBudgetRatio, poolMinHistory } from '../../context/context-config.js';
import { formatPlanAsText } from '../plan-store.js';
import { formatTimestamp, computeProtectCount, isSameTextMessage } from '../../utils/misc.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { ClusterService } from '../cluster-service.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const CONTEXT_STAGE_ID = 'builtin:layered-composer';

export function createContextStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: CONTEXT_STAGE_ID,
    name: 'layered-composer',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: [
      'history', 'historyWithoutLastUser', 'userInput', 'uncompressedMsgs',
      'hasPendingToolCalls', 'lastUserTextMsg', 'summary', 'impactInfo',
      'needsCompression', 'needsAggressiveCompress', 'pendingCompression',
      'compressCount', 'lastSavedSummary', 'lastContextTokens', 'activeProvider',
      'bypassInjections', 'activePlan', 'kbQuery', 'pendingImageInjections', 'pendingMediaInjections', 'tools',
    ],
    writes: [
      'toolDefinitions', 'messages', 'zoneBreakdown', 'summary', 'lastSavedSummary',
      'lastContextTokens', 'needsCompression', 'needsAggressiveCompress',
      'pendingCompression', 'compressCount', 'impactInfo', 'uncompressedMsgs',
      'kbQuery', 'userInput', 'activeProvider', 'pendingImageInjections',
    ],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      // ── 服务解析（get/require 键与类型受 StageServiceMap 编译期保护） ──
      const store = ctx.require('conversationStore');
      const toolRegistry = ctx.require('toolRegistry');
      const getRouter = ctx.require('getRouter');
      const composer = ctx.require('contextComposer');
      const configCenter = ctx.get('configCenter');
      const compressor = ctx.require('compressor');
      const summaryStore = ctx.get('summaryStore');
      const statsManager = ctx.require('statsManager');
      const output = ctx.get('outputHandler');
      const bundleRegistry = ctx.get('bundleRegistry');
      const kbState = ctx.get('kbState');
      const gitManager = ctx.require('gitManager');
      const maxContextTokens = ctx.require('maxContextTokens');
      const personaDir = ctx.get('personaDir');
      const sessionDir = ctx.require('sessionDir');
      const loopHooks = ctx.require('loopHooks');
      // 意图簇 + deep 压缩恢复：收敛为 clusterService（闭包触手正规化）
      const clusterService = ctx.get('clusterService');

      const userInput = state.userInput;
      const history = state.history;
      const activeProvider = state.activeProvider;

      // ── 全量存档召回（pool_context）：长会话/已压缩会话才读存档，避免每轮全量 I/O ──
      // 工作历史达到 poolMinHistory 条，或发生过压缩（存档里有被压掉的细节）时启用。
      // pool 检索从存档召回压缩丢掉的上下文 —— 压缩-存档-召回闭环的最后一根线。
      const poolEnabled = history.length >= poolMinHistory() || state.compressCount > 0;
      const fullHistory: Message[] | undefined = poolEnabled
        ? await store.readFull(sessionDir)
        : undefined;

      // ── 1. 工具过滤（Router 白名单 / bundle 展开 / 黑名单） ──
      const router = getRouter();
      const profile = getActiveProfile(); // 保留向后兼容
      let toolDefinitions = toolRegistry.getToolDefinitions(router.name === 'companion');

      if (router.toolAllowlist.length > 0) {
        const allowed = new Set(router.toolAllowlist);
        toolDefinitions = toolDefinitions.filter((t) => allowed.has(t.name));
      } else if (bundleRegistry) {
        // 工具包展开：激活时触发激进压缩 + pendingBundleSummary，下轮注入 summary 段（Zone 3）
        const allowed = bundleRegistry.getActiveToolNames();
        if (allowed.length > 0) {
          const allowedSet = new Set(allowed);
          toolDefinitions = toolDefinitions.filter((t) => allowedSet.has(t.name));
        }
      }

      // 黑名单过滤：始终生效，优先级高于白名单
      if (router.toolBlacklist.length > 0) {
        const blocked = new Set(router.toolBlacklist);
        toolDefinitions = toolDefinitions.filter((t) => !blocked.has(t.name));
      }

      // ── 2. 历史预处理：effectiveHistory（Router 过滤） ──
      let effectiveHistory = state.historyWithoutLastUser;
      let effectivePersonaDir = personaDir;
      effectiveHistory = state.hasPendingToolCalls
        ? state.historyWithoutLastUser
        : router.filterHistory(state.historyWithoutLastUser);

      // ── 3. 图片注入（仅视觉模型；注入后由调用方清空 pendingImageInjections） ──
      if (state.pendingImageInjections.length > 0 && (activeProvider.getCapabilities?.()?.vision ?? false)) {
        for (const pi of state.pendingImageInjections) {
          const imgMsg: Message = {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: pi.media_type, data: pi.data } },
              { type: 'text', text: `[Re-examining Image #${pi.imgId}]` },
            ],
          };
          await store.append(sessionDir, imgMsg);
          effectiveHistory = [...effectiveHistory, imgMsg];
        }
      }

      // ── 3b. 原生视频/音频注入（仅支持对应输入能力的模型；注入后由调用方清空） ──
      if (state.pendingMediaInjections.length > 0) {
        const inputTypes = activeProvider.getCapabilities?.()?.inputTypes;
        for (const pi of state.pendingMediaInjections) {
          const supported = pi.type === 'video'
            ? (inputTypes?.includes('video') ?? false)
            : (inputTypes?.includes('audio') ?? false);
          if (!supported) continue; // 能力不支持 → 丢弃（发送时适配器也会降级，双保险）
          const mediaBlock = pi.type === 'video'
            ? { type: 'video' as const, source: { type: 'base64' as const, media_type: pi.media_type, data: pi.data }, media_type: pi.media_type }
            : { type: 'audio' as const, source: { type: 'base64' as const, media_type: pi.media_type, data: pi.data }, media_type: pi.media_type };
          const mediaMsg: Message = {
            role: 'user',
            content: [
              mediaBlock,
              { type: 'text', text: `[Re-examining ${pi.type === 'video' ? 'Video' : 'Audio'} #${pi.data.slice(0, 8)}…]` },
            ],
          };
          await store.append(sessionDir, mediaMsg);
          effectiveHistory = [...effectiveHistory, mediaMsg];
        }
      }

      // ── 4. 知识库检索查询（必须在 compose 之前，确保 Zone 4 读到当前轮提问） ──
      if (kbState) {
        kbState.lastQuery = userInput;
      }

      // ── 5. 意图簇：构建历史过滤钩子（经 clusterService，缺服务时跳过） ──
      const historyTransform = clusterService
        ? await clusterService.buildClusterHistoryTransform().catch(() => null)
        : null;

      // ── 6. 钩子：上下文组装之前（旁路 preTurn/注入已在调用方归位，工具列表已过滤） ──
      await loopHooks.emit('beforeContextAssemble', {
        turn: state.turn,
        userInput,
        history,
        toolNames: toolDefinitions.map((t) => t.name),
      });

      // ── 7. Compose with layered options ──
      let historySummary = state.summary;
      const layeredResult = await composer.compose({
        sessionDir,
        providerType: activeProvider.getProviderType(),
        maxContextTokens,
        cwd: process.cwd(),
        timestamp: formatTimestamp(),
        tools: toolDefinitions,
        history: effectiveHistory,
        userInput,
        historySummary,
        currentPlan: state.activePlan ? formatPlanAsText(state.activePlan) : undefined,
        zone3Hashes: undefined,
        impactInfo: state.impactInfo ?? undefined,
        fullHistory,
        personaDir: effectivePersonaDir,
        gitManager,
        profile,
        bypassInjections: state.bypassInjections,
        historyTransform,
      });
      state.impactInfo = null; // 已使用的影响面信息 → 清除（对应原 pendingImpactInfo = null）
      const messages = layeredResult.messages;

      // ── 8. 钩子：上下文组装之后 + token 记账 ──
      await loopHooks.emit('afterContextAssemble', {
        turn: state.turn,
        messages,
        tokens: layeredResult.zoneBreakdown.total,
      });
      let lastContextTokens = layeredResult.zoneBreakdown.total;

      // ── 9. 压缩触发阈值（compose 后检测 Zone 总 token） ──
      const compressThreshold = configCenter
        ? (configCenter.get('context.compressThreshold') as number) ?? 0.75
        : 0.75;
      const emergencyThreshold = configCenter
        ? (configCenter.get('context.emergencyThreshold') as number) ?? 0.92
        : 0.92;

      // 状态游标（压缩逻辑会改写，最后统一回写 state）
      let needsCompression = state.needsCompression;
      let needsAggressiveCompress = state.needsAggressiveCompress;
      let pendingCompression = state.pendingCompression;
      let compressCount = state.compressCount;
      let lastSavedSummary = state.lastSavedSummary;
      let currentSummary = state.summary;
      let uncompressedMsgs = state.uncompressedMsgs;

      // ── 10. Step 1：消费上一轮的后台压缩结果 ──
      if (pendingCompression) {
        const compressionResult = await pendingCompression;
        pendingCompression = null;

        if (compressionResult) {
          const compressedHistory = compressionResult.messages;
          historySummary = compressionResult.summary || currentSummary;

          await store.replace(sessionDir, compressedHistory);

          // 更新 uncompressedMsgs 为压缩后的消息，避免 Step 2 用旧数据再次压缩
          uncompressedMsgs = compressedHistory;

          if (compressionResult.summary) {
            currentSummary = compressionResult.summary;
            if (compressionResult.summary !== lastSavedSummary) {
              await summaryStore?.save(sessionDir, compressionResult.summary);
              lastSavedSummary = compressionResult.summary;
            }
          }

          if (compressionResult.phasesUsed.length > 0) {
            compressCount++;
            await statsManager.increment(sessionDir, 'compact_count', 1);
          }

          // 重新 compose（用压缩后的 history）
          const lastUser = state.lastUserTextMsg;
          const compressedHistoryWithoutLastUser = state.hasPendingToolCalls
            ? compressedHistory
            : lastUser
              ? compressedHistory.filter((m) => !isSameTextMessage(m, lastUser))
              : compressedHistory;

          const reLayeredResult = await composer.compose({
            sessionDir,
            providerType: activeProvider.getProviderType(),
            maxContextTokens,
            cwd: process.cwd(),
            timestamp: formatTimestamp(),
            tools: toolDefinitions,
            history: compressedHistoryWithoutLastUser,
            userInput,
            historySummary,
            currentPlan: state.activePlan ? formatPlanAsText(state.activePlan) : undefined,
            zone3Hashes: undefined,
            impactInfo: state.impactInfo ?? undefined,
            fullHistory,
            personaDir,
            gitManager,
            profile,
            bypassInjections: state.bypassInjections,
            historyTransform,
          });

          layeredResult.messages.length = 0;
          layeredResult.messages.push(...reLayeredResult.messages);
          layeredResult.zoneBreakdown = reLayeredResult.zoneBreakdown;

          // 更新 lastContextTokens 为压缩后的实际值
          const preCompressTokens = lastContextTokens;
          lastContextTokens = reLayeredResult.zoneBreakdown.total;

          // 输出压缩结果（使用实际 token 数）
          if (compressionResult.phasesUsed.length > 0) {
            output?.onStatus?.(
              `compress-result:${preCompressTokens}:${lastContextTokens}`,
              'info',
            );
          }

          // 激进压缩兜底检测：常规压缩后仍超标
          if (reLayeredResult.zoneBreakdown.total > maxContextTokens * compressThreshold) {
            if (!needsAggressiveCompress) {
              needsAggressiveCompress = true;
              output?.onStatus?.(
                `Compression insufficient (${reLayeredResult.zoneBreakdown.total.toLocaleString()} > ${Math.floor(maxContextTokens * compressThreshold).toLocaleString()}), will unprotect recent messages next turn`,
                'warn',
              );
            } else {
              ctx.logger.error(
                `Compressor failed to reduce context below safety threshold: ${reLayeredResult.zoneBreakdown.total}/${maxContextTokens}`,
              );
              needsAggressiveCompress = false;
              output?.onStatus?.(
                `Compressor failed after aggressive compression, continuing with ${reLayeredResult.zoneBreakdown.total.toLocaleString()} tokens`,
                'error',
              );
            }
          } else if (needsAggressiveCompress) {
            needsAggressiveCompress = false;
          }
        }
        // Step 1 消费完毕 → 恢复 deep 压缩临时模板
        clusterService?.restoreSummary();
      }

      // ── 11. Step 2：当前轮次超标 → 异步或同步压缩 ──
      const currentTokens = layeredResult.zoneBreakdown.total;

      // 压缩条件：token 超阈值，或 trigger_compression 主动要求
      if (currentTokens > maxContextTokens * compressThreshold || needsCompression) {
        needsCompression = false;
        const zone5TailBudget = Math.floor(maxContextTokens * zone5TailBudgetRatio());
        const protectCount = needsAggressiveCompress
          ? 0
          : computeProtectCount(uncompressedMsgs, zone5TailBudget);

        // 紧急阈值：上下文接近爆满 → 同步压缩，停主对话等结果
        if (currentTokens > maxContextTokens * emergencyThreshold) {
          output?.onStatus?.(
            `⚠ Emergency: ${currentTokens.toLocaleString()} tokens (${Math.round(currentTokens / maxContextTokens * 100)}%) — compressing synchronously to prevent overflow`,
            'warn',
          );

          if (uncompressedMsgs && uncompressedMsgs.length > 0) {
            output?.onStatus?.('compress-start', 'info');
            try {
              const emergencyResult = await compressor.compress(
                uncompressedMsgs,
                currentSummary,
                0, // 不保护最近消息
                maxContextTokens,
                { userId: compressorUserId(basename(sessionDir)) },
              );

              if (emergencyResult) {
                const compressedHistory = emergencyResult.messages;
                historySummary = emergencyResult.summary || currentSummary;
                await store.replace(sessionDir, compressedHistory);
                uncompressedMsgs = compressedHistory;

                if (emergencyResult.summary) {
                  currentSummary = emergencyResult.summary;
                  if (emergencyResult.summary !== lastSavedSummary) {
                    await summaryStore?.save(sessionDir, emergencyResult.summary);
                    lastSavedSummary = emergencyResult.summary;
                  }
                }

                if (emergencyResult.phasesUsed.length > 0) {
                  compressCount++;
                  await statsManager.increment(sessionDir, 'compact_count', 1);
                }

                // 重新 compose
                const lastUser = state.lastUserTextMsg;
                const emergencyHistory = state.hasPendingToolCalls
                  ? compressedHistory
                  : lastUser
                    ? compressedHistory.filter((m) => !isSameTextMessage(m, lastUser))
                    : compressedHistory;

                const reLayeredResult = await composer.compose({
                  sessionDir,
                  providerType: activeProvider.getProviderType(),
                  maxContextTokens,
                  cwd: process.cwd(),
                  timestamp: formatTimestamp(),
                  tools: toolDefinitions,
                  history: emergencyHistory,
                  userInput,
                  historySummary,
                  currentPlan: state.activePlan ? formatPlanAsText(state.activePlan) : undefined,
                  zone3Hashes: undefined,
                  impactInfo: state.impactInfo ?? undefined,
                  fullHistory,
                  personaDir,
                  gitManager,
                  profile,
                  bypassInjections: state.bypassInjections,
                });

                layeredResult.messages.length = 0;
                layeredResult.messages.push(...reLayeredResult.messages);
                layeredResult.zoneBreakdown = reLayeredResult.zoneBreakdown;

                const preTokens = lastContextTokens;
                lastContextTokens = reLayeredResult.zoneBreakdown.total;
                output?.onStatus?.(
                  `compress-result:${preTokens}:${lastContextTokens}`,
                  'info',
                );
              }
            } catch (err) {
              ctx.logger.warn('Emergency compression failed', { error: (err as Error)?.message ?? String(err) });
            } finally {
              output?.onStatus?.('compress-end', 'info');
              // 紧急同步压缩完成 → 恢复 deep 压缩临时模板
              clusterService?.restoreSummary();
            }
          }
        } else {
          // 正常阈值：异步后台压缩（不阻塞 LLM 调用）
          output?.onStatus?.(
            `Context ${currentTokens.toLocaleString()} > ${Math.floor(maxContextTokens * compressThreshold).toLocaleString()} → compressing in background${needsAggressiveCompress ? ' (recent messages unprotected)' : ''} (protect: ${protectCount} msgs)`,
            'warn',
          );

          if (uncompressedMsgs && uncompressedMsgs.length > 0) {
            output?.onStatus?.('compress-start', 'info');
            pendingCompression = compressor.compress(
              uncompressedMsgs,
              currentSummary,
              protectCount,
              maxContextTokens,
              { userId: compressorUserId(basename(sessionDir)) },
            ).catch((err: unknown) => {
              ctx.logger.warn('Background compression failed', { error: (err as Error)?.message ?? String(err) });
              return null;
            }).finally(() => {
              output?.onStatus?.('compress-end', 'info');
              // 后台异步压缩完成 → 恢复 deep 压缩临时模板
              clusterService?.restoreSummary();
            });
          }
        }
      }

      // ── 12. stats 记账 + 状态回写 ──
      await statsManager.update(sessionDir, {
        current_context_tokens: layeredResult.zoneBreakdown.total,
      });

      return {
        ...state,
        toolDefinitions,
        messages: layeredResult.messages,
        zoneBreakdown: layeredResult.zoneBreakdown,
        summary: currentSummary,
        lastSavedSummary,
        lastContextTokens,
        needsCompression,
        needsAggressiveCompress,
        pendingCompression,
        compressCount,
        impactInfo: null, // 已消费
        uncompressedMsgs,
        kbQuery: kbState?.lastQuery ?? state.kbQuery,
        userInput,
        activeProvider,
        pendingImageInjections: state.pendingImageInjections, // 原数组引用，调用方负责清空
      };
    },
  };
}

/** context 阶段服务键声明（装配方注册时对照） */
export const CONTEXT_STAGE_SERVICES = [
  'conversationStore', 'toolRegistry', 'contextComposer', 'compressor', 'summaryStore',
  'statsManager', 'configCenter', 'gitManager', 'sessionDir', 'maxContextTokens',
  'loopHooks', 'kbState', 'getRouter', 'clusterService',
  'bundleRegistry', 'outputHandler', 'personaDir',
] as const;

export type { ZoneBreakdown, CompressionResult, Injection };
