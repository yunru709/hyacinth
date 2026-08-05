/**
 * 火山方舟 Seedream 图片适配器 — 同步生成 Provider。
 *
 * 接口形态：POST /images/generations（同步，非 SSE 流式）
 * 与视频 Seedance（异步 task 轮询）完全不同：
 * - 本适配器 submitTask 直接发请求拿结果，填充 initialStatus=success
 * - getTaskStatus 永不调用（图片无轮询），抛错兜底
 *
 * 关键适配点：
 * 1. 无独立 negative_prompt 字段 → 拼接 prompt 尾部 `--neg: xxx`
 * 2. base64 输入不带 `data:image/xxx;base64,` 前缀
 * 3. size 两种写法（"2K" 或 "2048x2048"），不可混用
 * 4. 图片 URL 24h 有效 → service 层立即下载转存
 * 5. 伴陪模式固定 sequential_image_generation=disabled（单图）
 */

import type {
  GenerationCapabilities,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationStatusResult,
  GenerationTask,
} from '../interface.js';

interface VolcSeedreamRequest {
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

interface VolcSeedreamResponse {
  created?: number;
  model?: string;
  data?: Array<{
    url?: string;
    b64_json?: string;
    size?: string;
    revised_prompt?: string;
  }>;
  usage?: { output_tokens?: number; total_tokens?: number };
  error?: { code?: string; message?: string };
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedream-5-0-lite-260128';

/** 火山错误码 → 统一状态（图片接口失败全部映射 failed） */
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

export class VolcSeedreamProvider implements GenerationProvider {
  readonly providerType = 'volc-seedream';

  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(name: string, cfg: GenerationProviderConfig) {
    this.baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? '';
    if (!this.apiKey) {
      throw new Error(
        `[volc-seedream] API key is required. Set ${cfg.apiKeyEnv || 'ARK_API_KEY'} env var or pass apiKey in config.`,
      );
    }
    this.model = cfg.model || DEFAULT_MODEL;
  }

  getCapabilities(): GenerationCapabilities {
    return {
      modality: 'image',
      taskTypes: ['text_to_image', 'image_to_image'],
      resolutions: ['1K', '2K', '3K', '4K'],
      maxResolution: '4K',
      aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'],
      supportsNegativePrompt: true, // 实现为 prompt 拼接，非独立字段
      supportsReferenceImage: true,
      supportsReferenceVideo: false,
      supportsReferenceAudio: false,
      supportsFirstLastFrame: false,
      supportsCallback: false,
      supportsAsync: false,
      outputFormats: ['image/jpeg', 'image/png'],
      maxCount: 1,
    };
  }

  /**
   * 同步提交：直接调 /images/generations 拿结果，填充 initialStatus。
   * 成功 → status=success + resultUrl；失败 → status=failed（service 层抛错）。
   */
  async submitTask(req: GenerationRequest): Promise<GenerationTask> {
    const body = this.buildRequest(req);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      return this.failedTask(req, 'NetworkError', (err as Error).message);
    }

    let json: VolcSeedreamResponse;
    try {
      json = (await res.json()) as VolcSeedreamResponse;
    } catch {
      return this.failedTask(req, 'ParseError', `invalid response (HTTP ${res.status})`);
    }

    // 火山错误结构
    if (json.error || !res.ok) {
      const mapped = mapErrorCode(json.error?.code);
      return this.failedTask(req, mapped.errorCode, json.error?.message || mapped.errorMessage);
    }

    const first = json.data?.[0];
    const url = first?.url;
    const b64 = first?.b64_json;

    if (!url && !b64) {
      return this.failedTask(req, 'EmptyResult', 'response contains no image data');
    }

    // 图片结果：b64 直接给 service 落盘需要 URL；若只有 b64，包一层 data URL
    const resultUrl = url || `data:image/jpeg;base64,${b64}`;
    const size = first?.size?.split('x');

    const initialStatus: GenerationStatusResult = {
      taskId: `seedream-${Date.now()}`,
      provider: this.providerType,
      status: 'success',
      resultUrl,
      resultWidth: size && size[0] ? Number(size[0]) : undefined,
      resultHeight: size && size[1] ? Number(size[1]) : undefined,
      raw: json,
    };

    return {
      taskId: initialStatus.taskId,
      provider: this.providerType,
      initialStatus,
    };
  }

  /** 图片接口无轮询，永不调用；抛错兜底 */
  async getTaskStatus(_task: GenerationTask): Promise<GenerationStatusResult> {
    throw new Error('[volc-seedream] image generation is synchronous; task polling is not supported');
  }

  // ── 内部：请求构造 ────────────────────────────────────────────────

  private buildRequest(req: GenerationRequest): VolcSeedreamRequest {
    const body: VolcSeedreamRequest = {
      model: req.model || this.model,
      prompt: this.buildPrompt(req),
      response_format: 'url',
      sequential_image_generation: 'disabled',
    };

    // 尺寸：优先 extraParams.size（"2K"/"2048x2048"），否则默认 2K
    const size = req.extraParams?.size as string | undefined;
    if (size) body.size = size;
    else if (req.resolution && ['1K', '2K', '3K', '4K'].includes(req.resolution)) {
      body.size = req.resolution;
    } else {
      body.size = '2K';
    }

    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.watermark !== undefined) body.watermark = req.watermark;

    // 参考图映射：MediaInput[] → image 字段（单图 string / 多图 string[]）
    const refs = this.mapReferenceImages(req);
    if (refs) body.image = refs;

    // extraParams 透传（guidance_scale / web_search / optimize_prompt_options / output_format）
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

  /** 负向提示词：Seedream 无独立字段，拼接 `--neg:` 到 prompt 尾部 */
  private buildPrompt(req: GenerationRequest): string {
    const base = req.prompt || '';
    const neg = req.negativePrompt?.trim();
    if (!neg) return base;
    // 避免重复拼接
    if (base.includes('--neg:')) return base;
    return `${base} --neg: ${neg}`;
  }

  /** MediaInput[] → image 字段值 */
  private mapReferenceImages(req: GenerationRequest): string | string[] | undefined {
    const refs = req.referenceImages;
    if (!refs || refs.length === 0) return undefined;

    const values = refs
      .map(m => {
        if (m.type === 'url' && m.url) return m.url;
        if (m.type === 'base64' && m.base64) {
          // 火山接口原生剥离 data: 前缀；为兼容，显式去掉
          return m.base64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
        }
        if (m.type === 'asset_id' && m.assetId) return m.assetId;
        return undefined;
      })
      .filter((v): v is string => !!v);

    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : values;
  }

  private failedTask(req: GenerationRequest, errorCode: string, errorMessage: string): GenerationTask {
    const initialStatus: GenerationStatusResult = {
      taskId: `seedream-${Date.now()}`,
      provider: this.providerType,
      status: 'failed',
      errorCode,
      errorMessage,
    };
    return { taskId: initialStatus.taskId, provider: this.providerType, initialStatus };
  }
}

/** 适配器工厂 — 供 registry.registerAdapter('volc-seedream', ...) 使用 */
export function createVolcSeedreamProvider(name: string, cfg: GenerationProviderConfig): GenerationProvider {
  return new VolcSeedreamProvider(name, cfg);
}
