// ============================================================
// deliver — 交付工具：把长篇 / 结构化内容交给用户，并结束本回合
// ============================================================
// 与 say 的分工（2026-10-25 孑遗定调）：
//   · say    = 「嘴」：短、有语气、会朗读，**不结束回合**（说完还能继续干活）
//   · deliver = 「交付」：Markdown 长文 / 表格 / 清单 / 代码，**不朗读**，交付完即收工
// 两者共用 loop 侧的落盘 + 屏显通道（都在 tool_result 之后落），区别只在：
//   ① 是否置回合结束标志（deliver 置，say 不置）；
//   ② 是否触发语音播报（say 触发，deliver 不触发 —— 长文念出来没人听）。
//
// 与 ask_user / say 同构：提交函数由 loop 实例注入，工具自身零业务依赖、便于测试替换。
// ============================================================

import type { Tool } from './interface.js';

/** 提交结果：ok=false 时带原因，工具转为抛错以获得 is_error 语义 */
export type DeliverSubmitResult = { ok: true } | { ok: false; error: string };

/** 提交函数（loop.submitDeliver 注入） */
export type DeliverSubmitFn = (
  content: string,
  title?: string,
) => Promise<DeliverSubmitResult> | DeliverSubmitResult;

/**
 * 创建 deliver 工具。
 *
 * 为什么交付物不写文件：现阶段「交付」= 交给用户看的内容，落点就是对话消息 +
 * 屏显（与 say 同一条通道，只是不朗读）。若将来需要「产出为文件」，那是
 * write / 生成类工具的职责，不该混进交付语义 —— 交付工具只管「说到」，
 * 不管「存到」。
 */
export function createDeliverTool(submit: DeliverSubmitFn): Tool {
  return {
    name: 'deliver',
    description:
      '把**交付物**交给用户：长篇说明、报告、分析、表格、清单、代码块 —— 需要结构化排版、需要被反复阅读的内容走这里。' +
      '与 say 的分工：say 是你的「嘴」（短句、有语气、会朗读、说完还能继续干活）；' +
      'deliver 是你的「交付」（完整、可存档、只出文字不朗读、调用后本回合结束）。' +
      'content 用 Markdown 写全 —— 工具不会二次加工、不会截断、也不会朗读它；' +
      '不要用它说「我这就去查」这类过程话，那是 say 的活。' +
      '调用后本回合立即结束，所以只在**活儿干完、东西要交给用户**时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '交付正文（Markdown）。完整写，会被原样渲染给用户；不朗读、不截断。',
        },
        title: {
          type: 'string',
          description: '可选标题（一句话概括这次交付的内容），用于消息列表与折叠展示。',
        },
      },
      required: ['content'],
    },
    // 只读语义：不改外部状态（落盘由 loop 侧统一做），自动放行
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const content = typeof args.content === 'string' ? args.content : '';
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
      const result = await submit(content, title);
      if (!result.ok) {
        // 抛错 → 框架落 is_error tool_result → loop 自动续轮让模型重写
        throw new Error(result.error);
      }
      return title ? `ok（已交付：${title}）` : 'ok';
    },
  };
}
