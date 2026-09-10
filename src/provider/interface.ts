import type { Message, StreamEvent, ProviderType, ToolDefinition } from '../types.js';

/** Provider 能力描述 */
export interface ProviderCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  adapterSupport: boolean;
  maxContextTokens: number;
  isLocal: boolean;
  /** 是否支持视觉/多模态（图片输入） */
  vision: boolean;
  /**
   * 模型输入类型白名单（唯一权威）：'text'|'image'|'document'|'audio'|'video'。
   * 缺省回退 = vision ? ['text','image'] : ['text']。
   * video/audio 输入门控统一查本字段。
   */
  inputTypes?: string[];
}

/**
 * Provider 接口 — 所有模型调用层的统一抽象。
 *
 * 实现类必须支持流式调用（AsyncIterable<StreamEvent>），
 * 并通过 getProviderType / getModel 暴露自身元信息。
 */
export interface Provider {
  /**
   * 创建流式对话，逐事件返回 StreamEvent。
   *
   * @param messages - 对话消息列表
   * @param tools    - 可选的工具定义列表
   */
  createStream(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /** 返回当前 Provider 的模型能力描述 */
  getCapabilities?(): ProviderCapabilities;

  /** 返回当前 Provider 的类型标识 */
  getProviderType(): ProviderType;

  /** 返回当前 Provider 使用的模型名称 */
  getModel(): string;

  /**
   * 运行时切换 KVCache 隔离 ID（DeepSeek user_id / OpenAI user 字段）。
   * 可选能力：仅支持的 API 实现（deepseek/openai 及 compatible 族）；
   * anthropic/gemini/local 等无此参数的 API 不实现，调用方以 ?. 调用。
   * 长驻共享实例切换时注意并发互斥；按调用隔离请用
   * ModelChannelRegistry.createScopedProvider 现建实例。
   */
  setUserId?(userId: string): void;

  /**
   * 动态加载 LoRA Adapter（仅本地 Provider 支持）。
   * @param name - Adapter 名称
   * @param path - Adapter 权重文件路径
   */
  loadAdapter?(name: string, path: string): Promise<void>;

  /**
   * 卸载指定的 Adapter。
   * @param name - Adapter 名称
   */
  unloadAdapter?(name: string): Promise<void>;

  /**
   * 列出当前已加载的 Adapter。
   */
  listAdapters?(): Promise<string[]>;

  /**
   * 运行时动态开关 thinking/reasoning 模式。
   * 仅对支持 thinking 的 Provider（DeepSeek V4、Anthropic Extended Thinking 等）有效。
   * @param enabled 是否启用
   * @param effort  思考强度（DeepSeek: 'high' | 'max'；Anthropic: budget tokens）
   */
  setThinking?(enabled: boolean, effort?: string | number): void;

  /**
   * 运行时切换 KVCache 隔离 ID。
   * 仅对 DeepSeek/OpenAI 等将 user_id 发送到 API 的 Provider 有效。
   * 用于主Agent 模式切换（普通↔陪伴）等场景。
   * @param userId 新的隔离标识
   */
  setUserId?(userId: string): void;
}
