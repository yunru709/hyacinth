import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_CATALOG, type ModelCatalogEntry, type ModelsCatalogConfig } from './model-types.js';

export type { ModelCatalogEntry, ModelsCatalogConfig } from './model-types.js';

/** 内置默认模型目录（扁平化 MODEL_CATALOG，兼容旧 MINIMAL_FALLBACK 语义） */
const MINIMAL_FALLBACK: ModelCatalogEntry[] = Object.values(MODEL_CATALOG).flat();

/**
 * ModelCatalogLoader — 模型目录加载器。
 *
 * 数据源统一为 providers.json（与 ProviderConfigLoader 同一文件）：
 *  - 某 provider 在 providers.json 中显式声明 models → 使用该声明
 *  - 未显式声明的 provider → 回退内置 MODEL_CATALOG
 *  - 文件不存在/解析失败 → 整体回退内置 MODEL_CATALOG
 *
 * 直接读文件而非依赖 ProviderConfigLoader 单例，保证 setup（未初始化
 * ProviderConfigLoader）与运行时两条链路都安全。
 */
export class ModelCatalogLoader {
  private configPath: string;
  private config: ModelsCatalogConfig | null = null;

  constructor(cwd: string, configPath?: string) {
    // 默认读 ~/.agent/providers.json；configPath 供测试注入临时路径
    this.configPath = configPath ?? path.join(os.homedir(), '.agent', 'providers.json');
  }

  load(): ModelsCatalogConfig {
    if (this.config) return this.config;
    this.config = this.buildFromProviderConfig();
    return this.config;
  }

  private buildFromProviderConfig(): ModelsCatalogConfig {
    const models: ModelCatalogEntry[] = [];
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { providers?: Record<string, { models?: ModelCatalogEntry[] }> };
        const providers = parsed.providers ?? {};
        const usedProvider = new Set<string>();
        for (const [pid, meta] of Object.entries(providers)) {
          const list = meta?.models;
          if (list && Array.isArray(list) && list.length > 0) {
            // 兼容旧键名 maxTokens → maxOutputTokens
            for (const m of list) {
              const legacy = m as ModelCatalogEntry & { maxTokens?: number };
              if (m.maxOutputTokens === undefined && typeof legacy.maxTokens === 'number') {
                m.maxOutputTokens = legacy.maxTokens;
              }
            }
            models.push(...list);
            usedProvider.add(pid);
          }
        }
        // 未显式声明 models 的 provider → 回退内置默认
        for (const [pid, list] of Object.entries(MODEL_CATALOG)) {
          if (!usedProvider.has(pid)) {
            models.push(...list);
          }
        }
      } else {
        models.push(...MINIMAL_FALLBACK);
      }
    } catch {
      models.length = 0;
      models.push(...MINIMAL_FALLBACK);
    }
    return { models };
  }

  getAll(): ModelCatalogEntry[] {
    return this.load().models;
  }

  getByProvider(provider: string): ModelCatalogEntry[] {
    return this.load().models.filter((m) => m.provider === provider);
  }

  getModel(id: string, provider: string): ModelCatalogEntry | undefined {
    return this.load().models.find((m) => m.id === id && m.provider === provider);
  }

  reload(): ModelsCatalogConfig {
    this.config = null;
    return this.load();
  }
}

let instance: ModelCatalogLoader | null = null;

export function getModelCatalogLoader(cwd?: string): ModelCatalogLoader {
  if (!instance) {
    instance = new ModelCatalogLoader(cwd ?? process.cwd());
  }
  return instance;
}
