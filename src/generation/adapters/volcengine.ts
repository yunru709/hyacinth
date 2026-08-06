/**
 * 火山方舟适配器 — 一厂商一适配器，按 taskType 路由多能力。
 *
 * 火山一个 ARK_API_KEY 即可使用全部生成能力：
 * - 图片（Seedream）：POST /images/generations        （同步，直接返回）
 * - 视频（Seedance）：POST /contents/generations/tasks （异步，轮询）
 * - 音频 / LLM：同 key 可用，LLM 走现有对话 Provider，不在这层
 *
 * 同步/异步差异通过 GenerationTask.initialStatus 统一：
 * - 图片 submitTask 直接发请求 → 填 initialStatus=success → service 跳过轮询
 * - 视频 submitTask 返回 taskId（无 initialStatus）→ service 进入轮询
 * service 层零特判，差异全部封装在本适配器内部。
 *
 * 关键适配点：
 * 1. 图片无独立 negative_prompt → 拼接 prompt 尾部 `--neg: xxx`
 * 2. 图片 base64 输入不带 `data:` 前缀；视频参考图 base64 需带前缀（两接口要求不同）
 * 3. 图片 size 两种写法（"2K"/"2048x2048"）不可混用
 * 4. 结果 URL 24h 有效 → service 层立即下载转存
 * 5. 图片接口固定 sequential_image_generation=disabled（单图）
 */

import type {
  AdapterMeta,
  GenerationCapabilities,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationStatus,
  GenerationStatusResult,
  GenerationTask,
  MediaInput,
} from '../interface.js';

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_IMAGE_MODEL = 'doubao-seedream-5-0-lite-260128';
const DEFAULT_VIDEO_MODEL = 'doubao-seedance-2-0';

const IMAGE_TASKS = new Set(['text_to_image', 'image_to_image']);
const VIDEO_TASKS = new Set(['text_to_video', 'image_to_video', 'reference_to_video']);

// ── 图片接口类型 ─────────────────────────────────────────────────────

interface VolcImageRequest {
  model: string;
  prompt: string;
  image?: string | string[];
  size?: string;
  seed?: number;
  guidance_scale?: number;
  watermark?: boolean;
  response_format?: 'url' | 'b64_json';
  output_format?: 'png' | 'jpeg';
  sequential_image_generation?: 'disabled' | 'auto';
  max_images?: number;
  optimize_prompt_options?: { enabled: boolean };
  web_search?: boolean;
  stream?: boolean;
}

interface VolcImageResponse {
  created?: number;
  model?: string;
  data?: Array<{ url?: string; b64_json?: string; size?: string; revised_prompt?: string }>;
  usage?: { output_tokens?: number; total_tokens?: number };
  error?: { code?: string; message?: string };
}

// ── 视频接口类型 ─────────────────────────────────────────────────────

interface VolcVideoContent {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url' | 'draft_task';
  text?: string;
  image_url?: { url: string; role?: string };
  video_url?: { url: string; role?: string };
  audio_url?: { url: string; role?: string };
}

interface VolcVideoRequest {
  model: string;
  content: VolcVideoContent[];
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

interface VolcVideoResponse {
  id?: string;
  status?: string;
  content?: { video_url?: string; last_frame_url?: string; video_b64_json?: string; audio_url?: string };
  error?: { code?: string; message?: string };
  model?: string;
  usage?: { completion_tokens?: number };
}

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

function mapErrorCode(code?: string): { errorCode: string; errorMessage: string } {
  const c = code || 'UnknownError';
  const messageMap: Record<string, string> = {
    'ApiKey.Invalid': 'invalid API key',
    InvalidParameter: 'invalid parameter',
    QuotaExhausted: 'quota exhausted / insufficient balance',
    ContentFilter: 'content filtered by policy',
    RateLimitExceeded: 'rate limit exceeded',
  };
  return { errorCode: c, errorMessage: messageMap[c] ?? c };
}

export class VolcengineProvider implements GenerationProvider {
  readonly providerType = 'volcengine';

  private baseUrl: string;
  private apiKey: string;
  private cfg: GenerationProviderConfig;

  constructor(name: string, cfg: GenerationProviderConfig) {
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? '';
    if (!this.apiKey) {
      throw new Error(
        `[volcengine] API key is required. Set ${cfg.apiKeyEnv || 'ARK_API_KEY'} env var or pass apiKey in config.`,
      );
    }
    this.cfg = cfg;
  }

  getCapabilities(): GenerationCapabilities {
    return {
      modalities: ['image', 'video'],
      taskTypes: ['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'reference_to_video'],
      resolutions: ['1K', '2K', '3K', '4K', '480p', '720p', '1080p', '4k'],
      maxResolution: '4K',
      maxDuration: 15,
      aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'],
      supportsNegativePrompt: true, // 图片接口拼接 --neg:；视频不支持
      supportsReferenceImage: true,
      supportsReferenceVideo: true,
      supportsReferenceAudio: true,
      supportsFirstLastFrame: true,
      supportsCallback: true,
      supportsAsync: true, // 视频异步（图片同步，内部统一）
      outputFormats: ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'],
      maxCount: 1,
    };
  }

  /**
   * 按 taskType 路由：
   * - 图片：同步提交 → 填 initialStatus（service 跳过轮询）
   * - 视频：异步提交 → 返回 taskId（service 进入轮询）
   */
  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    if (IMAGE_TASKS.has(req.taskType)) return this.submitImageTask(req);
    if (VIDEO_TASKS.has(req.taskType)) return this.submitVideoTask(req);
    throw new Error(`[volcengine] unsupported task type: ${req.taskType}`);
  }

  /** 查询任务状态（仅视频轮询会走到；图片同步已跳过） */
  async getTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    return this.getVideoTaskStatus(task);
  }

  /** 取消任务（Seedance 无官方取消接口） */
  async cancelTask(_task: GenerationTask): Promise<boolean> {
    return false;
  }

  // ── 内部：模型解析 ────────────────────────────────────────────────

  private resolveModel(req: GenerationRequest, fallback: string): string {
    return req.model || this.cfg.models?.[req.taskType] || this.cfg.model || fallback;
  }

  // ── 内部：图片（同步）────────────────────────────────────────────

  private async submitImageTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildImageRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      return this.failedImageTask(req, 'NetworkError', (err as Error).message);
    }

    let json: VolcImageResponse;
    try {
      json = (await res.json()) as VolcImageResponse;
    } catch {
      return this.failedImageTask(req, 'ParseError', `invalid response (HTTP ${res.status})`);
    }

    if (json.error || !res.ok) {
      const mapped = mapErrorCode(json.error?.code);
      return this.failedImageTask(req, mapped.errorCode, json.error?.message || mapped.errorMessage);
    }

    const first = json.data?.[0];
    const url = first?.url;
    const b64 = first?.b64_json;
    if (!url && !b64) {
      return this.failedImageTask(req, 'EmptyResult', 'response contains no image data');
    }

    const resultUrl = url || `data:image/jpeg;base64,${b64}`;
    const size = first?.size?.split('x');
    const initialStatus: GenerationStatusResult = {
      taskId: `volc-img-${Date.now()}`,
      provider: this.providerType,
      status: 'success',
      resultUrl,
      resultWidth: size && size[0] ? Number(size[0]) : undefined,
      resultHeight: size && size[1] ? Number(size[1]) : undefined,
      raw: json,
    };
    return { taskId: initialStatus.taskId, provider: this.providerType, initialStatus };
  }

  private buildImageRequest(req: GenerationRequest): VolcImageRequest {
    const body: VolcImageRequest = {
      model: this.resolveModel(req, DEFAULT_IMAGE_MODEL),
      prompt: this.buildPrompt(req),
      response_format: 'url',
      sequential_image_generation: 'disabled',
    };

    const size = req.extraParams?.size as string | undefined;
    if (size) body.size = size;
    else if (req.resolution && ['1K', '2K', '3K', '4K'].includes(req.resolution)) body.size = req.resolution;
    else body.size = '2K';

    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.watermark !== undefined) body.watermark = req.watermark;

    const refs = this.mapImageRefs(req);
    if (refs) body.image = refs;

    const x = req.extraParams || {};
    if (typeof x.guidance_scale === 'number') body.guidance_scale = x.guidance_scale;
    if (typeof x.web_search === 'boolean') body.web_search = x.web_search;
    if (x.optimize_prompt_options && typeof x.optimize_prompt_options === 'object') {
      body.optimize_prompt_options = x.optimize_prompt_options as { enabled: boolean };
    }
    if (x.output_format === 'png' || x.output_format === 'jpeg') body.output_format = x.output_format;
    if (typeof x.max_images === 'number') body.max_images = x.max_images;

    return body;
  }

  /** 负向提示词：图片接口无独立字段，拼接 `--neg:`（视频不支持负向） */
  private buildPrompt(req: GenerationRequest): string {
    const base = req.prompt || '';
    const neg = req.negativePrompt?.trim();
    if (!neg) return base;
    if (base.includes('--neg:')) return base;
    return `${base} --neg: ${neg}`;
  }

  /** 图片参考图：MediaInput[] → image 字段（单图 string / 多图 string[]） */
  private mapImageRefs(req: GenerationRequest): string | string[] | undefined {
    const refs = req.referenceImages;
    if (!refs || refs.length === 0) return undefined;
    const values = refs
      .map(m => {
        if (m.type === 'url' && m.url) return m.url;
        if (m.type === 'base64' && m.base64) {
          // 图片接口：base64 不带 data: 前缀
          return m.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
        }
        if (m.type === 'asset_id' && m.assetId) return m.assetId;
        return undefined;
      })
      .filter((v): v is string => !!v);
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : values;
  }

  private failedImageTask(req: GenerationRequest, errorCode: string, errorMessage: string): GenerationTask {
    const initialStatus: GenerationStatusResult = {
      taskId: `volc-img-${Date.now()}`,
      provider: this.providerType,
      status: 'failed',
      errorCode,
      errorMessage,
    };
    return { taskId: initialStatus.taskId, provider: this.providerType, initialStatus };
  }

  // ── 内部：视频（异步）────────────────────────────────────────────

  private async submitVideoTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildVideoRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/contents/generations/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new Error(`[volcengine] video submit failed: ${(err as Error).message}`);
    }

    let json: VolcVideoResponse;
    try {
      json = (await res.json()) as VolcVideoResponse;
    } catch {
      throw new Error(`[volcengine] invalid video response (HTTP ${res.status})`);
    }

    if (json.error || !res.ok) {
      const e = mapErrorCode(json.error?.code);
      throw new Error(`[volcengine] video submit failed: ${e.errorCode} ${json.error?.message || e.errorMessage}`.trim());
    }
    if (!json.id) {
      throw new Error('[volcengine] video submit response missing task id');
    }
    return { taskId: json.id, provider: this.providerType };
  }

  private async getVideoTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/contents/generations/tasks/${encodeURIComponent(task.taskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new Error(`[volcengine] status query failed: ${(err as Error).message}`);
    }

    let json: VolcVideoResponse;
    try {
      json = (await res.json()) as VolcVideoResponse;
    } catch {
      throw new Error(`[volcengine] invalid status response (HTTP ${res.status})`);
    }

    if (json.error || !res.ok) {
      const e = mapErrorCode(json.error?.code);
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: e.errorCode,
        errorMessage: json.error?.message || e.errorMessage,
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
      raw: json,
    };
    if (status === 'failed') {
      result.errorCode = 'TaskFailed';
      result.errorMessage = 'video task failed';
    }
    return result;
  }

  private buildVideoRequest(req: GenerationRequest): VolcVideoRequest {
    const content: VolcVideoContent[] = [];

    if (req.prompt) content.push({ type: 'text', text: req.prompt });

    this.pushVideoImage(content, req.referenceImages);
    this.pushVideoImage(content, req.firstFrame ? [req.firstFrame] : undefined, 'first_frame');
    this.pushVideoImage(content, req.lastFrame ? [req.lastFrame] : undefined, 'last_frame');

    if (req.referenceVideos?.length) {
      for (const v of req.referenceVideos) {
        const url = this.resolveMediaUrl(v);
        if (url) content.push({ type: 'video_url', video_url: { url, role: v.role || 'reference_video' } });
      }
    }
    if (req.referenceAudio) {
      const url = this.resolveMediaUrl(req.referenceAudio);
      if (url) content.push({ type: 'audio_url', audio_url: { url, role: req.referenceAudio.role || 'reference_audio' } });
    }

    const body: VolcVideoRequest = {
      model: this.resolveModel(req, DEFAULT_VIDEO_MODEL),
      content,
    };

    if (req.resolution && ['480p', '720p', '1080p', '4k'].includes(req.resolution)) body.resolution = req.resolution;
    if (req.aspectRatio) body.ratio = req.aspectRatio;
    if (req.duration) body.duration = req.duration;
    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.watermark !== undefined) body.watermark = req.watermark;
    if (req.generateAudio !== undefined) body.generate_audio = req.generateAudio;
    if (req.callbackUrl) body.callback_url = req.callbackUrl;

    const x = req.extraParams || {};
    if (typeof x.return_last_frame === 'boolean') body.return_last_frame = x.return_last_frame;
    if (typeof x.service_tier === 'string') body.service_tier = x.service_tier;
    if (typeof x.draft === 'boolean') body.draft = x.draft;

    return body;
  }

  private pushVideoImage(content: VolcVideoContent[], refs?: MediaInput[], role?: string): void {
    if (!refs?.length) return;
    for (const ref of refs) {
      const url = this.resolveMediaUrl(ref);
      if (url) {
        content.push({ type: 'image_url', image_url: { url, role: role || ref.role || 'reference_image' } });
      }
    }
  }

  /** 视频参考媒体：URL 或 asset_id 直接传，base64 需带 data: 前缀 */
  private resolveMediaUrl(m: MediaInput): string | undefined {
    if (m.type === 'url' && m.url) return m.url;
    if (m.type === 'asset_id' && m.assetId) return m.assetId;
    if (m.type === 'base64' && m.base64) {
      return m.base64.startsWith('data:') ? m.base64 : `data:image/jpeg;base64,${m.base64}`;
    }
    return undefined;
  }
}

// ── 工厂 + meta（自描述，供 adapters/index.ts 聚合）─────────────────

export function createVolcengineProvider(name: string, cfg: GenerationProviderConfig): GenerationProvider {
  return new VolcengineProvider(name, cfg);
}

export const meta: AdapterMeta = {
  type: 'volcengine',
  create: createVolcengineProvider,
};
