import type { ProviderType } from '../types.js';
import { getModelCatalogLoader, type ModelCatalogEntry } from './model-catalog-loader.js';
import type { ProviderSampling } from './fields.js';
import type { ReasoningEffort } from './model-types.js';

/** 模型能力标记 */
export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  thinking: boolean;
  vision: boolean;
  inputTypes: ('text' | 'image' | 'document')[];
}

/** 模型定价（每 1M token，美元） */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 模型元信息 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  /** 最大输入上下文窗口（token 数） */
  contextWindow: number;
  /** 单次请求最大输出 token 数 */
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  cost?: ModelCost;
  status: 'available' | 'preview' | 'deprecated' | 'disabled';
  replacedBy?: string;
  /**
   * 是否支持推理（reasoning）。
   *
   * ⚠️ 2026-11-08 补：此前 `ModelInfo` **没有这个字段**，而 `ModelCatalogEntry` 有
   * （model-types.ts 每条模型都声明了 `reasoning: true/false`）⇒ 目录里明明有信息，
   * 转到 `ModelInfo` 时被静默丢弃，调用方只能靠 `reasoningEffort` 是否存在来猜。
   */
  reasoning?: boolean;
  /** 推理/思考强度（仅支持 reasoning 的模型有效） */
  reasoningEffort?: ReasoningEffort;
  /** 模型级思考接线覆盖（优先于厂商级；见 model-types.ts 同名字段说明） */
  thinkingStyle?: string;
  /** 模型级默认采样参数（激活配置/厂商级未覆盖时生效） */
  sampling?: ProviderSampling;
}

function entryToModelInfo(entry: ModelCatalogEntry): ModelInfo {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider as ProviderType,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    reasoning: entry.reasoning,
    reasoningEffort: entry.reasoningEffort,
    thinkingStyle: entry.thinkingStyle,
    capabilities: {
      streaming: entry.capabilities.streaming,
      toolCalling: entry.capabilities.toolCalling,
      thinking: entry.capabilities.thinking,
      vision: entry.capabilities.vision,
      inputTypes: entry.capabilities.inputTypes as ('text' | 'image' | 'document')[],
    },
    cost: entry.cost ? { ...entry.cost } : undefined,
    status: entry.status as 'available' | 'preview' | 'deprecated' | 'disabled',
    replacedBy: entry.replacedBy,
    sampling: entry.sampling ? { ...entry.sampling } : undefined,
  };
}

/**
 * ModelCatalog — 全局模型注册表。
 *
 * 集中存放所有支持的模型元信息：contextWindow、maxTokens、capabilities、cost。
 * 各 Provider 实例可通过 lookup() 查询模型信息，用于 capacity planning 和成本估算。
 */
export class ModelCatalog {
  private models = new Map<string, ModelInfo>();
  private initialized = false;

  constructor() {
    this.registerDefaults();
  }

  register(model: ModelInfo): void {
    const key = `${model.provider}:${model.id}`;
    this.models.set(key, model);
  }

  registerAll(models: ModelInfo[]): void {
    for (const m of models) this.register(m);
  }

  lookup(provider: ProviderType, modelId: string): ModelInfo | undefined {
    return this.models.get(`${provider}:${modelId}`);
  }

  getByProvider(provider: ProviderType): ModelInfo[] {
    const result: ModelInfo[] = [];
    for (const [, info] of this.models) {
      if (info.provider === provider) result.push(info);
    }
    return result;
  }

  getAvailable(): ModelInfo[] {
    const result: ModelInfo[] = [];
    for (const [, info] of this.models) {
      if (info.status === 'available' || info.status === 'preview') result.push(info);
    }
    return result;
  }

  getAll(): ModelInfo[] {
    return Array.from(this.models.values());
  }

  // ⚠️ 2026-11-08 删除 `getDefault(provider)` 死代码。
  // 原实现查的是 `${provider}:__default__` 这个 key —— **目录里从来不存在这种 id**
  // （`setup/model-defaults.ts:25` 反而把 `__default__` 显式列为要排除的 id）。
  // 即：这个方法自诞生起必然返回 undefined，且全仓零调用方。
  // 需要"某厂商的默认模型"请用 `getModelCatalogLoader().getByProvider(type)[0]`
  // 或 `ProviderConfigLoader.getProvider(type)?.defaultModel`。

  init(cwd: string): void {
    getModelCatalogLoader(cwd);
    if (!this.initialized) {
      this.registerDefaults();
    }
  }

  reload(): void {
    this.models.clear();
    this.initialized = false;
    const loader = getModelCatalogLoader();
    loader.reload();
    this.registerDefaults();
  }

  private registerDefaults(): void {
    if (this.initialized) return;
    const loader = getModelCatalogLoader();
    const config = loader.load();
    for (const entry of config.models) {
      this.register(entryToModelInfo(entry));
    }
    this.initialized = true;
  }
}

/** 全局单例 */
export const modelCatalog = new ModelCatalog();

/** 便捷查询 */
export function getModelInfo(provider: ProviderType, modelId: string): ModelInfo | undefined {
  return modelCatalog.lookup(provider, modelId);
}