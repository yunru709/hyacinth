/**
 * 生成 Provider 抽象 — 与对话 Provider 并列的"生成供应商"层。
 *
 * 设计要点：
 * 1. 两级 API：底层 submitTask/getTaskStatus/cancelTask 暴露任务句柄；
 *    高层 generate() 在 service 层封装"提交+轮询+下载转存"。
 *    原因：视频生成是分钟级任务，必须能展示进度、取消、恢复，不能内部轮询吞掉。
 * 2. 统一产物载体：适配器返回 resultUrl（各家结果全是 URL），
 *    service 层统一下载转存到 outputs/，不塞 base64。
 * 3. 参考输入不强行统一成最小公分母：核心字段统一，
 *    高级能力（运镜/分镜/角色一致）进 capabilities + extraParams 透传。
 * 4. 状态/错误码统一映射（基于国内 6 家 + 海外 3 家 API 共性收敛）。
 */

// ── 模态 ────────────────────────────────────────────────────────────

export type GenerationModality = 'image' | 'video' | 'audio';

/** 任务类型（各厂商通用语义） */
export type GenerationTaskType =
  | 'text_to_image'
  | 'image_to_image'
  | 'text_to_video'
  | 'image_to_video'
  | 'reference_to_video'
  | 'audio_tts';

// ── 媒体输入 ────────────────────────────────────────────────────────

/**
 * 参考媒体输入。各家对 base64 前缀要求不同：
 * - 可灵：Base64 不能加 data:...;base64, 前缀
 * - MiniMax：必须加 data:image/jpeg;base64, 前缀
 * 适配器内部处理前缀差异，统一接口不感知。
 */
export interface MediaInput {
  type: 'url' | 'base64' | 'asset_id';
  url?: string;
  base64?: string;
  assetId?: string;
  /** 角色：首帧 / 尾帧 / 参考图 / 参考视频 / 参考音频 */
  role?: 'first_frame' | 'last_frame' | 'reference' | 'reference_video' | 'reference_audio';
}

// ── 请求 ────────────────────────────────────────────────────────────

export interface GenerationRequest {
  /** 供应商标识（配置中的名字，如 'volcengine'） */
  provider: string;
  /** 模型名称，覆盖配置默认 */
  model?: string;
  /** 任务类型 */
  taskType: GenerationTaskType;

  // 文本
  prompt: string;
  negativePrompt?: string;

  // 参考媒体
  referenceImages?: MediaInput[];
  referenceVideos?: MediaInput[];
  referenceAudio?: MediaInput;
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;

  // 视频参数
  resolution?: '480p' | '720p' | '1080p' | '4k' | string;
  duration?: number;      // 秒
  aspectRatio?: string;   // '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' ...
  fps?: number;
  seed?: number;

  // 音频参数
  voice?: string;
  speed?: number;

  // 控制
  generateAudio?: boolean;
  watermark?: boolean;
  callbackUrl?: string;
  priority?: 'default' | 'low';

  /** 厂商透传参数（运镜/分镜/特效等差异能力不硬建模） */
  extraParams?: Record<string, unknown>;

  /** 中断信号（长轮询/下载可用） */
  signal?: AbortSignal;
}

// ── 任务 / 状态 ─────────────────────────────────────────────────────

/** 统一状态枚举（基于 9 家状态码收敛映射） */
export type GenerationStatus =
  | 'queuing'
  | 'processing'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'expired';

export interface GenerationTask {
  /** 供应商内部任务 ID */
  taskId: string;
  /** 供应商标识 */
  provider: string;
  /** 自定义任务 ID（可灵 external_task_id 等，可选） */
  externalTaskId?: string;
  /**
   * 同步完成的结果（图片等同步接口用）。
   * 同步供应商在 submitTask 里发请求后直接填充，
   * service 层检测到 status=success 即跳过轮询。
   * 异步供应商不填，走 getTaskStatus 轮询。
   */
  initialStatus?: GenerationStatusResult;
}

export interface GenerationStatusResult {
  taskId: string;
  provider: string;
  status: GenerationStatus;
  /** 0-100，可选的进度 */
  progress?: number;

  // 成功时
  resultUrl?: string;
  resultWidth?: number;
  resultHeight?: number;
  duration?: number;
  thumbnailUrl?: string;

  // 失败时
  errorCode?: string;
  errorMessage?: string;

  /** 原始响应（调试用） */
  raw?: unknown;
}

// ── 最终产物（service 层转存后）────────────────────────────────────

export interface GeneratedArtifact {
  /** 本地转存路径 */
  localPath: string;
  /** 原始 URL */
  sourceUrl: string;
  mediaType: string;
  byteSize: number;
  width?: number;
  height?: number;
  duration?: number;
  /** 供应商 + 模型溯源 */
  provider: string;
  model: string;
  /** 生成时间 */
  createdAt: string;
}

// ── 能力描述 ────────────────────────────────────────────────────────

export interface GenerationCapabilities {
  modality: GenerationModality;
  /** 支持的任务类型 */
  taskTypes: GenerationTaskType[];
  /** 支持的分辨率档位 */
  resolutions?: string[];
  /** 支持的最高分辨率 */
  maxResolution?: string;
  /** 支持的最大时长（秒） */
  maxDuration?: number;
  /** 支持宽高比 */
  aspectRatios?: string[];
  /** 是否支持负向提示词 */
  supportsNegativePrompt: boolean;
  /** 是否支持参考图片 */
  supportsReferenceImage?: boolean;
  /** 是否支持参考视频 */
  supportsReferenceVideo?: boolean;
  /** 是否支持参考音频 */
  supportsReferenceAudio?: boolean;
  /** 是否支持首尾帧 */
  supportsFirstLastFrame?: boolean;
  /** 是否支持异步回调 */
  supportsCallback?: boolean;
  /** 是否异步任务（内部统一处理，能力如实描述） */
  supportsAsync: boolean;
  /** 输出格式 */
  outputFormats: string[];
  /** 单次最多产物数 */
  maxCount: number;
}

// ── Provider 接口 ───────────────────────────────────────────────────

/**
 * GenerationProvider — 生成供应商统一抽象。
 *
 * 实现类职责：
 * - submitTask：把统一请求映射到厂商 API，返回任务句柄
 * - getTaskStatus：查询任务状态，映射到统一 GenerationStatus
 * - cancelTask（可选）：取消任务
 * - getCapabilities：能力自描述
 *
 * 不负责：轮询、下载、落盘（那是 service 层的统一职责）。
 * 每个适配器只做"请求映射 + 状态映射"，尽量薄。
 */
export interface GenerationProvider {
  /** 供应商类型标识（如 'volcengine' / 'kling' / 'minimax'） */
  readonly providerType: string;

  /** 提交生成任务（异步），返回任务句柄 */
  submitTask(req: GenerationRequest): Promise<GenerationTask>;

  /** 查询任务状态 */
  getTaskStatus(task: GenerationTask): Promise<GenerationStatusResult>;

  /** 取消任务（可选） */
  cancelTask?(task: GenerationTask): Promise<boolean>;

  /** 能力描述 */
  getCapabilities(): GenerationCapabilities;
}

// ── 注册表条目 ──────────────────────────────────────────────────────

/** 生成供应商配置（复用 ChannelConfig 字段风格，独立命名空间） */
export interface GenerationProviderConfig {
  /** Provider 适配器类型（如 'volcengine'） */
  type: string;
  /** 默认模型 */
  model?: string;
  /** API Key（可选，不填则从环境变量获取） */
  apiKey?: string;
  /** API Key 环境变量名 */
  apiKeyEnv?: string;
  /** API 基础 URL */
  baseUrl?: string;
  /** 描述 */
  description?: string;
}

export interface GenerationConfig {
  /** 各供应商实例配置 */
  providers: Record<string, GenerationProviderConfig>;
  /** 模态默认供应商（image/video/audio → provider 名） */
  defaults?: Partial<Record<GenerationModality, string>>;
}
