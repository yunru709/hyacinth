/**
 * Prompt Node Executor — 提示词模板节点执行器
 *
 * 从 node.data.config.template 取模板字符串，用 ctx.params 和 ctx.outputs
 * 做简单 {var} 替换，返回渲染后的提示词。
 *
 * 模板变量来源优先级：params > outputs
 * 例如：template = "请分析 {topic}，参考 {prevOutput}"
 *   params = { topic: "性能优化" }
 *   outputs = { "n1": "基准测试结果" }  (prevOutput 需通过 transform 映射)
 */
import type { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './types.js';

/** 简单 {var} 模板替换 */
function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (key in vars) {
      const val = vars[key];
      return val === null || val === undefined ? '' : String(val);
    }
    return match;
  });
}

export const promptNodeExecutor: NodeExecutor = {
  execute(ctx: NodeExecutionContext): NodeExecutionResult {
    const config = ctx.node.data.config ?? {};
    const template = (config.template as string) ?? ctx.node.data.label ?? '';

    // 合并 params 和 outputs 作为模板变量
    const vars: Record<string, unknown> = {
      ...ctx.params,
    };
    // outputs 是 Map<nodeId, value>，扁平化为 nodeId → value
    for (const [nodeId, value] of ctx.outputs) {
      vars[nodeId] = value;
    }

    const rendered = renderTemplate(template, vars);
    return { prompt: rendered };
  },
};
