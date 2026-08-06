/**
 * 生成供应商注册表 — 管理 GenerationProvider 实例的创建、路由。
 *
 * 与对话侧 ModelChannelRegistry 平行但不共享接口：
 * - 对话走 Provider（重，createStream）
 * - 生成走 GenerationProvider（轻，submitTask/getTaskStatus）
 * 两者共用"apiKey/apiKeyEnv/baseUrl"的配置字段风格，凭证管理一致。
 *
 * 适配器注册：从 adapters/index.ts 的 BUILTIN_ADAPTERS 自动收集（全自动，无需手改）。
 * 加新厂商：adapters/xxx.ts 导出 meta → adapters/index.ts 加一行 import。
 */

import type {
  GenerationConfig,
  GenerationProvider,
  GenerationProviderConfig,
  GenerationTaskType,
} from './interface.js';
import { loadGenerationConfig } from './config.js';
import { BUILTIN_ADAPTERS } from './adapters/index.js';

/** 适配器工厂：type 字符串 → Provider 实例构造函数 */
export type GenerationAdapterFactory = (
  name: string,
  cfg: GenerationProviderConfig,
) => GenerationProvider;

export class GenerationRegistry {
  private adapters = new Map<string, GenerationAdapterFactory>();
  private instances = new Map<string, GenerationProvider>();
  private config: GenerationConfig;

  constructor(config: GenerationConfig) {
    this.config = config;
    this.registerBuiltins();
  }

  /** 注册所有内置适配器工厂（从聚合文件自动收集） */
  private registerBuiltins(): void {
    for (const { type, create } of BUILTIN_ADAPTERS) {
      this.adapters.set(type, create);
    }
  }

  static load(cwd: string): GenerationRegistry {
    const { config } = loadGenerationConfig(cwd);
    return new GenerationRegistry(config);
  }

  /** 注册适配器工厂（type → 构造函数）。插件/外部适配器用，内置走 BUILTIN_ADAPTERS。 */
  registerAdapter(type: string, factory: GenerationAdapterFactory): void {
    this.adapters.set(type, factory);
  }

  /** 列出已注册的适配器类型 */
  listAdapterTypes(): string[] {
    return [...this.adapters.keys()];
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
      throw new Error(`generation adapter type "${cfg.type}" not registered (available: ${this.listAdapterTypes().join(', ') || 'none'})`);
    }

    const instance = factory(name, cfg);
    this.instances.set(name, instance);
    return instance;
  }

  /** 获取某任务类型的默认供应商名（如 text_to_image → provider 名） */
  getDefaultProviderName(taskType: GenerationTaskType): string | null {
    return this.config.defaults?.[taskType] ?? null;
  }

  /** 获取某任务类型的默认供应商 */
  getDefaultProvider(taskType: GenerationTaskType): GenerationProvider | null {
    const name = this.config.defaults?.[taskType];
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

  /** 某任务类型是否有可用默认供应商 */
  hasTaskType(taskType: GenerationTaskType): boolean {
    const def = this.config.defaults?.[taskType];
    if (!def) return false;
    try {
      this.getProvider(def);
      return true;
    } catch {
      return false;
    }
  }
}
