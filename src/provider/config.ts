import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('provider-config');

export interface ProviderMeta {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  envKey: string;
  maxTokens: number;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderMeta>;
}

export const DEFAULT_PROVIDERS: ProvidersConfig = {
  providers: {
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-20250514',
      envKey: 'ANTHROPIC_API_KEY',
      maxTokens: 64000,
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o',
      envKey: 'OPENAI_API_KEY',
      maxTokens: 16384,
    },
    deepseek: {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-v4-flash',
      envKey: 'DEEPSEEK_API_KEY',
      maxTokens: 131072,
    },
    groq: {
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      envKey: 'GROQ_API_KEY',
      maxTokens: 32768,
    },
    xai: {
      id: 'xai',
      name: 'xAI',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-2',
      envKey: 'XAI_API_KEY',
      maxTokens: 8192,
    },
    mistral: {
      id: 'mistral',
      name: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large-latest',
      envKey: 'MISTRAL_API_KEY',
      maxTokens: 8192,
    },
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      defaultModel: 'gemini-2.5-flash',
      envKey: 'GEMINI_API_KEY',
      maxTokens: 65536,
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openrouter/auto',
      envKey: 'OPENROUTER_API_KEY',
      maxTokens: 4096,
    },
    moonshot: {
      id: 'moonshot',
      name: 'Moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'moonshot-v1-128k',
      envKey: 'MOONSHOT_API_KEY',
      maxTokens: 4096,
    },
    qwen: {
      id: 'qwen',
      name: 'Qwen (阿里百炼)',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      defaultModel: 'qwen3-vl-plus',
      envKey: 'DASHSCOPE_API_KEY',
      maxTokens: 8192,
    },
    zhipu: {
      id: 'zhipu',
      name: 'Zhipu (智谱)',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: 'glm-4.6v',
      envKey: 'ZHIPU_API_KEY',
      maxTokens: 4096,
    },
    minimax: {
      id: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      defaultModel: 'MiniMax-M3',
      envKey: 'MINIMAX_API_KEY',
      maxTokens: 4096,
    },
    mimo: {
      id: 'mimo',
      name: 'MiMo (小米)',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      defaultModel: 'mimo-v2.5',
      envKey: 'MIMO_API_KEY',
      maxTokens: 8192,
    },
  },
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