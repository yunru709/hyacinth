import type { Tool } from '../tools/interface.js';

/**
 * ReportTool —— 子 Agent 专用的「汇报工具」。
 *
 * 为什么需要（2026-11-01 改造）：
 *   此前子 Agent 的"结果" = 会话最后一条 assistant 文本（delegate-tool.collectAgentResult）。
 *   这个约定太弱 —— 子 Agent 跑到最后若消息是被注入的 scratchpad / 中间态 / 没说完的话，
 *   都会被当结果返回给主 Agent（实测 sub_003 把 scratchpad 当结果返回）。
 *   现在改为：子 Agent 必须显式调用 report 提交结构化结果；主 Agent 只认**最后一次 report 的入参**，
 *   没调 report = "未交付"（collectAgentResult 降级取末条消息并标记 unstructured，不再静默当成功）。
 *
 * 注意：本工具不受 agentDef.allowedTools 白名单约束 —— 它由 FilteredToolRegistry 的 systemTools
 * 豁免通道注入，否则子 Agent 白名单里没有 'report' 就永远调不到它。
 */
export class ReportTool implements Tool {
  readonly name = 'report';
  readonly description =
    '【子 Agent 专用·任务结束前必须调用一次】把本次任务的最终结果上报给派你来的主 Agent。' +
    '主 Agent 只认这里上报的内容（不看你普通回答里写的文字）。status：done=完成 / blocked=受阻需人工 / failed=失败；' +
    'summary 要清晰完整；artifacts 列产物（如文件路径）；data 放结构化数据（可选）。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['done', 'blocked', 'failed'],
        description: '结果状态：done=完成 / blocked=受阻需人工 / failed=失败',
      },
      summary: { type: 'string', description: '结果摘要（面向主 Agent，清晰完整）' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '产物清单（文件路径等），可选' },
      data: { type: 'object', description: '结构化数据，可选（给主 Agent 机读）' },
    },
    required: ['status', 'summary'],
  };
  // 纯上报：不改任何外部状态，只让主 Agent 取参数
  readonly sideEffect = 'read' as const;

  async execute(): Promise<string> {
    return 'Result reported to parent agent. You may now finish.';
  }
}
