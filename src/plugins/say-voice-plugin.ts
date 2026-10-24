/**
 * say-voice 插件 —— say 交付的语音播报 + TTS 引擎成套插件化（2026-10-24）。
 *
 * 一整套语音交付能力从这个插件出发：
 *   - 引擎面（SayVoiceEngine）：音色目录 + 合成，当前实现 = 本地 CosyVoice3
 *     （src/tts/cosyvoice.ts）。引擎可替换 —— 换 TTS 只需提供新引擎实现，
 *     say 工具 schema 不变（不支持的字段由引擎忽略）。
 *   - 播报面（SayVoiceBroadcast）：loop.sayVoice 钩子的实现方。串行队列
 *     （忙时只留最新一句，同 CompanionVoiceService 语义）、失败静默降级为
 *     一条 error 事件，绝不阻塞回合收尾。
 *   - UI 面（uiCards）：向 webui 声明本插件贡献的设置卡（渲染器 kind +
 *     挂载槽位）——「UI 的变更依靠插件」的最小闭环：卡片出现/消失由插件
 *     挂载状态决定，渲染器本体留在 webui（插件不注入任意 HTML）。
 *
 * 与 generation 插件（modeVoice）的关系：两个语音面各管一段 ——
 * modeVoice 管陪伴模式台词（companion_say），sayVoice 管 say 工具交付。
 */
import type { HyPlugin, PluginContext, PluginUiCard } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { SayVoiceOptions } from '../tools/say.js';
import { UI_EVENT, type SayVoiceEvent } from '../events.js';
import { getTtsService, listVoices, type TtsVoiceInfo } from '../tts/cosyvoice.js';

// UI 卡片契约住在内核原语（plugin-host），此处 re-export 方便插件开发者
export type { PluginUiCard } from '../kernel/plugin-host.js';

export const SAY_VOICE_PLUGIN_ID = 'say-voice';
export const SAY_VOICE_API_KEY = 'say-voice.api';

/** 单次朗读正文上限（字符）：超长报告截断播报，余下看文字 —— 避免数分钟级合成 */
const SPEECH_MAX_CHARS = 800;

// ── 引擎契约（可替换面）─────────────────────────────────────────

/** say 语音引擎：音色目录 + 合成。不支持的参数由实现忽略（能力自描述） */
export interface SayVoiceEngine {
  /** 引擎 id（诊断/UI 展示） */
  id: string;
  /** 可用音色目录（LLM 的 voice 参数取值域 + 设置页下拉数据源） */
  voices(): TtsVoiceInfo[];
  /** 合成 → WAV Buffer。voice 不在目录内时实现可回退默认并注明 */
  synthesize(text: string, opts: { voice?: string; speed?: number; emotion?: string }): Promise<Buffer>;
}

/** 本插件对外服务句柄（宿主注册 'say-voice.api'） */
export interface SayVoiceApi {
  engine: SayVoiceEngine;
  /** 用户总开关 voice.say.broadcast（默认 false：模型就绪后由用户打开） */
  broadcastEnabled(): boolean;
  /** 默认音色 voice.say.voice */
  defaultVoice(): string;
}

// ── Markdown → 朗读文本（纯函数）────────────────────────────────

/**
 * say 的 content 是 Markdown；直接朗读会念出 "#、**、```" 等记号。
 * 转成适合口播的纯文本：代码块/图片略过（口播念不了），链接取文字，
 * 列表/标题记号剥除，空白折叠。
 */
export function speechTextFromMarkdown(md: string): string {
  let s = md;
  // 代码块 → 占位（fence 与缩进块两种形态；多行合并为一句话）
  s = s.replace(/```[\s\S]*?```/g, '（代码略）');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片 → 占位；链接 → 取文字
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '（图片）');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 表格：分隔行整行丢弃，其余单元格竖线换空格
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  s = s.replace(/\|/g, ' ');
  // 标题/引用/列表记号（行首）：# > - * • 数字. 数字)
  s = s.replace(/^\s{0,3}(#{1,6}|>|[-*•]|\d{1,2}[.)])\s+/gm, '');
  // 强调记号
  s = s.replace(/(\*\*|__|\*|_|~~)/g, '');
  // 水平线 → 句读
  s = s.replace(/^\s*([-*_]\s*){3,}$/gm, '。');
  // 空白折叠（换行 → 空格；连续空白合一）
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
  s = s.trim();
  // 超长截断：口播有成本上限，余下交给文字交付
  if (s.length > SPEECH_MAX_CHARS) s = s.slice(0, SPEECH_MAX_CHARS) + '……内容较长，余下部分见文字。';
  return s;
}

// ── 播报队列（串行；忙时只留最新）────────────────────────────────

type NotifyFn = (type: string, payload?: unknown) => void;

class SayVoiceBroadcast {
  private busy = false;
  private queued: { text: string; opts: SayVoiceOptions; notify: NotifyFn } | null = null;

  constructor(
    private readonly deps: {
      engine: SayVoiceEngine;
      getConfig: <T>(key: string) => T | undefined;
      logger: { warn(msg: string, ctx?: unknown): void; info?(msg: string): void };
    },
  ) {}

  /** loop.sayVoice 钩子入口（fire-and-forget：调用方不 await） */
  onSayDelivered(text: string, opts: SayVoiceOptions, notify: NotifyFn): void {
    const flag = this.deps.getConfig<boolean>('voice.say.broadcast');
    this.deps.logger.info?.(`[debug-sayvoice] gate: opts.broadcast=${opts.broadcast} cfg=${flag} busy=${this.busy}`);
    if (opts.broadcast === false) return;                        // 本次明确不朗读
    if (flag !== true) return; // 用户总开关
    if (this.busy) {
      this.queued = { text, opts, notify };                      // 忙时只留最新一句
      return;
    }
    this.busy = true;
    void this.drain(text, opts, notify);
  }

  private async drain(text: string, opts: SayVoiceOptions, notify: NotifyFn): Promise<void> {
    for (;;) {
      await this.speakOnce(text, opts, notify);
      const next = this.queued;
      this.queued = null;
      if (!next) break;
      ({ text, opts, notify } = next);
    }
    this.busy = false;
  }

  private async speakOnce(text: string, opts: SayVoiceOptions, notify: NotifyFn): Promise<void> {
    this.deps.logger.info?.(`[debug-sayvoice] speakOnce enter: ${text.slice(0, 20)}`);
    const speech = speechTextFromMarkdown(text);
    const voice = opts.voice || String(this.deps.getConfig<string>('voice.say.voice') ?? '') || undefined;
    try {
      const wav = await this.deps.engine.synthesize(speech, { voice, speed: opts.speed, emotion: opts.emotion });
      const payload: SayVoiceEvent = {
        state: 'ready',
        audioWavBase64: wav.toString('base64'),
        textPreview: speech.slice(0, 60),
        voice,
        speed: opts.speed,
      };
      notify(UI_EVENT.SAY_VOICE, payload);
    } catch (err) {
      // 失败不重试不升级：交付正文本身已完整到达（message.say），语音是增强
      this.deps.logger.warn('say-voice: broadcast failed', { error: err instanceof Error ? err.message : String(err) });
      notify(UI_EVENT.SAY_VOICE, {
        state: 'error',
        textPreview: speech.slice(0, 60),
        message: err instanceof Error ? err.message : String(err),
      } satisfies SayVoiceEvent);
    }
  }
}

// ── 引擎适配（CosyVoice3 本地引擎）───────────────────────────────

function createCosyVoiceEngine(): SayVoiceEngine {
  return {
    id: 'cosyvoice3',
    voices: () => listVoices(),
    synthesize: (text, opts) => getTtsService().synthesize(text, { voice: opts.voice, speed: opts.speed }),
  };
}

// ── 插件定义 ─────────────────────────────────────────────────────

export interface SayVoicePluginServices {
  configCenter?: RuntimeConfigCenter;
  /** 引擎覆盖（测试注入假引擎；缺省 = 本地 CosyVoice3） */
  engine?: SayVoiceEngine;
}

export function createSayVoicePlugin(
  services: SayVoicePluginServices = {},
): HyPlugin<Record<string, unknown>, LoopHooks> & { uiCards: PluginUiCard[] } {
  const { configCenter } = services;
  const getConfig = <T>(key: string): T | undefined => {
    try { return configCenter?.get<T>(key); } catch { return undefined; }
  };

  return {
    id: SAY_VOICE_PLUGIN_ID,

    /** UI 卡片贡献：设置页语音 tab 的两张卡（播报开关 + TTS 引擎管理） */
    uiCards: [
      { kind: 'say-voice-broadcast', slot: 'settings.voice', title: 'say 语音播报', icon: 'volume-2', order: 10 },
      { kind: 'say-voice-tts', slot: 'settings.voice', title: '语音合成（Fun-CosyVoice3）', icon: 'speech', order: 20 },
    ],

    async activate(ctx: PluginContext<Record<string, unknown>, LoopHooks>) {
      const engine = services.engine ?? createCosyVoiceEngine();
      const broadcast = new SayVoiceBroadcast({
        engine,
        getConfig,
        logger: {
          warn: (msg, e) => ctx.logger.warn(msg, { error: e instanceof Error ? e.message : String(e) }),
          // TODO(debug-sayvoice): 临时诊断，链路定位后移除
          info: (msg) => ctx.logger.info(msg),
        },
      });
      // loop.sayVoice 回填由装配批（plugin-contributions.ts）取 'say-voice.api' 完成，
      // 与 generation.api → loop.modeVoice 同一模式。
      ctx.register(SAY_VOICE_API_KEY, {
        engine,
        broadcastEnabled: () => getConfig<boolean>('voice.say.broadcast') === true,
        defaultVoice: () => String(getConfig<string>('voice.say.voice') ?? ''),
        onSayDelivered: (text: string, opts: SayVoiceOptions, notify: NotifyFn) =>
          broadcast.onSayDelivered(text, opts, notify),
      } satisfies SayVoiceApi & { onSayDelivered: (t: string, o: SayVoiceOptions, n: NotifyFn) => void });
      ctx.logger.info('say-voice plugin activated: say delivery broadcast ready');
    },
  };
}
