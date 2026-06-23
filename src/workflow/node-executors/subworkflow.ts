/**
 * Subworkflow Node Executor — 子工作流节点执行器
 *
 * 支持两种模式：
 *   - inline 模式：node.data.subgraph 包含内嵌子图，递归调用 compileGraphWorkflow
 *     编译并执行子图，返回累积的提示词作为 output。
 *   - reference 模式：node.data.subworkflowRef 引用外部工作流名。
 *     由于执行器上下文无法访问 WorkflowRegistry，此处仅返回提示词，
 *     实际执行由上层（graph-engine / WorkflowManager）处理。
 *
 * 返回：{ prompt: '进入子工作流: {label}', output: subgraphResult }
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';
import type { WorkflowGraph } from '../graph-types.js';
import { compileGraphWorkflow } from '../graph-engine.js';
import { defaultNodeExecutorRegistry } from './registry.js';

/** 执行内嵌子图，返回累积的提示词和最终输出 */
function executeInlineSubgraph(
  subgraph: WorkflowGraph,
  ctx: NodeExecutionContext,
): { prompt: string; output: unknown } {
  // 编译子图为 WorkflowDefinition
  const subDef = compileGraphWorkflow(subgraph, 'converted', defaultNodeExecutorRegistry);

  // 创建初始状态（createState 会运行初始执行循环到第一个等待节点或完成）
  const subState = subDef.createState(ctx.params);

  const subData = subState.data as {
    prompts?: string[];
    outputs?: Record<string, unknown>;
    completed?: boolean;
    currentNodeId?: string;
  };

  // 收集子图累积的提示词
  const subPrompts = subData.prompts ?? [];
  const subOutputs = subData.outputs ?? {};
  const completed = subData.completed ?? false;

  // 子图输出：优先取最后一个节点的 output，否则取全部 outputs
  const outputValues = Object.values(subOutputs);
  const lastOutput = outputValues.length > 0
    ? outputValues[outputValues.length - 1]
    : undefined;

  const statusHint = completed ? '(已完成)' : '(暂停 — 等待响应)';
  const prompt = subPrompts.length > 0
    ? subPrompts.join('\n')
    : `子工作流${statusHint}`;

  return {
    prompt,
    output: {
      completed,
      outputs: subOutputs,
      lastOutput,
      prompts: subPrompts,
    },
  };
}

export const subworkflowNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const label = ctx.node.data.label ?? '子工作流';
    const subgraph = ctx.node.data.subgraph;
    const subworkflowRef = ctx.node.data.subworkflowRef;

    // inline 模式：有内嵌子图
    if (subgraph) {
      try {
        const result = executeInlineSubgraph(subgraph, ctx);
        return {
          prompt: `进入子工作流: ${label}\n${result.prompt}`,
          output: result.output,
        };
      } catch (err) {
        return {
          prompt: `进入子工作流: ${label}（执行失败: ${(err as Error).message}）`,
          output: { error: (err as Error).message },
        };
      }
    }

    // reference 模式：引用外部工作流名
    if (subworkflowRef) {
      return {
        prompt: `进入子工作流: ${label}（引用: ${subworkflowRef}）\n注意：reference 模式需要在 WorkflowManager 层处理实际执行。`,
        output: { subworkflowRef, pending: true },
      };
    }

    // 既无 subgraph 也无 subworkflowRef
    return {
      prompt: `进入子工作流: ${label}（未配置子图或引用）`,
      output: undefined,
    };
  },
};
