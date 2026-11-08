/**
 * provider 加固守卫（2026-11-08 批次 1–5 的回归网）。
 *
 * 为什么单独一个文件：这一天改的 15 项里，多数是"边界与契约"级别的调整
 * （脱敏、文案、兜底语义、来源副本），**没有一个会被正常调用路径触发**，
 * 所以只靠既有测试根本发现不了回退。这里为每项补一条最小判据。
 *
 * ⚠️ 隔离纪律：一律用临时目录/临时配置文件，绝不触碰 ~/.agent 下的真实配置
 * （model-channels.json 曾被测试夹具覆盖成真实事故，见 registry 源码注释）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelChannelRegistry } from './model-channel-registry.js';
import { ModelCatalogLoader } from './model-catalog-loader.js';
import { getProviderConfigLoader } from './config.js';
import { FallbackProviderChain } from './fallback.js';
import { GeminiProvider } from './gemini.js';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-hardening-'));
  prevEnv = process.env.HYACINTH_MODEL_CHANNELS_PATH;
  process.env.HYACINTH_MODEL_CHANNELS_PATH = path.join(tmpDir, 'model-channels.json');
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.HYACINTH_MODEL_CHANNELS_PATH;
  else process.env.HYACINTH_MODEL_CHANNELS_PATH = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newRegistry(): ModelChannelRegistry {
  getProviderConfigLoader(process.cwd());
  const registry = new ModelChannelRegistry();
  registry.buildFromLegacy(undefined, undefined, 'deepseek');
  registry.initializeChannels();
  return registry;
}

// ── P1-3：listChannels 默认脱敏 ────────────────────────────────────
describe('P1-3 listChannels() 不得流出明文 apiKey', () => {
  it('配了 key 的通道 → 列表里只给 ***，且整体序列化不含密钥', () => {
    const registry = newRegistry();
    registry.upsertChannel('compression', {
      provider: 'deepseek',
      model: 'test-model',
      apiKey: 'sk-super-secret-value',
    });

    const channels = registry.listChannels();
    const found = channels.find((c) => c.name === 'compression');

    expect(found?.apiKey).toBe('***');
    // 整份序列化里都不许出现原文（防止将来有人再把字段透出来）
    expect(JSON.stringify(channels)).not.toContain('sk-super-secret-value');
  });

  it('没配 key 的通道 → apiKey 字段不出现（区分"未配置"与"已配置"）', () => {
    const registry = newRegistry();
    registry.upsertChannel('narration', { provider: 'deepseek', model: 'test-model' });

    const found = registry.listChannels().find((c) => c.name === 'narration');
    expect(found).toBeDefined();
    expect(found?.apiKey).toBeUndefined();
  });
});

// ── P2-3：removeChannel 清单指向 default 而文案说 main ─────────────
describe('P2-3 removeChannel 的错误文案要与实际判断一致', () => {
  it('拒绝删除 default 通道，且文案里出现的是 default 而不是 main', () => {
    const registry = newRegistry();
    expect(() => registry.removeChannel('default')).toThrow(/default/);
    expect(() => registry.removeChannel('default')).not.toThrow(/main/);
  });
});

// ── P1-4：模型目录条目 schema 校验 ─────────────────────────────────
describe('P1-4 目录条目非法时不得静默流入生效区', () => {
  function writeProviders(providers: unknown): string {
    const p = path.join(tmpDir, 'providers.json');
    fs.writeFileSync(p, JSON.stringify({ providers }, null, 2), 'utf-8');
    return p;
  }

  it('contextWindow 非法（0）→ 该条目被剔除', () => {
    const p = writeProviders({
      gw: {
        id: 'gw',
        name: 'GW',
        baseUrl: 'https://gw.example.com/v1',
        defaultModel: 'ok-model',
        models: [
          { id: 'ok-model', name: 'OK', contextWindow: 128000, maxOutputTokens: 4096 },
          { id: 'broken-model', name: 'Broken', contextWindow: 0, maxOutputTokens: 4096 },
        ],
      },
    });

    const loader = new ModelCatalogLoader(process.cwd(), p);
    const ids = loader.getByProvider('gw').map((m) => m.id);

    expect(ids).toContain('ok-model');
    expect(ids).not.toContain('broken-model');
  });

  it('maxOutputTokens 超过 contextWindow → 被截到 contextWindow（不剔条目）', () => {
    const p = writeProviders({
      gw: {
        id: 'gw',
        name: 'GW',
        baseUrl: 'https://gw.example.com/v1',
        defaultModel: 'wide-model',
        models: [
          { id: 'wide-model', name: 'Wide', contextWindow: 8000, maxOutputTokens: 999999 },
        ],
      },
    });

    const loader = new ModelCatalogLoader(process.cwd(), p);
    const entry = loader.getByModelIdSafe?.('wide-model', 'gw')
      ?? loader.getByProvider('gw').find((m) => m.id === 'wide-model');

    expect(entry).toBeDefined();
    expect(entry!.maxOutputTokens).toBeLessThanOrEqual(entry!.contextWindow);
  });

  it('缺 id → 该条目被忽略，其余照常', () => {
    const p = writeProviders({
      gw: {
        id: 'gw',
        name: 'GW',
        baseUrl: 'https://gw.example.com/v1',
        defaultModel: 'good',
        models: [
          { name: 'no-id', contextWindow: 100000, maxOutputTokens: 4096 },
          { id: 'good', name: 'Good', contextWindow: 100000, maxOutputTokens: 4096 },
        ],
      },
    });

    const ids = new ModelCatalogLoader(process.cwd(), p).getByProvider('gw').map((m) => m.id);
    expect(ids).toContain('good');
    expect(ids.filter((id) => !id)).toHaveLength(0);
  });
});

// ── P3-2：stripCacheControl 不得改写调用方数组 ────────────────────
describe('P3-2 stripCacheControl 必须是纯函数（不污染调用方消息）', () => {
  it('返回的副本去掉了 cache_control，原数组保持不动', () => {
    const chain = Object.create(FallbackProviderChain.prototype) as {
      stripCacheControl: (m: unknown[]) => unknown[];
    };
    const original = [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ];

    const stripped = chain.stripCacheControl(original as never) as Array<{
      content: Array<Record<string, unknown>>;
    }>;

    // ① 副本里没有 cache_control
    expect(stripped[0]!.content[0]).not.toHaveProperty('cache_control');
    // ② 调用方原数组**仍在**（这是本次修复的核心：副作用不再外溢到 loop 的 state）
    expect(original[0]!.content[0]).toHaveProperty('cache_control');
  });
});

// ── 批次 5：gemini setThinking 之前完全没实现 ────────────────────
describe('gemini 必须实现 setThinking（此前包装层转发到这里变成静默无效）', () => {
  it('setThinking(false) 能改变内部开关状态', () => {
    const p = new GeminiProvider({ apiKey: 'test-key', model: 'gemini-3-flash' }) as unknown as {
      setThinking?: (enabled: boolean) => void;
      thinkingEnabled: boolean;
    };

    expect(typeof p.setThinking).toBe('function'); // 缺失时这里就红
    p.setThinking!(false);
    expect(p.thinkingEnabled).toBe(false);
    p.setThinking!(true);
    expect(p.thinkingEnabled).toBe(true);
  });
});
