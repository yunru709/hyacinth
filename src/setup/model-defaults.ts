import { DEFAULT_MAX_CONTEXT_TOKENS } from './config.js';
import { getModelCatalogLoader } from '../provider/model-catalog-loader.js';

const PROVIDER_ALIAS: Record<string, string> = {
  google: 'gemini',
};

function resolveProvider(provider: string): string {
  return PROVIDER_ALIAS[provider] ?? provider;
}

export interface ModelMeta {
  id: string;
  name: string;
  contextWindow: number;
  /** 单次请求最大输出 token 数 */
  maxOutputTokens: number;
  reasoning?: boolean;
}

function buildProviderModels(): Record<string, ModelMeta[]> {
  const loader = getModelCatalogLoader();
  const entries = loader.getAll();
  const map: Record<string, ModelMeta[]> = {};
  const excludedIds = new Set(['__default__']);
  for (const e of entries) {
    if (excludedIds.has(e.id)) continue;
    // 过滤已退役模型：getDefaultModel/PROVIDER_MODELS[0] 取默认时不得选中
    // deprecated 条目（如 deepseek-v4-flash-0731），否则默认模型必然 404/熔断
    if (e.status === 'deprecated') continue;
    const p = e.provider;
    if (!map[p]) map[p] = [];
    map[p].push({
      id: e.id,
      name: e.name,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      reasoning: e.reasoning,
    });
  }
  return map;
}

let _providerModels: Record<string, ModelMeta[]> | null = null;

function getProviderModels(): Record<string, ModelMeta[]> {
  if (!_providerModels) {
    _providerModels = buildProviderModels();
  }
  return _providerModels;
}

/**
 * 失效模块级缓存（2026-11-08 补）。
 *
 * 此前 `_providerModels` 构建一次后**永不失效**，而热重载链路只刷 `modelCatalog`
 * （`hot-reload/model-catalog-watcher.ts`）⇒ 用户改了 `providers.json` 里的 models
 * 声明后，两个"模型事实源"会分叉：
 *    · `PROVIDER_MODELS`（本文件的旧路径，CLI 的 `/model list` 用）→ 旧清单
 *    · `ModelCatalogLoader`（新路径，实际调用与上下文窗口用）→ 新清单
 * 表现为"界面显示的模型和真正调用的模型不一致"，且不报任何错。
 * 必须由 provider watcher 在重载后显式失效。
 */
export function invalidateProviderModels(): void {
  _providerModels = null;
}

/** @deprecated 使用 ModelCatalogLoader 代替 */
export const PROVIDER_MODELS: Record<string, ModelMeta[]> = new Proxy({} as Record<string, ModelMeta[]>, {
  get(_target, prop: string) {
    const resolved = resolveProvider(prop);
    const models = getProviderModels();
    return models[resolved] ?? models[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(getProviderModels());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const resolved = resolveProvider(prop as string);
    const models = getProviderModels();
    if (resolved in models) {
      return { enumerable: true, configurable: true, value: models[resolved] };
    }
    if (prop in models) {
      return { enumerable: true, configurable: true, value: models[prop as string] };
    }
    return undefined;
  },
});

export function getModelContextWindow(provider: string, model?: string): number {
  const resolved = resolveProvider(provider);
  const loader = getModelCatalogLoader();
  const entries = loader.getByProvider(resolved);
  if (entries.length === 0) return DEFAULT_MAX_CONTEXT_TOKENS;

  if (model) {
    const found = entries.find((m) => m.id === model);
    if (found) return found.contextWindow;
  }

  const firstNonDefault = entries.find((m) => m.id !== '__default__');
  return firstNonDefault?.contextWindow ?? entries[0]?.contextWindow ?? DEFAULT_MAX_CONTEXT_TOKENS;
}

export function getModelMaxTokens(provider: string, model?: string): number {
  const resolved = resolveProvider(provider);
  const loader = getModelCatalogLoader();
  const entries = loader.getByProvider(resolved);
  if (entries.length === 0) return 8192;

  if (model) {
    const found = entries.find((m) => m.id === model);
    if (found) return found.maxOutputTokens;
  }

  const firstNonDefault = entries.find((m) => m.id !== '__default__');
  return firstNonDefault?.maxOutputTokens ?? entries[0]?.maxOutputTokens ?? 8192;
}