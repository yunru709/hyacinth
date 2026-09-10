import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ModelCatalogLoader } from './model-catalog-loader.js';
import type { ModelCatalogEntry } from './model-types.js';

// ─── 隔离 home 目录：所有测试读写 TEMP home，不碰真实 ~/.agent ───
// 每用例新建唯一目录（tmpdir 下），不删除——避免 WorkBuddy safe-delete shim
// 把 rmSync 转成回收站 trash（满载时 genie-trash spawn ETIMEDOUT，de-flake）。
let TEST_HOME: string;
let AGENT_DIR: string;
let PROV_PATH: string;
function newHome(): void {
  TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-catalog-'));
  AGENT_DIR = path.join(TEST_HOME, '.agent');
  PROV_PATH = path.join(AGENT_DIR, 'providers.json');
}

function writeProviders(providers: Record<string, unknown>): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(PROV_PATH, JSON.stringify({ providers }, null, 2));
}

function makeEntry(overrides: Partial<ModelCatalogEntry> & { id: string; provider: string }): ModelCatalogEntry {
  return {
    name: overrides.id,
    contextWindow: 1000000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true, toolCalling: true, thinking: false, vision: false, inputTypes: ['text'] },
    status: 'available',
    ...overrides,
  };
}

describe('DEFAULT_PROVIDERS 数据自洽（黄金主测试）', () => {
  beforeEach(() => {
    newHome();
  });

  it('每个 provider：defaultModel ∈ models、无 __default__、provider 字段匹配、字段完整', async () => {
    const { DEFAULT_PROVIDERS } = await import('./config.js');
    const providers = Object.entries(DEFAULT_PROVIDERS.providers);
    expect(providers.length).toBeGreaterThanOrEqual(13);
    for (const [id, meta] of providers) {
      const models = meta.models ?? [];
      expect(models.length).toBeGreaterThan(0);
      expect(meta.defaultModel).toBeTruthy();
      // defaultModel 必须存在于自身 models
      expect(models.some((m) => m.id === meta.defaultModel)).toBe(true);
      // 不得残留 __default__ 占位
      expect(models.some((m) => m.id === '__default__')).toBe(false);
      // models 内每条的 provider 字段必须等于所属 provider id
      for (const m of models) {
        expect(m.provider).toBe(id);
        expect(typeof m.contextWindow).toBe('number');
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(typeof m.maxOutputTokens).toBe('number');
        expect(m.maxOutputTokens).toBeGreaterThan(0);
        expect(m.capabilities).toBeTruthy();
        expect(m.status).toBeTruthy();
      }
    }
  });

  it('MODEL_CATALOG 与 DEFAULT_PROVIDERS 的 models 完全同源', async () => {
    const { DEFAULT_PROVIDERS } = await import('./config.js');
    const { MODEL_CATALOG } = await import('./model-types.js');
    for (const [id, meta] of Object.entries(DEFAULT_PROVIDERS.providers)) {
      expect(meta.models).toBe(MODEL_CATALOG[id]);
      expect(meta.models?.length).toBe(MODEL_CATALOG[id]?.length);
    }
  });
});

describe('ModelCatalogLoader 行为契约', () => {
  beforeEach(() => {
    newHome();
  });

  it('providers.json 不存在 → 回退内置 MODEL_CATALOG（覆盖全部内置 provider）', () => {
    const loader = new ModelCatalogLoader(process.cwd(), PROV_PATH);
    const all = loader.getAll();
    expect(all.length).toBeGreaterThan(0);
    const provs = new Set(all.map((m) => m.provider));
    for (const p of ['anthropic', 'openai', 'deepseek', 'gemini', 'groq', 'xai']) {
      expect(provs.has(p)).toBe(true);
    }
  });

  it('providers.json 声明 models → 使用声明；未声明 provider → 回退内置', () => {
    writeProviders({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'x',
        defaultModel: 'deepseek-v4-flash',
        envKey: 'DEEPSEEK_API_KEY',
        models: [makeEntry({ id: 'deepseek-v4-flash', provider: 'deepseek', reasoning: true, reasoningEffort: 'high' })],
      },
    });
    const loader = new ModelCatalogLoader(process.cwd(), PROV_PATH);
    // deepseek 用声明（仅 1 个）
    const ds = loader.getByProvider('deepseek');
    expect(ds).toHaveLength(1);
    expect(ds[0].id).toBe('deepseek-v4-flash');
    // anthropic 未声明 → 回退内置
    expect(loader.getByProvider('anthropic').length).toBeGreaterThan(0);
  });

  it('getModel 按 (provider,id) 精确查找，跨 provider 不串', () => {
    writeProviders({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'x',
        defaultModel: 'deepseek-v4-pro',
        envKey: 'DEEPSEEK_API_KEY',
        models: [
          makeEntry({ id: 'deepseek-v4-flash', provider: 'deepseek', maxOutputTokens: 1 }),
          makeEntry({ id: 'deepseek-v4-pro', provider: 'deepseek', maxOutputTokens: 2 }),
        ],
      },
    });
    const loader = new ModelCatalogLoader(process.cwd(), PROV_PATH);
    expect(loader.getModel('deepseek-v4-pro', 'deepseek')?.maxOutputTokens).toBe(2);
    expect(loader.getModel('deepseek-v4-pro', 'anthropic')).toBeUndefined();
    expect(loader.getModel('nonexistent', 'deepseek')).toBeUndefined();
  });

  it('reload 清缓存后重新聚合文件内容', () => {
    writeProviders({});
    const loader = new ModelCatalogLoader(process.cwd(), PROV_PATH);
    expect(loader.getByProvider('deepseek').length).toBeGreaterThan(0); // 回退内置
    // 写入新配置后再 reload
    writeProviders({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'x',
        defaultModel: 'deepseek-v4-flash',
        envKey: 'K',
        models: [makeEntry({ id: 'deepseek-v4-flash', provider: 'deepseek' })],
      },
    });
    loader.reload();
    expect(loader.getByProvider('deepseek')).toHaveLength(1);
  });

  it('兼容旧键名 maxTokens → maxOutputTokens', () => {
    writeProviders({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'x',
        defaultModel: 'deepseek-v4-flash',
        envKey: 'K',
        models: [{ id: 'deepseek-v4-flash', name: 'X', provider: 'deepseek', contextWindow: 1000000, maxTokens: 12345, capabilities: { streaming: true, toolCalling: true, thinking: true, vision: false, inputTypes: ['text'] }, status: 'available' }],
      },
    });
    const loader = new ModelCatalogLoader(process.cwd(), PROV_PATH);
    expect(loader.getModel('deepseek-v4-flash', 'deepseek')?.maxOutputTokens).toBe(12345);
  });
});

describe('setup 与 provider 层一致性（黄金主测试）', () => {
  beforeEach(() => {
    // spy homedir → 后续创建的 loader/modelCatalog 单例读新 TEST_HOME
    newHome();
    vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('每个 provider 的 defaultModel：出现在 PROVIDER_MODELS 中且 getModelInfo 可查', async () => {
    // 写入与迁移后一致的完整 providers.json（= DEFAULT_PROVIDERS 数据）
    const { DEFAULT_PROVIDERS } = await import('./config.js');
    writeProviders(DEFAULT_PROVIDERS.providers as unknown as Record<string, unknown>);

    // 重新加载模块：确保 modelCatalog/PROVIDER_MODELS 单例在 spy 生效后创建
    vi.resetModules();
    const { PROVIDER_MODELS } = await import('../setup/model-defaults.js');
    const { getModelInfo } = await import('./catalog.js');

    for (const [id, meta] of Object.entries(DEFAULT_PROVIDERS.providers)) {
      const setupList = (PROVIDER_MODELS[id] ?? []) as { id: string }[];
      const def = meta.defaultModel;
      // 1) defaultModel 必须出现在 setup 模型列表中
      expect(setupList.some((m) => m.id === def)).toBe(true);
      // 2) setup 列表不得含 __default__
      expect(setupList.some((m) => m.id === '__default__')).toBe(false);
      // 3) provider 层必须能查到 defaultModel 的能力信息
      const info = getModelInfo(id as never, def);
      expect(info).toBeTruthy();
      expect(info!.contextWindow).toBeGreaterThan(0);
    }
  });
});
