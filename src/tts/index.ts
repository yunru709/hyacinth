/**
 * TTS 模块入口 — 按配置选引擎（进程级单例）。
 *
 * 【解耦点在这里】
 *   业务层（say 工具 / ui-protocol / 设置页）只认 `TtsEngine` 契约，
 *   具体用哪个引擎由 `voice.tts.engine` 决定。换引擎 = 改一行配置，
 *   不需要动插件、不需要动 say 工具、不需要重启改代码。
 *
 * 【配置键】
 *   voice.tts.engine              cosyvoice3（默认）| online
 *   voice.tts.online.provider     breeze | openai-compatible
 *   voice.tts.online.baseUrl      https://api.breeze.blue
 *   voice.tts.online.apiKey       密钥（也可用环境变量 BREEZE_API_KEY / TTS_API_KEY 兜底）
 *   voice.tts.online.model        breeze-tts-2 | breeze-tts-2-multilingual | tts-1
 *   voice.tts.online.voice        默认音色 id
 *   voice.tts.online.language     zh | en（breeze 的 language_code）
 *   voice.tts.online.format       wav_24000（breeze）| wav | mp3
 *   voice.tts.online.voices       [{id,label}] 音色目录（同步下拉用）
 *   voice.tts.online.headers      { "X-App-Id": "..." } 额外鉴权头
 *   voice.tts.online.timeoutMs    默认 120000
 *
 * 【为什么 apiKey 允许环境变量兜底】
 *   配置中心是纯文本 JSON，密钥不该明文落盘；先给环境变量这条免落盘路径，
 *   后续接入密钥库后由 settings 写入即可，读取顺序不变。
 */
import { createBreezeTts2Engine, type BreezeTts2Config } from './engines/breeze-tts2.js';
import { createCosyVoiceEngine } from './engines/cosyvoice.js';
import { createOnlineTtsEngine, type OnlineTtsConfig } from './engines/online.js';
import type { TtsEngine, TtsVoiceInfo } from './engine.js';

export type { TtsCapabilities, TtsEngine, TtsEngineStatus, TtsSynthesizeOptions, TtsVoiceInfo } from './engine.js';
export { createCosyVoiceEngine } from './engines/cosyvoice.js';
export { createOnlineTtsEngine, type OnlineTtsConfig } from './engines/online.js';

/** 每次现读配置 —— 设置页改完即时生效，不需要重启进程 */
export interface TtsConfigReader {
  get<T>(key: string): T | undefined;
}

const ONLINE_DEFAULTS = {
  provider: 'breeze' as const,
  baseUrl: 'https://api.breeze.blue',
  model: 'breeze-tts-2',
  language: 'zh',
  format: 'wav_24000',
};

/** 从配置中心 + 环境变量拼出在线引擎配置 */
function readOnlineConfig(cfg: TtsConfigReader): OnlineTtsConfig {
  const envKey =
    process.env.BREEZE_API_KEY ||
    process.env.TTS_API_KEY ||
    '';
  const provider = (cfg.get<string>('voice.tts.online.provider') || ONLINE_DEFAULTS.provider) as OnlineTtsConfig['provider'];
  return {
    provider,
    baseUrl: cfg.get<string>('voice.tts.online.baseUrl') || ONLINE_DEFAULTS.baseUrl,
    apiKey: cfg.get<string>('voice.tts.online.apiKey') || envKey,
    model: cfg.get<string>('voice.tts.online.model') || ONLINE_DEFAULTS.model,
    voice: cfg.get<string>('voice.tts.online.voice') || undefined,
    language: cfg.get<string>('voice.tts.online.language') || ONLINE_DEFAULTS.language,
    format: cfg.get<string>('voice.tts.online.format') || ONLINE_DEFAULTS.format,
    voices: cfg.get<TtsVoiceInfo[]>('voice.tts.online.voices') || undefined,
    headers: cfg.get<Record<string, string>>('voice.tts.online.headers') || undefined,
    timeoutMs: cfg.get<number>('voice.tts.online.timeoutMs') || undefined,
  };
}

/** 从配置中心拼出本地 GGUF 引擎配置（audio.cpp + breeze-tts-2-q8_0.gguf） */
function readBreezeTts2Config(cfg: TtsConfigReader): BreezeTts2Config {
  return {
    cliPath: cfg.get<string>('voice.tts.breeze.cliPath') || '',
    modelPath: cfg.get<string>('voice.tts.breeze.modelPath') || '',
    backend: (cfg.get<string>('voice.tts.breeze.backend') || 'cuda') as BreezeTts2Config['backend'],
    device: cfg.get<number>('voice.tts.breeze.device') ?? 0,
    defaultInstruct: cfg.get<string>('voice.tts.breeze.defaultInstruct') || undefined,
    requestOptions: cfg.get<Record<string, string>>('voice.tts.breeze.requestOptions') || undefined,
    workDir: cfg.get<string>('voice.tts.breeze.workDir') || undefined,
    voicesDir: cfg.get<string>('voice.tts.breeze.voicesDir') || undefined,
    // 常驻 server：非空即走 HTTP（实测单次 2.0s vs CLI 9.7s）。
    // 留空 = 保持原 CLI 行为，老配置不受影响。
    serverUrl: cfg.get<string>('voice.tts.breeze.serverUrl') || undefined,
    serverModelId: cfg.get<string>('voice.tts.breeze.serverModelId') || undefined,
    serverAutoStart: cfg.get<boolean>('voice.tts.breeze.serverAutoStart') ?? undefined,
    serverPort: cfg.get<number>('voice.tts.breeze.serverPort') || undefined,
    timeoutMs: cfg.get<number>('voice.tts.breeze.timeoutMs') || undefined,
  };
}

/** 引擎类型名（配置取值） */
export type TtsEngineKind = 'cosyvoice3' | 'breeze-tts-2' | 'online';

/**
 * 创建引擎实例（**不缓存**；需要单例用 getTtsEngine）。
 * 拆开是为了让测试能拿到新鲜实例、避免全局状态串味。
 */
export function createTtsEngine(cfg: TtsConfigReader): TtsEngine {
  const kind = (cfg.get<string>('voice.tts.engine') || 'cosyvoice3') as TtsEngineKind;
  if (kind === 'online') return createOnlineTtsEngine(() => readOnlineConfig(cfg));
  if (kind === 'breeze-tts-2') return createBreezeTts2Engine(() => readBreezeTts2Config(cfg));
  return createCosyVoiceEngine();
}

// ── 进程级单例 ────────────────────────────────────────────────
// 与 src/stt/index.ts 同模式：整个 serve 进程共享一个引擎实例。
//
// 缓存键 = 「会影响选哪个引擎」的配置指纹（不是对象引用 —— 调用方每次传新
// 对象时引用比较永远不等，会退化成每次都重建）。**设置页/TUI 切换引擎后，
// 下一次取用自动换新实例**，不需要重启进程。这是 say 能热切换引擎的支点。
// 注意指纹里只放"选型"字段：apiKey / voice 这些由引擎内部现读，不参与重建判断。
let instance: TtsEngine | null = null;
let instanceKey = '';

function engineKey(cfg: TtsConfigReader): string {
  const kind = cfg.get<string>('voice.tts.engine') || 'cosyvoice3';
  if (kind === 'online') return `online:${cfg.get<string>('voice.tts.online.provider') || 'breeze'}`;
  if (kind === 'breeze-tts-2') {
    return `breeze:${cfg.get<string>('voice.tts.breeze.backend') || 'cuda'}:${cfg.get<string>('voice.tts.breeze.modelPath') || ''}`;
  }
  return 'cosyvoice3';
}

export function getTtsEngine(cfg: TtsConfigReader): TtsEngine {
  const key = engineKey(cfg);
  if (!instance || instanceKey !== key) {
    instance = createTtsEngine(cfg);
    instanceKey = key;
  }
  return instance;
}

/** 测试 / 强制换引擎时清缓存 */
export function resetTtsEngine(): void {
  instance = null;
  instanceKey = '';
}

// ── 引擎清单（设置页 / TUI 的"接哪个"数据源）────────────────────

export interface TtsEngineInfo {
  /** 实现自己的 id（'cosyvoice3' / 'breeze-tts-2' / 'online-breeze'） */
  id: string;
  /** 配置取值（写回 voice.tts.engine 用这个） */
  kind: TtsEngineKind;
  kindType: 'local' | 'remote';
  /** 给用户看的一句话说明 */
  label: string;
  capabilities: { voice: boolean; speed: boolean; emotion: boolean };
  /** 是否可用（本地引擎看模型/二进制在不在；在线看配置全不全） */
  ready: boolean;
  /** 就绪/缺失详情 */
  detail: string;
  /** 是否是当前选中的那个 */
  active: boolean;
}

/**
 * 列出全部可选引擎及其状态。
 * 每个引擎都现建实例取 capabilities()/status() —— 这三者构造都很轻
 * （cosyvoice 拿单例、breeze 只做 existsSync、online 只读配置），无副作用。
 */
export function listAvailableEngines(cfg: TtsConfigReader): TtsEngineInfo[] {
  const specs: Array<{ kind: TtsEngineKind; label: string }> = [
    { kind: 'cosyvoice3', label: 'CosyVoice3 · 本地（支持语速，不支持情绪）' },
    { kind: 'breeze-tts-2', label: 'BreezeTTS2 · 本地 GGUF（支持情绪）' },
    { kind: 'online', label: '在线 API · Breeze / OpenAI 兼容（支持情绪）' },
  ];
  const activeKey = engineKey(cfg);
  return specs.map((s) => {
    // 用"把 engine 覆盖成这个 kind"的读配置器，复用同一套工厂
    const probe: TtsConfigReader = {
      get<T>(k: string): T | undefined {
        if (k === 'voice.tts.engine') return s.kind as unknown as T;
        return cfg.get<T>(k);
      },
    };
    const e = createTtsEngine(probe);
    const st = e.status?.();
    return {
      id: e.id,
      kind: s.kind,
      kindType: e.kind,
      label: s.label,
      capabilities: e.capabilities(),
      ready: st?.ready ?? true,
      detail: st?.detail ?? '',
      active: engineKey(probe) === activeKey,
    };
  });
}
