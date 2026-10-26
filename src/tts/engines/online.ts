/**
 * 在线 TTS 引擎 — 走网络 API，配置驱动，可换厂家。
 *
 * 【为什么单独一个实现而不是每家一个类】
 *   在线 TTS 未来会有若干家（孑遗 2026-10-26 原话）。各家的差异集中在三处：
 *   ① 端点形状 ② 认证头 ③ 请求体字段名。把这三处做成 provider 分支，
 *   其余（超时、错误处理、WAV 落地、UA）共享，新增厂家只需加一个分支。
 *
 * 【当前支持】
 *   - `breeze`（2026-10-26 实测通过）：https://api.breeze.blue
 *       POST /v1/text-to-speech/{voice_id}?output_format=wav_24000
 *       header: xi-api-key
 *       body:   { text, model_id, language_code, instructions }
 *       ✅ 支持 `instructions`（情绪/语气）⇒ capabilities.emotion = true
 *   - `openai-compatible`：/v1/audio/speech + Authorization: Bearer
 *       覆盖 OpenAI、SiliconFlow、火山、阿里百炼等兼容实现
 *
 * 【两个必须记住的实测坑】
 *   1. **Cloudflare 会拦默认 UA**：Python urllib / Node fetch 的默认 UA 会收到
 *      `403 error code: 1010`（"banned your access based on your browser signature"）。
 *      这不是 key 无效 —— 2026-10-26 我一开始就是这么误判的。必须显式带浏览器 UA。
 *   2. **TUI 播放只认 WAV**（System.Media.SoundPlayer）。所以默认请求 wav 格式；
 *      厂家若只给 mp3，需要走转码（见 TODO）。
 */
import type { TtsCapabilities, TtsEngine, TtsVoiceInfo } from '../engine.js';

/** 在线引擎配置（由 index.ts 从配置中心读出后注入；用 getter 保证热更新可见） */
export interface OnlineTtsConfig {
  /** 厂家分支：决定端点 / 认证头 / 请求体形状 */
  provider: 'breeze' | 'openai-compatible';
  /** API 根地址，如 https://api.breeze.blue */
  baseUrl: string;
  /** 密钥（不落 config.json 明文，见 index.ts 的密钥读取） */
  apiKey: string;
  /** 模型 id（breeze: breeze-tts-2 / breeze-tts-2-multilingual） */
  model?: string;
  /** 默认音色 id（breeze: voc_xxx；openai: alloy 等） */
  voice?: string;
  /** 语言码（breeze 的 language_code，ISO 639-1 两字母；中文 zh） */
  language?: string;
  /** 输出格式（breeze: wav_24000；openai: wav / mp3） */
  format?: string;
  /** 音色目录（同步返回用；breeze 有 100+ 音色，全量拉取需网络，故配置声明） */
  voices?: TtsVoiceInfo[];
  /** 额外请求头（某些平台要 AppID / 自定义鉴权） */
  headers?: Record<string, string>;
  /** 请求超时（毫秒） */
  timeoutMs?: number;
}

// Cloudflare 1010 坑：默认 UA 会被拦截，必须伪装成浏览器。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 120_000;

/** 把 HTTP 错误整理成一句可读的话（原始 body 常常是 HTML/JSON 混排） */
async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  const brief = text.replace(/\s+/g, ' ').slice(0, 240);
  // 1010：Cloudflare 的"浏览器指纹被拦"，容易被误判成 key 无效，单独点出来
  if (/error code:\s*1010/i.test(brief)) {
    return `HTTP ${res.status} — Cloudflare 拦截了请求指纹（error 1010）。检查 User-Agent 是否被覆盖；这不是 API key 的问题。原始响应：${brief}`;
  }
  return `HTTP ${res.status} — ${brief || '(空响应)'}`;
}

export function createOnlineTtsEngine(getConf: () => OnlineTtsConfig): TtsEngine {
  /** 每次现读配置：settings 改完不用重启就生效 */
  const conf = () => getConf();

  function voices(): TtsVoiceInfo[] {
    const c = conf();
    if (c.voices?.length) return c.voices;
    // 未配置时给一个占位，避免设置页下拉为空（名字带厂家，方便辨认）
    const id = c.voice || (c.provider === 'breeze' ? 'voc_9k38qhkc6qrm' : 'alloy');
    return [{ id, label: `${id}（${c.provider} 默认音色）` }];
  }

  async function synthesize(text: string, opts: { voice?: string; speed?: number; emotion?: string } = {}): Promise<Buffer> {
    const c = conf();
    if (!c.apiKey) throw new Error('在线 TTS 未配置 API key（settings → 语音 → 在线引擎）');
    if (!c.baseUrl) throw new Error('在线 TTS 未配置 baseUrl');

    const voiceId = opts.voice || c.voice || voices()[0]?.id;
    const timeout = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const base = c.baseUrl.replace(/\/+$/, '');

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA, // ← Cloudflare 1010 坑，勿删
      Accept: 'audio/wav, audio/*, */*',
      ...(c.headers ?? {}),
    };

    let url: string;
    let payload: Record<string, unknown>;

    if (c.provider === 'breeze') {
      const format = c.format || 'wav_24000';
      url = `${base}/v1/text-to-speech/${encodeURIComponent(String(voiceId))}?output_format=${encodeURIComponent(format)}`;
      headers['xi-api-key'] = c.apiKey;
      headers['Content-Type'] = 'application/json';
      payload = {
        text,
        ...(c.model ? { model_id: c.model } : {}),
        ...(c.language ? { language_code: c.language } : {}),
        // instructions = 情绪/语气的正解（cosyvoice 做不到的那件事）
        ...(opts.emotion ? { instructions: opts.emotion } : {}),
      };
    } else {
      const format = c.format || 'wav';
      url = `${base}/v1/audio/speech`;
      headers['Authorization'] = `Bearer ${c.apiKey}`;
      headers['Content-Type'] = 'application/json';
      payload = {
        model: c.model || 'tts-1',
        input: text,
        voice: voiceId,
        response_format: format,
        ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}),
        // OpenAI 系没有稳定统一的"情绪"字段；有些兼容实现吃 instructions
        ...(opts.emotion ? { instructions: opts.emotion } : {}),
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) throw new Error(`在线 TTS 合成失败：${await describeFailure(res)}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) throw new Error(`在线 TTS 返回内容过短（${buf.length} 字节），可能不是音频`);

    // 厂家只在 format 里给了 mp3 时不在这里转码：转码属于播放链路的职责，
    // 硬塞进来会让本模块依赖 ffmpeg。当前默认都请求 wav。
    return buf;
  }

  return {
    id: `online-${getConf().provider}`,
    kind: 'remote',
    voices,
    synthesize,
    capabilities: (): TtsCapabilities => {
      const c = conf();
      // breeze 有 instructions 字段 ⇒ 真支持情绪；openai 系按兼容实现尽力而为
      return { voice: true, speed: c.provider !== 'breeze', emotion: true };
    },
    status: () => {
      const c = conf();
      const missing: string[] = [];
      if (!c.apiKey) missing.push('apiKey');
      if (!c.baseUrl) missing.push('baseUrl');
      return {
        ready: missing.length === 0,
        detail:
          missing.length === 0
            ? `${c.provider} @ ${c.baseUrl}（模型 ${c.model || '默认'}）`
            : `配置不完整，缺：${missing.join('、')}`,
      };
    },
  };
}
