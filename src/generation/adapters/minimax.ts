/**
 * MiniMax 适配器 — 一厂商一适配器，覆盖图片 / 视频 / 音频三模态。
 *
 * 一个 MINIMAX_API_KEY 即可使用全部生成能力（Bearer 认证）：
 * - 图片：POST /v1/image_generation              （同步，直接返回 URL）
 * - 视频：POST /v2/video_generation + 查询        （异步，轮询）
 * - 音频：POST /v1/t2a_async_v2 + 查询 + 文件检索（异步，多一步 retrieve）
 *
 * 同步/异步差异通过 GenerationTask.initialStatus 统一：
 * - 图片 submitTask 直接发请求 → 填 initialStatus=success → service 跳过轮询
 * - 视频/音频 submitTask 返回 taskId（无 initialStatus）→ service 进入轮询
 *
 * 关键适配点：
 * 1. baseUrl 归一化：LLM 侧 vendor 继承的 baseUrl 可能带 /anthropic 后缀，
 *    生成接口需要裸域名 https://api.minimaxi.com，构造函数剥掉后缀。
 * 2. 图生图用 subject_reference（人物主体参考），非通用 image 字段。
 * 3. 视频 content 数组按 role 区分：first_frame / last_frame / reference_*。
 * 4. 音频异步查询成功返回 file_id，需再调 /v1/files/retrieve 拿 download_url，
 *    两步封装在 getTaskStatus 内，service 层零感知。
 * 5. 图片响应 base64 需要包 data: 前缀，URL 24h 有效 → service 层立即下载转存。
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

const DEFAULT_BASE_URL = 'https://api.minimaxi.com';
const DEFAULT_IMAGE_MODEL = 'image-01';
const DEFAULT_VIDEO_MODEL = 'MiniMax-H3';
const DEFAULT_AUDIO_MODEL = 'speech-2.8-hd';

const IMAGE_TASKS = new Set(['text_to_image', 'image_to_image']);
const VIDEO_TASKS = new Set(['text_to_video', 'image_to_video', 'reference_to_video']);
const AUDIO_TASKS = new Set(['audio_tts']);

// ── 图片接口类型 ─────────────────────────────────────────────────────

interface MiniMaxImageRequest {
  model: string;
  prompt: string;
  subject_reference?: Array<{ type: string; image_file: string }>;
  aspect_ratio?: string;
  width?: number;
  height?: number;
  response_format?: 'url' | 'base64';
  n?: number;
  seed?: number;
  prompt_optimizer?: boolean;
  aigc_watermark?: boolean;
}

interface MiniMaxImageResponse {
  data?: {
    image_urls?: string[];
    image_base64?: string[];
  };
  metadata?: { success_count?: number; failed_count?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

// ── 视频接口类型 ─────────────────────────────────────────────────────

interface MiniMaxVideoContentItem {
  type: 'text' | 'image_url' | 'video_url' | 'audio_url';
  text?: string;
  image_url?: { url: string; role?: string };
  video_url?: { url: string; role?: string };
  audio_url?: { url: string; role?: string };
}

interface MiniMaxVideoRequest {
  model: string;
  content: MiniMaxVideoContentItem[];
  resolution?: string;
  duration?: number;
  ratio?: string;
  callback_url?: string;
  aigc_watermark?: boolean;
}

interface MiniMaxVideoTask {
  id?: string;
  model?: string;
  status?: string;
  error?: { code?: string; message?: string };
  content?: { url?: string };
  duration?: number;
  ratio?: string;
}

interface MiniMaxVideoResponse {
  task_id?: string;
  task?: MiniMaxVideoTask;
}

// ── 音频接口类型 ─────────────────────────────────────────────────────

interface MiniMaxT2ARequest {
  model: string;
  text: string;
  voice_setting: { voice_id: string; speed?: number; vol?: number; pitch?: number };
  audio_setting?: { format?: string; audio_sample_rate?: number; bitrate?: number; channel?: number };
  language_boost?: string;
}

interface MiniMaxT2AResponse {
  task_id?: string;
  file_id?: number;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MiniMaxT2AQueryResponse {
  task_id?: number;
  status?: string;
  file_id?: number;
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MiniMaxFileRetrieveResponse {
  file?: { file_id?: number; download_url?: string; bytes?: number; filename?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

// ── 状态映射 ─────────────────────────────────────────────────────────

function mapStatus(raw?: string): GenerationStatus {
  switch (raw) {
    case 'queued':
      return 'queuing';
    case 'running':
    case 'Processing':
      return 'processing';
    case 'succeeded':
    case 'Success':
    case 'success':
      return 'success';
    case 'failed':
    case 'Failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    case 'expired':
    case 'Expired':
      return 'expired';
    default:
      return 'processing';
  }
}

// ── Provider ─────────────────────────────────────────────────────────

export class MiniMaxProvider implements GenerationProvider {
  readonly providerType = 'minimax';

  private baseUrl: string;
  private apiKey: string;
  private cfg: GenerationProviderConfig;

  constructor(_name: string, cfg: GenerationProviderConfig) {
    // 归一化：剥掉 vendor 继承可能带的 /anthropic 后缀（LLM 兼容端点 vs 生成裸域名）
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL)
      .replace(/\/anthropic$/, '')
      .replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? '';
    if (!this.apiKey) {
      throw new Error(
        `[minimax] API key is required. Set ${cfg.apiKeyEnv || 'MINIMAX_API_KEY'} env var or pass apiKey in config.`,
      );
    }
    this.cfg = cfg;
  }

  getCapabilities(): GenerationCapabilities {
    return {
      modalities: ['image', 'video', 'audio'],
      taskTypes: ['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'reference_to_video', 'audio_tts'],
      maxResolution: '2K',
      maxDuration: 15,
      aspectRatios: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'],
      supportsNegativePrompt: false, // MiniMax 无独立负向提示词，用 prompt_optimizer
      supportsReferenceImage: true,
      supportsReferenceVideo: true,
      supportsReferenceAudio: true,
      supportsFirstLastFrame: true,
      supportsCallback: true,
      supportsAsync: true, // 视频/音频异步（图片同步，内部统一）
      outputFormats: ['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg'],
      maxCount: 9, // 图片 n 支持 1-9
    };
  }

  /** 按 taskType 路由：图片同步 / 视频异步 / 音频异步 */
  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    if (IMAGE_TASKS.has(req.taskType)) return this.submitImageTask(req);
    if (VIDEO_TASKS.has(req.taskType)) return this.submitVideoTask(req);
    if (AUDIO_TASKS.has(req.taskType)) return this.submitAudioTask(req);
    throw new Error(`[minimax] unsupported task type: ${req.taskType}`);
  }

  /** 查询任务状态（视频/音频轮询；图片同步已跳过） */
  async getTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    if (task.taskId.startsWith('mm-audio-')) return this.getAudioTaskStatus(task);
    return this.getVideoTaskStatus(task);
  }

  /** 取消任务（MiniMax 无官方取消接口） */
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
      res = await fetch(`${this.baseUrl}/v1/image_generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      return this.failedImageTask(req, 'NetworkError', (err as Error).message);
    }

    let json: MiniMaxImageResponse;
    try {
      json = (await res.json()) as MiniMaxImageResponse;
    } catch {
      return this.failedImageTask(req, 'ParseError', `invalid response (HTTP ${res.status})`);
    }

    if (!res.ok || (json.base_resp && json.base_resp.status_code !== 0)) {
      const code = String(json.base_resp?.status_code ?? 'HTTP' + res.status);
      return this.failedImageTask(req, code, json.base_resp?.status_msg || `HTTP ${res.status}`);
    }

    const urls = json.data?.image_urls;
    const b64s = json.data?.image_base64;
    if ((!urls || urls.length === 0) && (!b64s || b64s.length === 0)) {
      return this.failedImageTask(req, 'EmptyResult', 'response contains no image data');
    }

    const resultUrl = urls?.[0] || `data:image/jpeg;base64,${b64s?.[0]}`;
    const initialStatus: GenerationStatusResult = {
      taskId: `mm-img-${Date.now()}`,
      provider: this.providerType,
      status: 'success',
      resultUrl,
      raw: json,
    };
    return { taskId: initialStatus.taskId, provider: this.providerType, initialStatus };
  }

  private buildImageRequest(req: GenerationRequest): MiniMaxImageRequest {
    const body: MiniMaxImageRequest = {
      model: this.resolveModel(req, DEFAULT_IMAGE_MODEL),
      prompt: req.prompt || '',
      response_format: 'url',
    };

    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.watermark !== undefined) body.aigc_watermark = req.watermark;

    // 图生图：subject_reference（人物主体参考）
    const refs = this.mapSubjectReferences(req);
    if (refs) body.subject_reference = refs;

    // 分辨率：width/height 像素或 aspect_ratio
    if (req.resolution && /^\d+x\d+$/.test(req.resolution)) {
      const [w, h] = req.resolution.split('x').map(Number);
      body.width = w;
      body.height = h;
    }

    const x = req.extraParams || {};
    if (typeof x.n === 'number' && x.n >= 1 && x.n <= 9) body.n = x.n;
    if (typeof x.prompt_optimizer === 'boolean') body.prompt_optimizer = x.prompt_optimizer;
    if (typeof x.aigc_watermark === 'boolean') body.aigc_watermark = x.aigc_watermark;

    return body;
  }

  /** 图生图参考：referenceImages → subject_reference（character 主体参考） */
  private mapSubjectReferences(req: GenerationRequest): Array<{ type: string; image_file: string }> | undefined {
    const refs = req.referenceImages;
    if (!refs || refs.length === 0) return undefined;
    const values = refs
      .map((m) => {
        if (m.type === 'url' && m.url) return m.url;
        if (m.type === 'asset_id' && m.assetId) return m.assetId;
        if (m.type === 'base64' && m.base64) {
          // MiniMax 图生图支持 data URL；包前缀以便识别
          return m.base64.startsWith('data:') ? m.base64 : `data:image/jpeg;base64,${m.base64}`;
        }
        return undefined;
      })
      .filter((v): v is string => !!v);
    if (values.length === 0) return undefined;
    return values.map((image_file) => ({ type: 'character', image_file }));
  }

  private failedImageTask(req: GenerationRequest, errorCode: string, errorMessage: string): GenerationTask {
    return {
      taskId: `mm-img-${Date.now()}`,
      provider: this.providerType,
      initialStatus: {
        taskId: `mm-img-${Date.now()}`,
        provider: this.providerType,
        status: 'failed',
        errorCode,
        errorMessage,
      },
    };
  }

  // ── 内部：视频（异步）────────────────────────────────────────────

  private async submitVideoTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildVideoRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/video_generation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new Error(`[minimax] video submit failed: ${(err as Error).message}`);
    }

    let json: MiniMaxVideoResponse;
    try {
      json = (await res.json()) as MiniMaxVideoResponse;
    } catch {
      throw new Error(`[minimax] invalid video response (HTTP ${res.status})`);
    }

    if (!res.ok || !json.task_id) {
      const msg = (json as unknown as { error?: { message?: string } }).error?.message || `HTTP ${res.status}`;
      throw new Error(`[minimax] video submit failed: ${msg}`);
    }
    return { taskId: `mm-video-${json.task_id}`, provider: this.providerType };
  }

  private async getVideoTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    const rawTaskId = task.taskId.replace(/^mm-video-/, '');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v2/query/video_generation/${encodeURIComponent(rawTaskId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new Error(`[minimax] status query failed: ${(err as Error).message}`);
    }

    let json: MiniMaxVideoResponse;
    try {
      json = (await res.json()) as MiniMaxVideoResponse;
    } catch {
      throw new Error(`[minimax] invalid status response (HTTP ${res.status})`);
    }

    const t = json.task;
    if (!res.ok || !t) {
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: 'QueryFailed',
        errorMessage: `HTTP ${res.status}`,
        raw: json,
      };
    }

    const status = mapStatus(t.status);
    const result: GenerationStatusResult = {
      taskId: task.taskId,
      provider: this.providerType,
      status,
      resultUrl: t.content?.url,
      duration: t.duration,
      raw: json,
    };
    if (status === 'failed') {
      result.errorCode = t.error?.code || 'TaskFailed';
      result.errorMessage = t.error?.message || 'video task failed';
    }
    return result;
  }

  private buildVideoRequest(req: GenerationRequest): MiniMaxVideoRequest {
    const content: MiniMaxVideoContentItem[] = [];

    if (req.prompt) content.push({ type: 'text', text: req.prompt });

    // 图生视频：首帧 / 尾帧
    this.pushVideoImage(content, req.firstFrame ? [req.firstFrame] : undefined, 'first_frame');
    this.pushVideoImage(content, req.lastFrame ? [req.lastFrame] : undefined, 'last_frame');
    // 多模态参考：reference_image
    this.pushVideoImage(content, req.referenceImages, 'reference_image');

    // 多模态参考：reference_video
    if (req.referenceVideos?.length) {
      for (const v of req.referenceVideos) {
        const url = this.resolveMediaUrl(v);
        if (url) content.push({ type: 'video_url', video_url: { url, role: v.role || 'reference_video' } });
      }
    }
    // 多模态参考：reference_audio
    if (req.referenceAudio) {
      const url = this.resolveMediaUrl(req.referenceAudio);
      if (url) content.push({ type: 'audio_url', audio_url: { url, role: req.referenceAudio.role || 'reference_audio' } });
    }

    const body: MiniMaxVideoRequest = {
      model: this.resolveModel(req, DEFAULT_VIDEO_MODEL),
      content,
    };

    if (req.resolution && ['768P', '2K'].includes(req.resolution)) body.resolution = req.resolution;
    else if (req.resolution === '4k') body.resolution = '2K';
    if (req.duration) body.duration = req.duration;
    if (req.aspectRatio) body.ratio = req.aspectRatio;
    if (req.callbackUrl) body.callback_url = req.callbackUrl;
    if (req.watermark !== undefined) body.aigc_watermark = req.watermark;

    return body;
  }

  private pushVideoImage(content: MiniMaxVideoContentItem[], refs?: MediaInput[], role?: string): void {
    if (!refs?.length) return;
    for (const ref of refs) {
      const url = this.resolveMediaUrl(ref);
      if (url) {
        content.push({ type: 'image_url', image_url: { url, role: role || ref.role || 'reference_image' } });
      }
    }
  }

  // ── 内部：音频（异步）────────────────────────────────────────────

  private async submitAudioTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildAudioRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/t2a_async_v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw new Error(`[minimax] audio submit failed: ${(err as Error).message}`);
    }

    let json: MiniMaxT2AResponse;
    try {
      json = (await res.json()) as MiniMaxT2AResponse;
    } catch {
      throw new Error(`[minimax] invalid audio response (HTTP ${res.status})`);
    }

    if (!res.ok || (json.base_resp && json.base_resp.status_code !== 0) || !json.task_id) {
      const msg = json.base_resp?.status_msg || `HTTP ${res.status}`;
      throw new Error(`[minimax] audio submit failed: ${msg}`);
    }
    return { taskId: `mm-audio-${json.task_id}`, provider: this.providerType };
  }

  private async getAudioTaskStatus(task: GenerationTask): Promise<GenerationStatusResult> {
    const rawTaskId = task.taskId.replace(/^mm-audio-/, '');
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/query/t2a_async_query_v2?task_id=${encodeURIComponent(rawTaskId)}`,
        { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
    } catch (err) {
      throw new Error(`[minimax] audio status query failed: ${(err as Error).message}`);
    }

    let json: MiniMaxT2AQueryResponse;
    try {
      json = (await res.json()) as MiniMaxT2AQueryResponse;
    } catch {
      throw new Error(`[minimax] invalid audio status response (HTTP ${res.status})`);
    }

    if (!res.ok || (json.base_resp && json.base_resp.status_code !== 0)) {
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: String(json.base_resp?.status_code ?? 'HTTP' + res.status),
        errorMessage: json.base_resp?.status_msg || `HTTP ${res.status}`,
        raw: json,
      };
    }

    const status = mapStatus(json.status);
    if (status === 'success') {
      // 音频成功：file_id → 调文件检索接口拿 download_url
      const downloadUrl = await this.retrieveAudioUrl(String(json.file_id ?? rawTaskId));
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'success',
        resultUrl: downloadUrl,
        raw: json,
      };
    }
    if (status === 'failed') {
      return {
        taskId: task.taskId,
        provider: this.providerType,
        status: 'failed',
        errorCode: 'TaskFailed',
        errorMessage: 'audio task failed',
        raw: json,
      };
    }
    return { taskId: task.taskId, provider: this.providerType, status, raw: json };
  }

  /** 音频成功：file_id → /v1/files/retrieve → download_url */
  private async retrieveAudioUrl(fileId: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      throw new Error(`[minimax] audio file retrieve failed: ${(err as Error).message}`);
    }
    let json: MiniMaxFileRetrieveResponse;
    try {
      json = (await res.json()) as MiniMaxFileRetrieveResponse;
    } catch {
      throw new Error(`[minimax] invalid file retrieve response (HTTP ${res.status})`);
    }
    if (!res.ok || !json.file?.download_url) {
      throw new Error(`[minimax] audio file retrieve failed: ${json.base_resp?.status_msg || `HTTP ${res.status}`}`);
    }
    return json.file.download_url;
  }

  private buildAudioRequest(req: GenerationRequest): MiniMaxT2ARequest {
    const body: MiniMaxT2ARequest = {
      model: this.resolveModel(req, DEFAULT_AUDIO_MODEL),
      text: req.prompt || '',
      voice_setting: {
        voice_id: req.voice || 'moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85',
      },
    };
    if (req.speed !== undefined && req.speed > 0) body.voice_setting.speed = req.speed;
    body.audio_setting = { format: 'mp3' };
    return body;
  }

  /** 视频/音频参考媒体：URL 或 asset_id 直接传，base64 需带 data: 前缀 */
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

export function createMiniMaxProvider(name: string, cfg: GenerationProviderConfig): GenerationProvider {
  return new MiniMaxProvider(name, cfg);
}

export const meta: AdapterMeta = {
  type: 'minimax',
  create: createMiniMaxProvider,
};
