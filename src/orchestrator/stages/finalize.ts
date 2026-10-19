/**
 * P1 状态收敛 · M3 —— finalize 阶段模块（槽位 `finalize`，模块 id `builtin:turn-finalize`）。
 *
 * 职责（P1-状态收敛方案.md §三）：回合收尾的**判停决策** —— turnRecorder.endTurn、
 * stop 判定。本模块**不写 stop 事件**：最终是否停、stopReason 是什么，由
 * `_runInternal` 在跑完截断续写 / 异步注入 / stop 门链之后统一落盘（单一写者）。
 *
 * 为什么把事件写入移出：finalize 返回的 stop 是**暂定值**。它后面还可能被
 * truncation 续写、async 子 Agent 注入、goal/verification/evidence 门改判；
 * 如果这里先写 stop 事件，日志会出现“已结束但实际还在跑”的假记录。
 *
 * 判定表（行为与原实现一致，只是不再落盘）：
 *
 *   | 入参标记            | 返回                                       |
 *   |---------------------|--------------------------------------------|
 *   | goalStatus achieved | { stop: true, stopReason: 'goal_achieved' } |
 *   | sayStatus submitted | { stop: true, stopReason: 'say_submitted' } |
 *   | sayStatus aborted   | { stop: true, stopReason: 'say_failed' }    |
 *   | toolCalled: true    | { stop: false, toolCalled: true }          |
 *   | flowStillActive: t  | { stop: false, toolCalled: false }         |
 *   | 默认                | { stop: true, stopReason }                 |
 *
 * 依赖注入走 StageContext.get/require：
 * - 'turnRecorder' → TurnRecorder（可缺省：未注入则跳过回合记账）
 */

import type { StageModule } from '../../kernel/pipeline.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const FINALIZE_STAGE_ID = 'builtin:turn-finalize';

export function createFinalizeStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: FINALIZE_STAGE_ID,
    name: 'turn-finalize',
    version: '1.1.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['stop', 'toolCalled', 'flowStillActive', 'sayStatus', 'goalStatus'],
    writes: ['stop', 'stopReason'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      // ── 回合回滚：回合结束记录（尽力而为，不阻塞主循环） ──
      const turnRecorder = ctx.get('turnRecorder');
      if (turnRecorder) {
        turnRecorder.endTurn().catch((err: unknown) => {
          ctx.logger.warn('TurnRecorder endTurn failed', { error: (err as Error).message });
        });
      }

      // ── goal 验收通过判停（必须先于 sayStatus / toolCalled）──
      // finish_goal 通过审查后 loop 置 goalStatus='achieved'；它同样是一次工具调用，
      // 若排在 toolCalled 之后便永远停不下来（与 say 同理）。
      if (state.goalStatus === 'achieved') {
        return { ...state, stop: true, stopReason: 'goal_achieved' };
      }

      // ── report 交付/中止判停（必须先于 toolCalled）──
      // report 本身也是一次工具调用（toolCalled=true），若排在它后面就永远停不下来。
      if (state.sayStatus === 'submitted' || state.sayStatus === 'aborted') {
        const reason = state.sayStatus === 'submitted' ? 'say_submitted' : 'say_failed';
        return { ...state, stop: true, stopReason: reason };
      }

      // 有工具调用 → 工具已执行，继续下一轮（stopReason 不传递，与原返回语义一致）
      if (state.toolCalled) {
        return { ...state, stop: false, toolCalled: true, stopReason: undefined };
      }

      // Flow 状态机仍在运行 → 继续 loop（死循环由 LoopGuard 兜底）
      if (state.flowStillActive) {
        return { ...state, stop: false, toolCalled: false, stopReason: undefined };
      }

      // 正常结束：只给暂定 stop；事件由 driver 在门链之后统一写
      return { ...state, stop: true, stopReason: state.stopReason || 'end_turn' };
    },
  };
}

/** finalize 阶段服务键声明（装配方注册时对照） */
export const FINALIZE_STAGE_SERVICES = ['turnRecorder'] as const;
