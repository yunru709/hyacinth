/**
 * OpenAI 兼容 TTS 适配器 — 本地 / 云端双轨的通用语音合成入口。
 *
 * 走 OpenAI /v1/audio/speech 协议（POST，请求体 {model, input, voice,
 * response_format, speed}，响应体即音频字节）。这一协议的事实标准覆盖面：
 * - 云端：OpenAI、硅基流动（SiliconFlow）等
 * - 本地：openedai-speech、Kokoro-FastAPI、GPT-SoVITS（经 openedai 包装）、
 *   AllTalk 等主流本地 TTS 服务器均提供 OpenAI 兼容端点
 *
 * 同步接口：响应体就是音频 → 转成 data URL 填 initialStatus，
 * service 层检测到 success 直接下载转存，零轮询。
 *
 * 配置示例（<cwd>/.agent/generation.json 或 ~/.agent/generation.json）：
 *   { "providers": {
 *       "local-tts": { "type": "openai-compatible",
 *                      "baseUrl": "http://127.0.0.1:8000",
 *                      "models": { "audio_tts": "tts-1" },
 *                      "voice": "alloy" } },
 *     "defaults": { "audio_tts": "local-tts" } }
 *
 * baseUrl 必填（无合理云端默认，避免误打 OpenAI）；本地服务可不配 apiKey。
 */

import type {
  AdapterMeta,
  GenerationCapabilities,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationStatusResult,
  GenerationTask,
} from '../interface.js';

const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'mp3';

export class OpenAICompatibleProvider implements GenerationProvider {
  readonly providerType: string;
  private baseUrl: string;
  private apiKey: string;
  private cfg: GenerationProviderConfig;

  constructor(name: string, cfg: GenerationProviderConfig) {
    this.providerType = name;
    this.cfg = cfg;
    if (!cfg.baseUrl) {
      throw new Error(
        `[openai-compatible:${name}] baseUrl is required ` +
          `(例如本地 TTS: http://127.0.0.1:8000，OpenAI: https://api.openai.com/v1)`,
      );
    }
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const keyEnv = cfg.apiKeyEnv || 'OPENAI_API_KEY';
    this.apiKey = cfg.apiKey || (process.env[keyEnv] ?? '');
  }

  getCapabilities(): GenerationCapabilities {
    return {
      modalities: ['audio'],
      taskTypes: ['audio_tts'],
      maxDuration: 0,
      aspectRatios: [],
      supportsNegativePrompt: false,
      supportsReferenceImage: false,
      supportsReferenceVideo: false,
      supportsReferenceAudio: false,
      supportsFirstLastFrame: false,
      supportsCallback: false,
      supportsAsync: false, // 同步返回音频字节
      outputFormats: ['audio/mpeg'],
      maxCount: 1,
    };
  }

  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    if (req.taskType !== 'audio_tts') {
      throw new Error(`[openai-compatible:${this.providerType}] 仅支持 audio_tts，收到 ${req.taskType}`);
    }
    const input = req.prompt.trim();
    if (!input) throw new Error('[openai-compatible] prompt（待合成文本）不能为空');

    const model = req.model || this.cfg.models?.audio_tts || this.cfg.model || DEFAULT_MODEL;
    const voice = req.voice || this.cfg.voice || DEFAULT_VOICE;
    const format = this.cfg.responseFormat || DEFAULT_FORMAT;

    const taskId = `oai-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = { taskId, provider: this.providerType };

    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          input,
          voice,
          response_format: format,
          speed: 1,
          ...(req.emotion ? { emotion: req.emotion } : {}),
        }),
        signal: req.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return {
          ...base,
          initialStatus: {
            taskId, provider: this.providerType, status: 'failed',
            errorCode: `HTTP_${res.status}`,
            errorMessage: `TTS 请求失败 ${res.status}: ${detail}`,
          },
        };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        return {
          ...base,
          initialStatus: {
            taskId, provider: this.providerType, status: 'failed',
            errorCode: 'EMPTY_AUDIO',
            errorMessage: 'TTS 服务返回空音频',
          },
        };
      }
      // 本地服务器可能忽略 response_format 直接回 WAV——按魔数嗅探真实格式
      const mime = sniffAudioMime(buf) ?? (format === 'mp3' ? 'audio/mpeg' : `audio/${format}`);
      const resultUrl = `data:${mime};base64,${buf.toString('base64')}`;
      return {
        ...base,
        initialStatus: { taskId, provider: this.providerType, status: 'success', resultUrl },
      };
    } catch (err) {
      return {
        ...base,
        initialStatus: {
          taskId, provider: this.providerType, status: 'failed',
          errorCode: 'NetworkError',
          errorMessage: (err as Error).message,
        },
      };
    }
  }

  /** 同步接口：submitTask 已完成，无需轮询（service 层不会走到这里） */
  async getTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    return (
      task.initialStatus ?? {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: 'NO_STATUS',
        errorMessage: 'openai-compatible 为同步接口，无任务状态可查',
      }
    );
  }

  async cancelTask(): Promise<boolean> {
    return false; // 同步接口无任务可取消
  }
}


/** 按文件魔数嗅探音频 MIME（WAV/OGG/MP3/FLAC），认不出返回 null */
export function sniffAudioMime(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

export const meta: AdapterMeta = {
  type: 'openai-compatible',
  create: (name: string, cfg: GenerationProviderConfig) => new OpenAICompatibleProvider(name, cfg),
};
