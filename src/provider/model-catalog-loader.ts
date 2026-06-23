import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  capabilities: {
    streaming: boolean;
    toolCalling: boolean;
    thinking: boolean;
    vision: boolean;
    inputTypes: string[];
  };
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  status: string;
  replacedBy?: string;
  reasoning?: boolean;
}

export interface ModelsCatalogConfig {
  models: ModelCatalogEntry[];
}

const MINIMAL_FALLBACK: ModelCatalogEntry[] = [
  // Anthropic
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', contextWindow: 200000, maxTokens: 64000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'available' },
  { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', provider: 'anthropic', contextWindow: 200000, maxTokens: 64000, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'available' },
  { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4', provider: 'anthropic', contextWindow: 200000, maxTokens: 32000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // OpenAI
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxTokens: 16384, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', contextWindow: 1047576, maxTokens: 32768, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // DeepSeek
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', contextWindow: 1000000, maxTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, status: 'available', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', contextWindow: 1000000, maxTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, status: 'available', reasoning: true },
  // Gemini
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', contextWindow: 1048576, maxTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'available' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', contextWindow: 1048576, maxTokens: 65536, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: true, inputTypes: ['text', 'image', 'document'] }, status: 'available' },
  // Groq
  { id: 'llama-4-maverick', name: 'Llama 4 Maverick', provider: 'groq', contextWindow: 131072, maxTokens: 16384, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  // xAI
  { id: 'grok-4', name: 'Grok 4', provider: 'xai', contextWindow: 1000000, maxTokens: 128000, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // Mistral
  { id: 'mistral-large-latest', name: 'Mistral Large', provider: 'mistral', contextWindow: 131072, maxTokens: 131072, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  // OpenRouter
  { id: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'openrouter', contextWindow: 200000, maxTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  // Moonshot / Kimi
  { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', provider: 'moonshot', contextWindow: 128000, maxTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] }, status: 'available' },
  // Qwen (阿里百炼)
  { id: 'qwen3-vl-plus', name: 'Qwen3 VL Plus', provider: 'qwen', contextWindow: 131072, maxTokens: 8192, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // Zhipu (智谱)
  { id: 'glm-4.6v', name: 'GLM-4.6V', provider: 'zhipu', contextWindow: 128000, maxTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // MiniMax
  { id: 'MiniMax-M3', name: 'MiniMax M3', provider: 'minimax', contextWindow: 1000000, maxTokens: 4096, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
  // MiMo (小米)
  { id: 'mimo-v2.5', name: 'MiMo V2.5', provider: 'mimo', contextWindow: 131072, maxTokens: 8192, capabilities: { streaming: true, toolCalling: true, thinking: false, vision: true, inputTypes: ['text', 'image'] }, status: 'available' },
];

export class ModelCatalogLoader {
  private configPath: string;
  private config: ModelsCatalogConfig | null = null;

  constructor(cwd: string) {
    this.configPath = path.join(os.homedir(), '.agent', 'models-catalog.json');
  }

  load(): ModelsCatalogConfig {
    if (this.config) return this.config;
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.models && Array.isArray(parsed.models) && parsed.models.length > 0) {
          this.config = parsed;
          return this.config!;
        }
      }
    } catch {
    }
    this.config = { models: MINIMAL_FALLBACK };
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch {
    }
    return this.config;
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
