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
 *
 * ⚠️ 2026-11-06 定调（孑遗）：**交付是否等于结束，取决于模式**。
 *    · 普通模式：deliver = 收工，回合结束（本工具照旧）。
 *    · 自主模式：deliver **不结束回合** —— 内容照常送出，但回合继续，
 *      要停必须显式 `suspend`。
 *    实现方式不在这里，而在 `exit-policy.ts` 的白名单：`createEndTurnBlockPolicy`
 *    只在自主模式下被挂上，且 'say_submitted' **不在**它的放行名单里 ⇒
 *    自主模式自动拦住 deliver 的判停，普通模式压根没有这个策略、行为完全不变。
 *    所以本工具**不需要**加 until 参数：交付不再结束，"下次何时再来"仍归 suspend 管。
 */
export function createDeliverTool(submit: DeliverSubmitFn): Tool {
  return {
    name: 'deliver',
    description:
      '把成果交付给用户：长篇说明、报告、分析、表格、清单、代码块 —— ' +
      '需要结构化排版、需要被反复阅读的内容。只出文字、不朗读（要说话用 say）。' +
      'content 用 Markdown 写全，不二次加工、不截断。' +
      '⚠️ 它**是否结束回合取决于模式**（2026-11-06 定调）：' +
      '· 普通模式：交付 = 任务完成 + 汇报到 UI + 结束 loop。' +
      '· 自主模式：交付只是「**格式化输出通道**」—— 把结果整理清楚显示在 UI 上，' +
      '  免得和 loop 的过程输出混在一起。自主模式的 loop **永不结束**，' +
      '  所以不存在"真的完成任务"；交付后回合继续，要停必须用 suspend 登记下次条件。',
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
