/**
 * Agent Node Executor — Agent 节点执行器
 *
 * 生成提示词要求 LLM 执行任务，并标记 waitForResponse 以暂停执行
 * 等待模型响应。
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

export const agentNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const label = ctx.node.data.label ?? '未命名任务';
    const description = ctx.node.data.description;
    const config = ctx.node.data.config ?? {};

    // 优先使用 config.instruction，其次 description，最后 label
    const instruction = (config.instruction as string) ?? description ?? label;

    const prompt = `请执行以下任务：${instruction}`;
    return { prompt, waitForResponse: true };
  },
};
