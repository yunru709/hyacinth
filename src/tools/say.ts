// ============================================================
// say — 交付结论工具：把最终结论交给用户，并结束当前回合
// ============================================================
// （原名 report，2026-09-18 按用户要求改名为 say「说」）
// 与 ask_user 同构：提交函数由 loop 实例注入，工具自身零业务依赖、便于测试替换。
//
// 设计要点（2026-09-18 讨论定稿）：
//   1. 调用成功 = 本回合结束信号。finalize 判定必须排在 toolCalled 之前
//      —— say 本身也是一次工具调用，否则永远被 toolCalled 挡下、停不下来。
//   2. 内容由 loop.submitSay 落成 assistant 文本 + 屏显（不只是工具形态）：
//      - 上下文/压缩层：Phase 4 规则裁剪只动 tool 消息，assistant 文本不受影响
//      - 摘要层：自然语言比 [ToolUse] JSON 形态更不易被略写
//      - 历史尾部：避免以 user(tool_result) 结尾导致连续 user 消息
//   3. 校验失败 → 工具抛错 → tool_result is_error → loop 自动续轮让模型重写
//      （连续失败上限由 loop 侧计数兜底：say 失败时 toolCalled 仍为 true，
//       会重置 idleTurnCount，空转兜底失效，只能靠 maxTurns —— 故需独立计数）
//   4. 不带 tone / speech 等 TTS 字段：接语音通道时再加（预留扩展位）
// ============================================================

import type { Tool } from './interface.js';

/** 提交结果：ok=false 时带原因，工具转为抛错以获得 is_error 语义 */
export type SaySubmitResult = { ok: true } | { ok: false; error: string };

/** 提交函数（loop.submitSay 注入） */
export type SaySubmitFn = (content: string) => Promise<SaySubmitResult> | SaySubmitResult;

/**
 * 创建 say 工具。submit 由 AgentLoop 提供（按实例注入，非全局单例）。
 */
export function createSayTool(submit: SaySubmitFn): Tool {
  return {
    name: 'say',
    description:
      '你是通过这个工具对用户说话的 —— 它就是你的嘴。' +
      '要交付给用户的内容（结论、汇报、说明）都写进 content；' +
      '不通过它说的话，不会被视为你对用户的正式回复。' +
      '调用后本回合立即结束，因此：' +
      '① 只在"结论已经想清楚、要交给用户"时调用；' +
      '② 任务还需继续（还要调用其它工具）时不要调用，否则回合会被提前结束；' +
      '③ content 写完整、面向用户的最终表达（支持 Markdown）；' +
      '不要写"我将要汇报"之类的过渡语，也不要把推理过程写进去 —— 那是你自己的思考，不是要说给用户的话。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '交付给用户的结论正文（支持 Markdown）。写结论本身，不要写过渡语。',
        },
      },
      required: ['content'],
    },
    // 只读语义：不改外部状态，自动放行（交付结论不应触发权限审批）
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const content = typeof args.content === 'string' ? args.content : '';
      const result = await submit(content);
      if (!result.ok) {
        // 抛错 → 框架落 is_error tool_result → toolCalled=true → loop 自动续轮重试
        throw new Error(result.error);
      }
      return '已交付：结论已说给用户，本回合到此结束。';
    },
  };
}
