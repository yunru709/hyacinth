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
  maxTokens: number;
  reasoning?: boolean;
}

function buildProviderModels(): Record<string, ModelMeta[]> {
  const loader = getModelCatalogLoader();
  const entries = loader.getAll();
  const map: Record<string, ModelMeta[]> = {};
  const excludedIds = new Set(['__default__']);
  for (const e of entries) {
    if (excludedIds.has(e.id)) continue;
    const p = e.provider;
    if (!map[p]) map[p] = [];
    map[p].push({
      id: e.id,
      name: e.name,
      contextWindow: e.contextWindow,
      maxTokens: e.maxTokens,
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
    if (found) return found.maxTokens;
  }

  const firstNonDefault = entries.find((m) => m.id !== '__default__');
  return firstNonDefault?.maxTokens ?? entries[0]?.maxTokens ?? 8192;
}