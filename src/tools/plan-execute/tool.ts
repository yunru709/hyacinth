/**
 * plan-execute/tool.ts —— 预测式批量执行工具（plan_execute）。
 *
 * 工具语义：接收一个带断言的计划（Plan JSON），机械执行全部步骤。
 *  - 每步：跑命令组（多工具场景）→ 结构化断言校验；
 *  - 预测命中 → 自动推进（零 LLM 成本）；
 *  - 预测落空 → 返回结构化失败报告（onMiss: handoff）→ 由主循环/LLM 接管。
 *
 * 粒度控制：commands 数量/串并行由规划者（LLM 或用户）自定 —— 通过本工具
 * 的 description 引导"每步预测必须可验收"即可控制粒度（无需硬性规则）。
 */
import type { Tool } from '../interface.js';
import type { ToolExecutor } from '../executor.js';
import { executePlan, type RunCommand } from './executor.js';
import type { Plan } from './types.js';

let planExecuteSeq = 0;

/** 创建 plan_execute 工具（注入 ToolExecutor 以执行子命令；onHandoff 供循环级验证门消费） */
export function createPlanExecuteTool(
  executor: ToolExecutor,
  opts?: { onHandoff?: (reason: string) => void },
): Tool {
  const run: RunCommand = async (call) => {
    const result = await executor.execute({ id: `plan-execute-${++planExecuteSeq}`, name: call.tool, input: call.input });
    return { tool: call.tool, content: result.content, is_error: result.is_error ?? false };
  };

  return {
    name: 'plan_execute',
    description:
      '预测式批量执行：接收一个「命令组 + 结构化预测断言」的计划，机械执行全部步骤，' +
      '执行阶段不调用 LLM。每步 = commands（一组工具调用，可多工具） + prediction（对整个命令组的验收断言）。' +
      '预测命中自动推进下一步；某步预测落空则返回失败报告交回主流程。' +
      '规划约束：每步的 prediction 必须是可自动验收的结构化断言（success / outputContains / outputMatches / ' +
      'stdoutEmpty / fileExists / fileContains / jsonField，可 all/any/not 组合）——' +
      '不可验收的预测无法作为门控。粒度（一步几条命令、串行/并行）由你规划时自定：' +
      '预测好写的步骤可归并，预测难写的步骤应拆细。',
    inputSchema: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['commands', 'prediction'],
            properties: {
              commands: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['tool', 'input'],
                  properties: {
                    tool: { type: 'string', description: '系统内工具名（bash/read/write/grep…）' },
                    input: { type: 'object', description: '该工具的参数' },
                  },
                },
              },
              prediction: { $ref: '#/definitions/prediction', description: '对整个命令组的验收断言' },
              parallel: { type: 'boolean', description: '组内命令并行（默认串行）' },
              timeoutMs: { type: 'number', description: '本步整体超时（毫秒）' },
            },
          },
        },
      },
      definitions: {
        prediction: {
          oneOf: [
            { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
            { type: 'object', properties: { outputContains: { type: 'string' } }, required: ['outputContains'] },
            { type: 'object', properties: { outputMatches: { type: 'string' } }, required: ['outputMatches'] },
            { type: 'object', properties: { stdoutEmpty: { type: 'boolean' } }, required: ['stdoutEmpty'] },
            { type: 'object', properties: { fileExists: { type: 'string' } }, required: ['fileExists'] },
            {
              type: 'object',
              properties: {
                fileContains: {
                  type: 'object', required: ['path', 'pattern'],
                  properties: { path: { type: 'string' }, pattern: { type: 'string' } },
                },
              },
              required: ['fileContains'],
            },
            {
              type: 'object',
              properties: {
                jsonField: {
                  type: 'object', required: ['field'],
                  properties: { field: { type: 'string' }, equals: {}, exists: { type: 'boolean' }, contains: { type: 'string' } },
                },
              },
              required: ['jsonField'],
            },
            { type: 'object', properties: { all: { type: 'array', items: { $ref: '#/definitions/prediction' } } }, required: ['all'] },
            { type: 'object', properties: { any: { type: 'array', items: { $ref: '#/definitions/prediction' } } }, required: ['any'] },
            { type: 'object', properties: { not: { $ref: '#/definitions/prediction' } }, required: ['not'] },
          ],
        },
      },
    },

    async execute(args: Record<string, unknown>): Promise<string> {
      const plan = args as unknown as Plan;
      if (!Array.isArray(plan?.steps) || plan.steps.length === 0) {
        return JSON.stringify({ ok: false, error: 'plan.steps 必须是非空数组' });
      }
      const result = await executePlan(plan, run);
      if (result.status === 'done') {
        return JSON.stringify({
          ok: true,
          status: 'done',
          steps: result.steps.map((s) => ({
            stepIndex: s.stepIndex,
            commands: s.commands.map((c) => c.tool),
            satisfied: true,
          })),
        });
      }
      const json = JSON.stringify({
        ok: false,
        status: 'handoff',
        stepIndex: result.stepIndex,
        failedCommands: result.failedStep.commands.map((c) => c.tool),
        prediction: result.prediction,
        actual: result.actual.map((r) => ({ tool: r.tool, content: r.content.slice(0, 2000), is_error: r.is_error })),
        reason: result.reason,
        completedSteps: result.completed.length,
        hint: '预测落空，已交回主流程 —— 请分析 actual 与 prediction 的差异后重新决策（修正当前步或重规划）。',
      });
      // 通知循环级验证门（repair.verification）：预测落空，模型不应在未修复时直接结束
      opts?.onHandoff?.(result.reason);
      return json;
    },
  };
}
