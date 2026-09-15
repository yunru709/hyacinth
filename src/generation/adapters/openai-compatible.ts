/**
 * OpenAI 兼容适配器 — TTS / 文生图双轨的通用入口。
 *
 * 走 OpenAI 标准协议：
 * - TTS：POST /v1/audio/speech（请求体 {model, input, voice, response_format,
 *   speed}，响应体即音频字节）。事实标准覆盖面：云端 OpenAI、硅基流动
 *   （SiliconFlow），本地 openedai-speech、Kokoro-FastAPI、GPT-SoVITS
 *   （经 openedai 包装）、AllTalk 等主流本地 TTS 服务器均提供兼容端点。
 * - 文生图：POST /v1/images/generations（{model, prompt, n} → {data:[{url|b64_json}]}）。
 *   覆盖面：OpenAI DALL·E、硅基流动、各类中转站/聚合平台。
 *
 * 同步接口：响应体就是产物 → 转成 data URL / 直接用 URL 填 initialStatus，
 * service 层检测到 success 直接下载转存，零轮询。
 *
 * 能力由配置声明（一厂商多能力）：
 *   { "providers": {
 *       "gateway": { "type": "openai-compatible",
 *                    "baseUrl": "https://gateway.example.com/v1",
 *                    "models": { "audio_tts": "tts-1", "text_to_image": "dall-e-3" },
 *                    "voice": "alloy" } },
 *     "defaults": { "audio_tts": "gateway", "text_to_image": "gateway" } }
 * getCapabilities 按 models 键派生；无 models 声明的存量本地 TTS 配置兜底 audio_tts。
 *
 * baseUrl 必填（无合理云端默认，避免误打 OpenAI）；本地服务可不配 apiKey。
 */

import type {
  AdapterMeta,
  GenerationCapabilities,
  GenerationModality,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationStatusResult,
  GenerationTask,
  GenerationTaskType,
} from '../interface.js';

const DEFAULT_MODEL = 'tts-1';
const DEFAULT_IMAGE_MODEL = 'dall-e-3';
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
    const taskTypes = this.resolveTaskTypes();
    const modalities: GenerationModality[] = [];
    if (taskTypes.includes('audio_tts')) modalities.push('audio');
    if (taskTypes.includes('text_to_image')) modalities.push('image');
    return {
      modalities,
      taskTypes,
      maxDuration: 0,
      aspectRatios: [],
      supportsNegativePrompt: false,
      supportsReferenceImage: false,
      supportsReferenceVideo: false,
      supportsReferenceAudio: false,
      supportsFirstLastFrame: false,
      supportsCallback: false,
      supportsAsync: false, // 同步返回（音频字节 / 图片 URL）
      outputFormats: taskTypes.includes('text_to_image') ? ['image/png'] : ['audio/mpeg'],
      maxCount: 1,
    };
  }

  /** 按配置声明的 models 派生任务类型（一厂商多能力）；无声明（存量本地 TTS 配置）兜底 audio_tts */
  private resolveTaskTypes(): GenerationTaskType[] {
    const models = this.cfg.models ?? {};
    const known = (Object.keys(models) as GenerationTaskType[]).filter(
      tt => tt === 'audio_tts' || tt === 'text_to_image',
    );
    return known.length > 0 ? known : ['audio_tts'];
  }

  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    switch (req.taskType) {
      case 'audio_tts':
        return this.submitTts(req);
      case 'text_to_image':
        return this.submitImage(req);
      default:
        throw new Error(
          `[openai-compatible:${this.providerType}] 仅支持 audio_tts / text_to_image，收到 ${req.taskType}`,
        );
    }
  }

  /** TTS：POST {baseUrl}/v1/audio/speech，响应体即音频字节 → data URL 填 initialStatus */
  private async submitTts(req: GenerationRequest): Promise<GenerationTask> {
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

  /** 文生图：POST {baseUrl}/v1/images/generations，响应 {data:[{url|b64_json}]} → 同步填 initialStatus */
  private async submitImage(req: GenerationRequest): Promise<GenerationTask> {
    const prompt = req.prompt.trim();
    if (!prompt) throw new Error('[openai-compatible] prompt 不能为空');

    const model = req.model || this.cfg.models?.text_to_image || this.cfg.model || DEFAULT_IMAGE_MODEL;
    const taskId = `oai-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const base = { taskId, provider: this.providerType };

    try {
      const res = await fetch(`${this.baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, prompt, n: 1 }),
        signal: req.signal,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return {
          ...base,
          initialStatus: {
            taskId, provider: this.providerType, status: 'failed',
            errorCode: `HTTP_${res.status}`,
            errorMessage: `图片生成请求失败 ${res.status}: ${detail}`,
          },
        };
      }
      const data = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
      const item = data.data?.[0];
      const resultUrl = item?.url
        ?? (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : undefined);
      if (!resultUrl) {
        return {
          ...base,
          initialStatus: {
            taskId, provider: this.providerType, status: 'failed',
            errorCode: 'EMPTY_IMAGE',
            errorMessage: '图片生成响应既无 url 也无 b64_json',
          },
        };
      }
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
