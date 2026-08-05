/**
 * 生成供应商注册表 — 管理 GenerationProvider 实例的创建、路由、fallback。
 *
 * 与对话侧 ModelChannelRegistry 平行但不共享接口：
 * - 对话走 Provider（重，createStream）
 * - 生成走 GenerationProvider（轻，submitTask/getTaskStatus）
 * 两者共用"apiKey/apiKeyEnv/baseUrl"的配置字段风格，凭证管理一致。
 */

import type {
  GenerationConfig,
  GenerationModality,
  GenerationProvider,
  GenerationProviderConfig,
} from './interface.js';
import { loadGenerationConfig } from './config.js';
import { createVolcSeedreamProvider } from './adapters/volc-seedream.js';
import { createVolcSeedanceProvider } from './adapters/volc-seedance.js';

/** 适配器工厂：type 字符串 → Provider 实例构造函数 */
export type GenerationAdapterFactory = (
  name: string,
  cfg: GenerationProviderConfig,
) => GenerationProvider;

/** 内置适配器注册表：type → 工厂。新适配器在这里登记后即可在配置中引用。 */
const BUILTIN_ADAPTERS: Record<string, GenerationAdapterFactory> = {
  'volc-seedream': createVolcSeedreamProvider,
  'volc-seedance': createVolcSeedanceProvider,
};

export class GenerationRegistry {
  private adapters = new Map<string, GenerationAdapterFactory>();
  private instances = new Map<string, GenerationProvider>();
  private config: GenerationConfig;

  constructor(config: GenerationConfig) {
    this.config = config;
    this.registerBuiltins();
  }

  /** 注册所有内置适配器工厂 */
  private registerBuiltins(): void {
    for (const [type, factory] of Object.entries(BUILTIN_ADAPTERS)) {
      this.adapters.set(type, factory);
    }
  }

  static load(cwd: string): GenerationRegistry {
    const { config } = loadGenerationConfig(cwd);
    return new GenerationRegistry(config);
  }

  /** 注册适配器工厂（type → 构造函数）。启动时由各适配器模块调用。 */
  registerAdapter(type: string, factory: GenerationAdapterFactory): void {
    this.adapters.set(type, factory);
  }

  /** 按配置创建/获取 Provider 实例（懒加载 + 缓存） */
  getProvider(name: string): GenerationProvider {
    const cached = this.instances.get(name);
    if (cached) return cached;

    const cfg = this.config.providers[name];
    if (!cfg) {
      throw new Error(`generation provider "${name}" not configured in .agent/generation.json`);
    }
    const factory = this.adapters.get(cfg.type);
    if (!factory) {
      throw new Error(`generation adapter type "${cfg.type}" not registered`);
    }

    const instance = factory(name, cfg);
    this.instances.set(name, instance);
    return instance;
  }

  /** 获取某模态的默认供应商名 */
  getDefaultProviderName(modality: GenerationModality): string | null {
    return this.config.defaults?.[modality] ?? null;
  }

  /** 获取某模态的默认供应商 */
  getDefaultProvider(modality: GenerationModality): GenerationProvider | null {
    const name = this.config.defaults?.[modality];
    if (!name) return null;
    try {
      return this.getProvider(name);
    } catch {
      return null;
    }
  }

  /** 列出已配置的供应商名 */
  listProviders(): string[] {
    return Object.keys(this.config.providers);
  }

  /** 某模态是否有可用供应商 */
  hasModality(modality: GenerationModality): boolean {
    const def = this.config.defaults?.[modality];
    if (!def) return false;
    try {
      this.getProvider(def);
      return true;
    } catch {
      return false;
    }
  }
}
