// ============================================================
// goal 模式工具 —— enter_goal（进入）/ finish_goal（提交审查并从 goal 退出）
// ============================================================
// 与 say / ask_user 同构：**业务逻辑全在 loop 侧，经构造函数注入**，工具本身零依赖、
// 便于单测替换（提交函数用假的即可）。
//
//   - enter_goal(objective)  → loop.enterGoal：置 active + 落盘（用户路径是 /goal 命令，
//     这里给 agent「应用户要求」的那条路径）
//   - finish_goal(evidence, conclusion) → loop.submitGoal：内部跑审查子 agent
//       · 通过  → 复刻 say 的判停路径（loop 置 goalStatus='achieved'，finalize 消费）
//       · 不通过 → 抛错（is_error）把审查理由带回给主 agent，继续干活
//
// ⚠️ 与既有 say 的关键区别：say 调用即结束回合；finish_goal 只是**提交**，过不过由审查官说了算。
// ============================================================

import type { Tool } from '../interface.js';

/** enter_goal 结果：ok=false 时带原因，工具转为抛错以获得 is_error 语义 */
export type EnterGoalResult = { ok: true; note: string } | { ok: false; error: string };
/** 进入函数（loop.enterGoal 注入） */
export type EnterGoalFn = (objective: string, by: 'user' | 'agent') => EnterGoalResult;

/** finish_goal 审查结果：ok=false 时带审查不通过的理由 */
export type GoalReviewOutcome = { ok: true } | { ok: false; error: string };
/** 提交函数（loop.submitGoal 注入；内部含审查子 agent 调用） */
export type SubmitGoalFn = (evidence: string, conclusion: string) => Promise<GoalReviewOutcome>;

/** enter_goal —— agent 应用户要求进入 goal 模式（用户侧入口是 /goal 命令） */
export function createEnterGoalTool(enter: EnterGoalFn): Tool {
  return {
    name: 'enter_goal',
    description:
      '进入 goal 模式：在目标达成前**不会结束回合**，唯一出口是 finish_goal（提交证据与结论，由审查子 agent 验收）。' +
      '当用户明确要求「不达目标不罢休 / 做完这个再停」时调用。' +
      'objective 必须是用户想要的那个目标原文，不要自己改写或放宽。' +
      '进入后：say 等「宣布完成/换环境」类工具被禁用；不要用它来逃避正常收尾。',
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '目标原文（用户想要的结果）。写具体、可验收；它就是审查官判「达成没有」的标尺。',
        },
      },
      required: ['objective'],
    },
    // 只改内部状态、不触外部副作用 → 自动放行
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const objective = typeof args.objective === 'string' ? args.objective : '';
      const result = enter(objective, 'agent');
      if (!result.ok) throw new Error(result.error);
      return result.note;
    },
  };
}

/** finish_goal —— 提交证据与结论；通过则退出 goal 模式并交付结论，不通过则被打回继续 */
export function createFinishGoalTool(submit: SubmitGoalFn): Tool {
  return {
    name: 'finish_goal',
    description:
      '提交目标验收：交出 evidence（**可核验**的证据 —— 命令+输出 / 文件路径 / 测试结果）与 conclusion（结论）。' +
      '背后有审查子 agent 判**目标是否已经达成**：通过 → 本回合结束并把结论交付用户；' +
      '不通过 → 退回理由，你必须继续工作、补齐证据或修正结论后再次提交。' +
      '⚠️ **只在目标确实已达成时调用**。若目标是「未达成 / 部分达成 / 探明了某点 / 得到负面结果」，' +
      '**不要调用它**（诚实但未达成的报告也会被打回），继续工作。证据要能被复核，不要空口断言。' +
      '若审查服务不可用：goal 会被**退出**并明确返回「未审查」—— 不会假装通过；那时用 say 如实交付。',
    inputSchema: {
      type: 'object',
      properties: {
        evidence: {
          type: 'string',
          description: '可核验的证据：实际跑过的命令及其输出、改动的文件路径、测试/编译结果等。审查官可能据此自行复核。',
        },
        conclusion: {
          type: 'string',
          description: '结论：目标已如何达成。面向用户，写清楚结果本身。',
        },
      },
      required: ['evidence', 'conclusion'],
    },
    // 通过后会触发交付（等价 say），不应触发权限审批
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const evidence = typeof args.evidence === 'string' ? args.evidence : '';
      const conclusion = typeof args.conclusion === 'string' ? args.conclusion : '';
      const result = await submit(evidence, conclusion);
      if (!result.ok) {
        // 抛错 → is_error tool_result → toolCalled=true → loop 自动续轮（打回继续）
        throw new Error(result.error);
      }
      return 'ok';
    },
  };
}

/** exit_goal 结果函数（loop.exitGoal 注入；返回是否确有解除动作） */
export type ExitGoalFn = () => boolean;

/**
 * exit_goal —— **用户止损的逃生舱**。
 *
 * 为什么必须有它：goal 模式把默认出口（end_turn）废了，只留 finish_goal 一条；
 * 若用户中途想放弃，就再没有出口 ⇒ 必须留一个「用户能主动解」的口子。
 * TUI 的 `/goal off` 走消息注入，落点就是它。
 *
 * 为什么在 GOAL_FORCED_VISIBLE_TOOLS 里（goal 生效时**强制可见**）：
 * 否则它若不在激活包内就不可见 ⇒ `/goal off` 静默失效（又一种「进得去、出不来」）。
 *
 * ⚠️ 已知松弛点：它是个真实工具，模型**理论上能自行调用**来绕过验收。
 * 当前唯一约束是工具描述里写死的「仅用户明确要求时调用」。若要更硬，可在 loop 侧
 * 加校验（例如只允许紧跟在用户消息之后的那一轮调用）。
 */
export function createExitGoalTool(exit: ExitGoalFn): Tool {
  return {
    name: 'exit_goal',
    description:
      '解除 goal 模式（逃生舱）。**仅在用户明确要求停止 / 放弃目标时调用**；' +
      '不要为了结束回合而自行调用它 —— 那等于绕过目标验收。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    sideEffect: 'read',
    async execute(): Promise<string> {
      return exit() ? '已解除 goal 模式（用户要求）✓' : '当前不在 goal 模式下。';
    },
  };
}
