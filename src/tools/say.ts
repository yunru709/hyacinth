// ============================================================
// say — 交付结论工具：把最终结论交给用户（文字 + 语音），并结束当前回合
// ============================================================
// （原名 report，2026-09-18 改名 say「说」；2026-10-24 接入语音播报）
// 与 ask_user 同构：提交函数由 loop 实例注入，工具自身零业务依赖、便于测试替换。
//
// 设计要点：
//   1. 调用成功 = 本回合结束信号。finalize 判定必须排在 toolCalled 之前
//      —— say 本身也是一次工具调用，否则永远被 toolCalled 挡下、停不下来。
//   2. 内容由 loop.submitSay 落成 assistant 文本 + 屏显（不只是工具形态）：
//      - 上下文/压缩层：Phase 4 规则裁剪只动 tool 消息，assistant 文本不受影响
//      - 摘要层：自然语言比 [ToolUse] JSON 形态更不易被略写
//      - 历史尾部：避免以 user(tool_result) 结尾导致连续 user 消息
//   3. 校验失败 → 工具抛错 → tool_result is_error → loop 自动续轮让模型重写
//      （连续失败上限由 loop 侧计数兜底）
//   4. 语音参数（2026-10-24 say-voice 插件）：voice/speed/emotion 透传给
//      loop.sayVoice 钩子（未装配 = 无语音能力，参数安全忽略）；
//      broadcast:false = 本次只交付文字不朗读。引擎能力各异（有些 TTS
//      可调音色/语速/情感，有些不能），不支持的字段由引擎侧忽略。
// ============================================================

import type { Tool } from './interface.js';

/** say 的语音选项：全部可选、逐字段容错（引擎不支持的项忽略） */
export interface SayVoiceOptions {
  /** 音色 id（引擎音色目录内；缺省 = 用户设置的默认音色） */
  voice?: string;
  /** 语速倍率（0.5 ~ 2，1 = 常速；引擎不支持时忽略） */
  speed?: number;
  /** 情感/语气标签（如 warm/excited；引擎不支持时忽略） */
  emotion?: string;
  /** false = 本次只交付文字、不朗读（默认跟随用户设置的语音播报开关） */
  broadcast?: boolean;
}

/** 提交结果：ok=false 时带原因，工具转为抛错以获得 is_error 语义 */
export type SaySubmitResult = { ok: true } | { ok: false; error: string };

/** 提交函数（loop.submitSay 注入） */
export type SaySubmitFn = (
  content: string,
  voice?: SayVoiceOptions,
) => Promise<SaySubmitResult> | SaySubmitResult;

/** 从工具入参里解析语音选项：逐字段容错，坏值静默丢弃（content 才是关键交付物） */
export function parseSayVoiceOptions(args: Record<string, unknown>): SayVoiceOptions {
  const opts: SayVoiceOptions = {};
  if (typeof args.voice === 'string' && args.voice.trim()) opts.voice = args.voice.trim();
  if (typeof args.speed === 'number' && Number.isFinite(args.speed)) {
    // 语速收敛到 [0.5, 2]：超出视为模型笔误，夹回边界而非报错打断交付
    opts.speed = Math.min(2, Math.max(0.5, args.speed));
  }
  if (typeof args.emotion === 'string' && args.emotion.trim()) opts.emotion = args.emotion.trim();
  if (args.broadcast === false) opts.broadcast = false;
  return opts;
}

/**
 * 语音侧状态提示器（装配层注入；返回文案或 null）。
 * 交付本身永远成功（ok），但「用户开了播报而语音不可用」时，tool_result
 * 里带明示（服务未启用/模型未就绪）—— 模型与历史可见，不触发续轮重试。
 */
export type SayVoiceNoticeFn = (opts: SayVoiceOptions) => string | null;

/**
 * 创建 say 工具。submit 由 AgentLoop 提供（按实例注入，非全局单例）；
 * voiceNotice 可选（装配层按 TTS 状态注入）。
 */
export function createSayTool(submit: SaySubmitFn, voiceNotice?: SayVoiceNoticeFn): Tool {
  return {
    name: 'say',
    description:
      '你通过这个工具对用户说话 —— 它就是你的嘴，说出的话会同时以文字和语音交付。' +
      '**它是「说话」，不是「交付」**：像面对面讲话那样，短、直接、有语气，一两句到一两段；' +
      '长篇报告 / 结构化文档 / 大段表格与清单 —— 那些走 `deliver`，不要塞进 content。' +
      '**调用后不结束回合**：说完可以继续调用别的工具接着干活；' +
      '所以不必在这里「总结一切」，也不要把过程、推理、待办清单念出来。' +
      '语音侧参数（可选，取决于本地语音引擎能力，不支持的项会被忽略）：' +
      'voice=音色 id、speed=语速 0.5~2、emotion=语气（如 warm）；' +
      'broadcast=false 表示这次只出文字、不要朗读（比如用户正在开会）。' +
      '另外：语音只念得动「话」—— Markdown 结构（表格、代码块、清单）会被压平或略过，超过 800 字的部分不朗读。',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '交付给用户的结论正文（支持 Markdown），会以文字和语音两种形式交付。写结论本身，不要写过渡语。',
        },
        voice: {
          type: 'string',
          description: '音色 id（可选）。可用音色由本地语音引擎决定，留空用默认音色；不支持的引擎会忽略。',
        },
        speed: {
          type: 'number',
          description: '语速倍率（可选，0.5~2，1=常速）。引擎不支持时忽略。',
        },
        emotion: {
          type: 'string',
          description: '语气/情感标签（可选，如 warm、excited）。引擎不支持时忽略。',
        },
        broadcast: {
          type: 'boolean',
          description: '是否朗读本次内容（可选，默认跟随用户的语音播报设置）。传 false = 只交付文字。',
        },
      },
      required: ['content'],
    },
    // 只读语义：不改外部状态，自动放行（交付结论不应触发权限审批）
    sideEffect: 'read',
    async execute(args: Record<string, unknown>): Promise<string> {
      const content = typeof args.content === 'string' ? args.content : '';
      const result = await submit(content, parseSayVoiceOptions(args));
      if (!result.ok) {
        // 抛错 → 框架落 is_error tool_result → toolCalled=true → loop 自动续轮重试
        throw new Error(result.error);
      }
      // 最小返回值：Tool.execute 必须返回 string，且 tool_result 不可缺失
      // （缺失会被严格厂商判为孤儿 tool_use、整请求拒绝），所以只能精简不能删。
      // 语音侧不可用（用户开了播报但服务/模型没就绪）时附带明示 —— 交付不受影响。
      const notice = voiceNotice?.(parseSayVoiceOptions(args)) ?? null;
      return notice ? `ok（语音播报：${notice}）` : 'ok';
    },
  };
}
