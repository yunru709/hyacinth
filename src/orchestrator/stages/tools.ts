/**
 * P1 状态收敛 · M5 —— tools 阶段模块（槽位 `tools`，模块 id `builtin:tool-dispatch`）。
 *
 * 职责（P1-状态收敛方案.md §三）：工具调度 —— beforeToolExecute 钩子、recentToolNames 更新、
 * plan 进度更新、inline 结果回写或后置执行（executeTools）、afterToolExecute 钩子。
 * 从 runTurn 摘出（原 ~2092-2122）。
 *
 * ## 依赖注入（StageContext.get/require）
 * - 'loopHooks'(before/afterToolExecute) / 'orchestrator'(plan 进度更新)
 * - 'toolService'：flushInline / executeTools（工具执行本体深度耦合权限链/storm/
 *   resultBuffer/turnRecorder，P5-13 闭包触手正规化后收敛为具名服务）
 *
 * ## 状态通道（TurnState）
 * - 输入：toolCalls / turn / recentToolNames / activePlan / inlineToolExecuted / inlineToolResults
 * - 产出：toolCalled(true 有工具) / recentToolNames / activePlan / inlineToolExecuted(false) /
 *   inlineToolResults(清空后新 Map)
 *
 * 注意：checkTextLoop 与 flow 判定留在 runTurn（A/B 分支各一次，与 finalize 相邻），
 * 本模块只做"工具执行调度"。
 */

import type { LLMOrchestrator } from '../planner.js';
import type { ToolCall } from '../../types.js';
import type { StageModule } from '../../kernel/pipeline.js';
import type { ToolService } from '../tool-service.js';
import type { ToolExecOutcome } from '../loop-tools.js';
import type { KernelStageContext, StageServiceMap } from '../stage-services.js';
import type { TurnState } from '../turn-state.js';

export const TOOLS_STAGE_ID = 'builtin:tool-dispatch';

export function createToolsStage(): StageModule<TurnState, StageServiceMap> {
  return {
    id: TOOLS_STAGE_ID,
    name: 'tool-dispatch',
    version: '1.0.0',
    // 契约：声明读写的 TurnState 字段；槽位 requires 必须 ⊆ 此处声明
    reads: ['toolCalls', 'turn', 'recentToolNames', 'activePlan', 'inlineToolExecuted', 'inlineToolResults'],
    writes: ['toolCalled', 'recentToolNames', 'activePlan', 'inlineToolExecuted', 'inlineToolResults'],
    async run(state: TurnState, ctx: KernelStageContext): Promise<TurnState> {
      const toolCalls = state.toolCalls;

      // 无工具调用 → 原样穿过（runTurn 走 flow 判定路径）
      if (toolCalls.length === 0) {
        return { ...state, toolCalled: false };
      }

      const loopHooks = ctx.require('loopHooks');
      const orchestrator = ctx.require('orchestrator');
      // 工具执行调度：收敛为 toolService（闭包触手正规化）
      const toolService = ctx.get('toolService');

      // ── 安全门禁已下沉到 runToolDispatch / runToolInline（loop-tools.ts）──
      // 旧实现在此 emit('beforeToolExecute') 丢弃返回值，拦截器剔除从不生效；
      // 现由工具执行入口直接消费拦截器洋葱（含 inline 路径），被剔除的调用
      // 写回明确的 denied 结果。此处不再重复触发，避免双重执行。

      // 更新 recentToolNames 用于模式检测
      const recentToolNames = toolCalls.map((tc) => tc.name);

      // Update plan progress based on tool calls
      let activePlan = state.activePlan;
      if (activePlan) {
        activePlan = orchestrator.updatePlanProgress(activePlan, toolCalls[0].name);
      }

      // 收集工具执行的真实结果摘要（P2：afterToolExecute 区分成败，替代恒 ok:true）
      let execOutcomes: ToolExecOutcome[] = [];
      if (state.inlineToolExecuted) {
        // Tools were executed inline during the stream — flush results to conversation
        if (toolService) {
          execOutcomes = await toolService.flushInline(toolCalls);
        }
      } else {
        // Fallback: execute tools after stream (for providers that don't emit TOOL_USE events mid-stream)
        if (toolService) {
          execOutcomes = await toolService.executeTools(toolCalls);
        }
      }

      // ── 钩子：工具执行之后（依赖影响面 / resultBuffer / diff 通道可在此挂载） ──
      // P2：载荷携带真实 ok/err 结果（工具执行失败/权限拒绝/storm 抑制 → ok:false）
      await loopHooks.emit('afterToolExecute', {
        turn: state.turn,
        results: execOutcomes,
      });

      return {
        ...state,
        toolCalled: true,
        recentToolNames,
        activePlan,
        inlineToolExecuted: false,
        inlineToolResults: new Map(), // 已 flush → 清空
      };
    },
  };
}

/** tools 阶段服务键声明（装配方注册时对照） */
export const TOOLS_STAGE_SERVICES = ['loopHooks', 'orchestrator', 'toolService'] as const;
