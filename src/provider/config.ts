import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';
import { PROVIDER_META } from './provider-meta.js';

const logger = createLogger('provider-config');

// ProviderMeta 类型真源在 provider-meta.ts（与工厂注册表同源，P5-15）
import type { ProviderFactoryMeta as ProviderMeta } from './provider-meta.js';
export type { ProviderFactoryMeta as ProviderMeta } from './provider-meta.js';

export interface ProvidersConfig {
  providers: Record<string, ProviderMeta>;
}

/**
 * 默认厂商元数据 —— 直接引用 PROVIDER_META（P5-15 单一真源）。
 * 浅拷贝容器保证 providers[id] 与注册表 meta 为同一对象（守卫测试 toBe 锁死）。
 */
export const DEFAULT_PROVIDERS: ProvidersConfig = {
  providers: { ...PROVIDER_META },
};

export class ProviderConfigLoader {
  private configPath: string;
  private cache: ProvidersConfig = DEFAULT_PROVIDERS;

  constructor(cwd: string, configPathOverride?: string) {
    this.configPath = configPathOverride ?? path.join(os.homedir(), '.agent', 'providers.json');
  }

  async load(): Promise<ProvidersConfig> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(content) as ProvidersConfig;
      this.cache = parsed;
      logger.info('Provider config loaded', { path: this.configPath });
      return parsed;
    } catch {
      logger.info('Provider config not found, generating default', { path: this.configPath });
      await this.writeDefault();
      this.cache = { ...DEFAULT_PROVIDERS };
      return this.cache;
    }
  }

  /**
   * 读取厂商元数据 —— **逐字段回落**（设计 §3）：
   * 源码出厂快照（PROVIDER_META）为底，用户 providers.json 覆盖同名字段。
   *
   * 历史行为是"整份替换"（`cache[id] ?? default[id]`）⇒ 用户文件里没写的字段
   * 拿不到源码默认值。后果：源码新加的字段（protocol / fieldMap / capabilities /
   * sampling）对已有用户**静默不生效** —— 表现为"代码改了、行为没变"，极难排查。
   */
  getProvider(id: string): ProviderMeta | undefined {
    const user = this.cache.providers[id];
    const base = DEFAULT_PROVIDERS.providers[id];
    if (!user) return base;
    if (!base) return user;
    return { ...base, ...user };
  }

  /**
   * **用户配置里声明的**厂商（不含仅存在于内置快照的）。
   *
   * 语义边界：本方法回答"用户声明了什么"—— `list_providers` 的 DECLARED 视角、
   * JSON 声明厂商的枚举都依赖它，因此**不能**并入内置全集（那会把 14 家内置厂商
   * 也算成"已声明"，且断言被 provider.test.ts 锁死）。
   * 需要"内置 ∪ 用户"时请直接用 `PROVIDER_META`。
   * 每条仍经 `getProvider` 逐字段回落，故返回的是字段补全后的元数据。
   */
  getAll(): ProviderMeta[] {
    return Object.keys(this.cache.providers)
      .map((id) => this.getProvider(id))
      .filter((m): m is ProviderMeta => m !== undefined);
  }

  async reload(): Promise<ProvidersConfig> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(content) as ProvidersConfig;
      this.cache = parsed;
      logger.info('Provider config reloaded', { path: this.configPath });
      return parsed;
    } catch {
      logger.warn('Provider config reload failed, using cache', { path: this.configPath });
      return this.cache;
    }
  }

  private async writeDefault(): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(DEFAULT_PROVIDERS, null, 2), 'utf-8');
    logger.info('Default provider config written', { path: this.configPath });
  }
}

let singleton: ProviderConfigLoader | undefined;

export function getProviderConfigLoader(cwd?: string): ProviderConfigLoader {
  if (!singleton && cwd) {
    singleton = new ProviderConfigLoader(cwd);
  }
  if (!singleton) {
    throw new Error('ProviderConfigLoader not initialized. Call getProviderConfigLoader(cwd) first.');
  }
  return singleton;
}

/** 测试辅助：重置单例（配合构造注入 configPathOverride 使用隔离的 providers.json） */
export function resetProviderConfigLoader(): void {
  singleton = undefined;
}

/** 测试辅助：注入自定义 loader 实例（隔离测试用；传 undefined 还原单例） */
export function __setProviderConfigLoaderForTest(loader: ProviderConfigLoader | undefined): void {
  singleton = loader;
}
