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

  constructor(cwd: string) {
    this.configPath = path.join(os.homedir(), '.agent', 'providers.json');
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

  getProvider(id: string): ProviderMeta | undefined {
    return this.cache.providers[id] ?? DEFAULT_PROVIDERS.providers[id];
  }

  getAll(): ProviderMeta[] {
    return Object.values(this.cache.providers);
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
