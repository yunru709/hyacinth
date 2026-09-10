/**
 * P1 状态收敛 · M3 —— finalize 阶段模块（槽位 `finalize`，模块 id `builtin:turn-finalize`）。
 *
 * 职责（P1-状态收敛方案.md §三）：回合收尾 —— turnRecorder.endTurn、stop 判定与 stop 事件。
 * 从 runTurn 三个返回点（原 loop.ts ~2437-2476）收敛而来，行为等价：
 *
 *   | 入参标记            | 行为                                       | 返回 |
 *   |---------------------|--------------------------------------------|------|
 *   | toolCalled: true    | endTurn，不写 stop 事件                    | { stop: false, toolCalled: true } |
 *   | flowStillActive: t  | endTurn，不写 stop 事件                    | { stop: false, toolCalled: false } |
 *   | 默认                | endTurn + appendEvent('stop')              | { stop: true, stopReason } |
 *
 * beforeIterationEnd 钩子由调用方（runTurn）在返回后按 stop 语义继续 emit，语义与 M2 一致。
 * 依赖注入走 StageContext.get/require：
 * - 'turnRecorder' → TurnRecorder（可缺省：未注入则跳过回合记账）
 * - 'sessionDir'   → string（写 stop 事件）
 */

import { appendEvent } from '../../memory/events.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const FINALIZE_STAGE_ID = 'builtin:turn-finalize';

export function createFinalizeStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: FINALIZE_STAGE_ID,
    name: 'turn-finalize',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['stop', 'toolCalled', 'flowStillActive'],
    writes: ['stop', 'stopReason'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      // ── 回合回滚：回合结束记录（尽力而为，不阻塞主循环） ──
      const turnRecorder = ctx.get('turnRecorder');
      if (turnRecorder) {
        turnRecorder.endTurn().catch((err: unknown) => {
          ctx.logger.warn('TurnRecorder endTurn failed', { error: (err as Error).message });
        });
      }

      // 有工具调用 → 工具已执行，继续下一轮（stopReason 不传递，与原返回语义一致）
      if (state.toolCalled) {
        return { ...state, stop: false, toolCalled: true, stopReason: undefined };
      }

      // Flow 状态机仍在运行 → 继续 loop（不写 stop 事件；死循环由 LoopGuard 兜底）
      if (state.flowStillActive) {
        return { ...state, stop: false, toolCalled: false, stopReason: undefined };
      }

      // 正常结束：写 stop 事件
      const sessionDir = ctx.require('sessionDir');
      await appendEvent(sessionDir, {
        type: 'stop',
        reason: state.stopReason || 'end_turn',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      return { ...state, stop: true, stopReason: state.stopReason ?? 'end_turn' };
    },
  };
}

/** finalize 阶段服务键声明（装配方注册时对照） */
export const FINALIZE_STAGE_SERVICES = ['turnRecorder', 'sessionDir'] as const;
