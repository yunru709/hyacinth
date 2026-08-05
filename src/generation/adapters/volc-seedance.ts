/**
 * 火山方舟 Seedance 视频适配器 — 异步生成 Provider。
 *
 * 接口形态（与 Seedream 图片完全不同）：
 * - 创建任务：POST /contents/generations/tasks → 返回 task_id
 * - 查询任务：GET /contents/generations/tasks/{task_id} → 轮询状态
 *
 * 本适配器是 M1 抽象中"异步路径"的第一个真实实现：
 * - submitTask 返回 taskId（不填 initialStatus），service 层进入轮询分支
 * - getTaskStatus 做状态映射（queued/running/succeeded/failed/expired）
 * - 结果 video_url 24h 有效，service 层统一下载转存
 *
 * 多模态参考输入（Seedance 2.0 特色）：
 * - content[] 数组：text / image_url / video_url / audio_url 混合
 * - 参考图角色：first_frame / last_frame / reference_image
 * - 参考视频角色：reference_video；参考音频角色：reference_audio
 * - 首帧/首尾帧模式 与 多模态参考模式 互斥（适配器不强制，交给 LLM）
 */

import type {
  GenerationCapabilities,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationStatus,
  GenerationStatusResult,
  GenerationTask,
  MediaInput,
} from '../interface.js';

interface SeedanceContent {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url' | 'draft_task';
  text?: string;
  image_url?: { url: string; role?: string };
  video_url?: { url: string; role?: string };
  audio_url?: { url: string; role?: string };
}

interface SeedanceTaskRequest {
  model: string;
  content: SeedanceContent[];
  callback_url?: string;
  return_last_frame?: boolean;
  service_tier?: string;
  execution_expires_after?: number;
  generate_audio?: boolean;
  draft?: boolean;
  resolution?: string;
  ratio?: string;
  duration?: number;
  seed?: number;
  camera_fixed?: boolean;
  watermark?: boolean;
}

interface SeedanceTaskResponse {
  id?: string;
  status?: string;
  content?: {
    video_url?: string;
    last_frame_url?: string;
    video_b64_json?: string;
    audio_url?: string;
  };
  error?: { code?: string; message?: string };
  model?: string;
  usage?: { completion_tokens?: number };
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedance-2-0';

/** 火山任务状态 → 统一状态 */
function mapStatus(raw?: string): GenerationStatus {
  switch (raw) {
    case 'queued': return 'queuing';
    case 'running': return 'processing';
    case 'succeeded': return 'success';
    case 'failed': return 'failed';
    case 'expired': return 'expired';
    default: return 'processing';
  }
}

function mapError(code?: string, message?: string): { errorCode: string; errorMessage: string } {
  return { errorCode: code || 'UnknownError', errorMessage: message || code || 'unknown error' };
}

export class VolcSeedanceProvider implements GenerationProvider {
  readonly providerType = 'volc-seedance';

  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(name: string, cfg: GenerationProviderConfig) {
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? '';
    if (!this.apiKey) {
      throw new Error(
        `[volc-seedance] API key is required. Set ${cfg.apiKeyEnv || 'ARK_API_KEY'} env var or pass apiKey in config.`,
      );
    }
    this.model = cfg.model || DEFAULT_MODEL;
  }

  getCapabilities(): GenerationCapabilities {
    return {
      modality: 'video',
      taskTypes: ['text_to_video', 'image_to_video', 'reference_to_video'],
      resolutions: ['480p', '720p', '1080p', '4k'],
      maxResolution: '4K',
      maxDuration: 15,
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      supportsNegativePrompt: false, // Seedance 不支持负向提示词
      supportsReferenceImage: true,
      supportsReferenceVideo: true,
      supportsReferenceAudio: true,
      supportsFirstLastFrame: true,
      supportsCallback: true,
      supportsAsync: true,
      outputFormats: ['video/mp4', 'video/quicktime'],
      maxCount: 1,
    };
  }

  /** 异步提交：POST /contents/generations/tasks → 返回 taskId，不填 initialStatus（走轮询） */
  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new Error(`[volc-seedance] submit failed: ${(err as Error).message}`);
    }

    let json: SeedanceTaskResponse;
    try {
      json = (await res.json()) as SeedanceTaskResponse;
    } catch {
      throw new Error(`[volc-seedance] invalid response (HTTP ${res.status})`);
    }

    if (json.error || !res.ok) {
      const e = mapError(json.error?.code, json.error?.message);
      throw new Error(`[volc-seedance] submit failed: ${e.errorCode} ${e.errorMessage}`.trim());
    }
    if (!json.id) {
      throw new Error('[volc-seedance] submit response missing task id');
    }

    return { taskId: json.id, provider: this.providerType };
  }

  /** 查询任务状态：GET /contents/generations/tasks/{task_id} */
  async getTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/contents/generations/tasks/${encodeURIComponent(task.taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new Error(`[volc-seedance] status query failed: ${(err as Error).message}`);
    }

    let json: SeedanceTaskResponse;
    try {
      json = (await res.json()) as SeedanceTaskResponse;
    } catch {
      throw new Error(`[volc-seedance] invalid status response (HTTP ${res.status})`);
    }

    if (json.error || !res.ok) {
      const e = mapError(json.error?.code, json.error?.message);
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: e.errorCode,
        errorMessage: e.errorMessage,
        raw: json,
      };
    }

    const status = mapStatus(json.status);
    const result: GenerationStatusResult = {
      taskId: task.taskId,
      provider: this.providerType,
      status,
      resultUrl: json.content?.video_url,
      thumbnailUrl: json.content?.last_frame_url,
      duration: json.content?.video_url ? undefined : undefined,
      raw: json,
    };
    if (status === 'failed') {
      result.errorCode = 'TaskFailed';
      result.errorMessage = json.content ? 'task failed' : 'task failed';
    }
    return result;
  }

  /** 取消任务（Seedance 无官方取消接口，标记不支持） */
  async cancelTask(_task: GenerationTask): Promise<boolean> {
    return false;
  }

  // ── 内部：请求构造 ────────────────────────────────────────────────

  private buildRequest(req: GenerationRequest): SeedanceTaskRequest {
    const content: SeedanceContent[] = [];

    // 提示词 → text
    if (req.prompt) content.push({ type: 'text', text: req.prompt });

    // 参考图 / 首尾帧 → image_url + role
    this.pushImageContent(content, req.referenceImages);
    this.pushImageContent(content, req.firstFrame ? [req.firstFrame] : undefined, 'first_frame');
    this.pushImageContent(content, req.lastFrame ? [req.lastFrame] : undefined, 'last_frame');

    // 参考视频 → video_url
    if (req.referenceVideos?.length) {
      for (const v of req.referenceVideos) {
        const url = this.resolveMediaUrl(v);
        if (url) content.push({ type: 'video_url', video_url: { url, role: v.role || 'reference_video' } });
      }
    }

    // 参考音频 → audio_url
    if (req.referenceAudio) {
      const url = this.resolveMediaUrl(req.referenceAudio);
      if (url) content.push({ type: 'audio_url', audio_url: { url, role: req.referenceAudio.role || 'reference_audio' } });
    }

    const body: SeedanceTaskRequest = {
      model: req.model || this.model,
      content,
    };

    if (req.resolution && ['480p', '720p', '1080p', '4k'].includes(req.resolution)) body.resolution = req.resolution;
    if (req.aspectRatio) body.ratio = req.aspectRatio;
    if (req.duration) body.duration = req.duration;
    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.watermark !== undefined) body.watermark = req.watermark;
    if (req.generateAudio !== undefined) body.generate_audio = req.generateAudio;
    if (req.callbackUrl) body.callback_url = req.callbackUrl;

    // extraParams 透传：return_last_frame / service_tier / draft
    const x = req.extraParams || {};
    if (typeof x.return_last_frame === 'boolean') body.return_last_frame = x.return_last_frame;
    if (typeof x.service_tier === 'string') body.service_tier = x.service_tier;
    if (typeof x.draft === 'boolean') body.draft = x.draft;

    return body;
  }

  private pushImageContent(content: SeedanceContent[], refs?: MediaInput[], role?: string): void {
    if (!refs?.length) return;
    for (const ref of refs) {
      const url = this.resolveMediaUrl(ref);
      if (url) {
        content.push({
          type: 'image_url',
          image_url: { url, role: role || ref.role || 'reference_image' },
        });
      }
    }
  }

  /** MediaInput → URL 字符串（base64 需要转 URL 形式；火山支持 data URL 但参考图建议公网 URL） */
  private resolveMediaUrl(m: MediaInput): string | undefined {
    if (m.type === 'url' && m.url) return m.url;
    if (m.type === 'asset_id' && m.assetId) return m.assetId;
    if (m.type === 'base64' && m.base64) {
      // 火山 content 数组用 image_url.url 承载，base64 需带 data: 前缀
      return m.base64.startsWith('data:') ? m.base64 : `data:image/jpeg;base64,${m.base64}`;
    }
    return undefined;
  }
}

/** 适配器工厂 — 供 registry.registerAdapter('volc-seedance', ...) 使用 */
export function createVolcSeedanceProvider(name: string, cfg: GenerationProviderConfig): GenerationProvider {
  return new VolcSeedanceProvider(name, cfg);
}
