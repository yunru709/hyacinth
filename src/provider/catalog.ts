import type { ProviderType } from '../types.js';
import { getModelCatalogLoader, type ModelCatalogEntry } from './model-catalog-loader.js';

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
  /** 推理/思考强度（仅支持 reasoning 的模型有效） */
  reasoningEffort?: 'high' | 'max';
}

function entryToModelInfo(entry: ModelCatalogEntry): ModelInfo {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider as ProviderType,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningEffort: entry.reasoningEffort,
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

  getDefault(provider: ProviderType): ModelInfo | undefined {
    return this.models.get(`${provider}:__default__`);
  }

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