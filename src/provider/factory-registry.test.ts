import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_FACTORIES, PROVIDER_TYPES, registerProviderFactory, getProviderFactory, listProviderFactories } from './factory-registry.js';
import { DEFAULT_PROVIDERS, ProviderConfigLoader, getProviderConfigLoader, __setProviderConfigLoaderForTest } from './config.js';
import { ProviderManager } from './manager.js';
import type { ProviderConfig } from '../types.js';
import type { Provider } from './interface.js';

// ─── 手写基线：与 types.ts 原 16 值联合完全一致（P5-15 后由 PROVIDER_TYPES 派生） ───
const EXPECTED_TYPES = [
  'anthropic', 'openai', 'deepseek', 'groq', 'xai', 'mistral', 'gemini',
  'openrouter', 'moonshot', 'qwen', 'zhipu', 'minimax', 'mimo', 'volcengine',
  'local', 'ollama', 'llamacpp',
] as const;

const LOCAL_TYPES = ['local', 'ollama', 'llamacpp'];

/** 全部在线厂商 env key + gemini 双 key —— beforeEach 清场，隔离真实 shell 环境 */
const ALL_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY',
  'XAI_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY',
  'ZHIPU_API_KEY', 'MINIMAX_API_KEY', 'MIMO_API_KEY', 'ARK_API_KEY',
];

function makeConfig(type: string): ProviderConfig {
  return {
    type: type as ProviderConfig['type'],
    apiKey: 'test-key',
    model: 'test-model',
    baseUrl: 'http://127.0.0.1:11434/v1',
  };
}

beforeEach(() => {
  // ProviderConfigLoader 单例：无参/半参工厂（createDeepSeekProvider 等）内部无条件查询
  // 默认 meta——构造本身不读文件（cache 默认 DEFAULT_PROVIDERS），初始化安全。
  getProviderConfigLoader(process.cwd());
  // 清场：隔离真实 shell 环境（用户 .env 中的 MINIMAX_API_KEY 等会污染可用性断言）。
  // 用 undefined 而非 ''：'' 对 ??（nullish 合并）不回退，会触发 GeminiProvider
  // 构造的「空串 apiKey」边界炸错。
  for (const key of ALL_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 守卫：注册表自洽 ─────────────────────────────────────────────

describe('PROVIDER_FACTORIES 守卫（注册表自洽，P5-15）', () => {
  it('守卫 1：PROVIDER_TYPES 与手写基线 16 值完全一致（无遗漏无多余）', () => {
    expect([...PROVIDER_TYPES]).toEqual([...EXPECTED_TYPES]);
  });

  it('守卫 2：PROVIDER_FACTORIES 键 = PROVIDER_TYPES（双向；编译期 Record 注解已锁，运行时再锁）', () => {
    expect(Object.keys(PROVIDER_FACTORIES).sort()).toEqual([...PROVIDER_TYPES].sort());
  });

  it('守卫 3：DEFAULT_PROVIDERS 仅含 14 在线厂商，local 三态自动排除，且与注册表同源', () => {
    const onlineKeys = Object.keys(DEFAULT_PROVIDERS.providers);
    expect(onlineKeys.sort()).toEqual(EXPECTED_TYPES.filter((t) => !LOCAL_TYPES.includes(t)).sort());
    // 同一对象引用：DEFAULT_PROVIDERS 的 meta 就是注册表的 meta
    for (const [id, meta] of Object.entries(DEFAULT_PROVIDERS.providers)) {
      expect(PROVIDER_FACTORIES[id as keyof typeof PROVIDER_FACTORIES].meta).toBe(meta);
    }
  });

  it('守卫 4：ProviderConfig（types.ts）可赋给工厂 create（结构兼容，编译期验证）', () => {
    const cfg: ProviderConfig = { type: 'deepseek', apiKey: 'k', model: 'm' };
    const p = PROVIDER_FACTORIES.deepseek.create(cfg);
    expect(p.getProviderType()).toBe('deepseek');
  });
});

// ─── JSON 声明厂商（providers.json 零代码接入） ─────────────────────

describe('JSON 声明厂商（~/.agent/providers.json 零代码接入）', () => {
  let tmpDir: string;
  let prevLoader: ReturnType<typeof getProviderConfigLoader>;
  const provFile = () => join(tmpDir, 'providers.json');

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'hyacinth-prov-'));
    prevLoader = getProviderConfigLoader(process.cwd());
  });

  afterAll(async () => {
    __setProviderConfigLoaderForTest(prevLoader); // 还原单例，避免污染其他测试
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function declareProviders(providers: Record<string, unknown>): Promise<void> {
    await writeFile(provFile(), JSON.stringify({ providers }), 'utf-8');
    const loader = new ProviderConfigLoader(tmpDir, provFile());
    await loader.load();
    __setProviderConfigLoaderForTest(loader);
  }

  it('openai 协议声明：getProviderFactory 命中兜底，create 出 OpenAI 兼容实例', async () => {
    await declareProviders({
      my_vendor: {
        id: 'my_vendor', name: 'My Vendor',
        baseUrl: 'https://api.my-vendor.com/v1',
        defaultModel: 'my-model', envKey: 'MY_VENDOR_API_KEY',
      },
    });
    const factory = getProviderFactory('my_vendor');
    expect(factory).toBeDefined();
    const p = factory!.create({ type: 'my_vendor', apiKey: 'k', model: 'm' });
    expect(p.getProviderType()).toBe('my_vendor');
    expect(p.getModel()).toBe('m');
    // JSON 声明的默认模型暴露在 meta 上（createFromEnv 用它兜底）
    expect(factory!.meta?.defaultModel).toBe('my-model');
  });

  it('anthropic 协议声明：create 出 Anthropic 兼容实例', async () => {
    await declareProviders({
      anthy: {
        id: 'anthy', name: 'Anthy', baseUrl: 'https://api.anthy.com/anthropic',
        defaultModel: 'a-1', envKey: 'ANTHY_API_KEY', protocol: 'anthropic',
      },
    });
    const p = getProviderFactory('anthy')!.create({ type: 'anthy', apiKey: 'k', model: 'a-1' });
    expect(p.getProviderType()).toBe('anthy');
    expect(p.getModel()).toBe('a-1');
  });

  it('声明 sampling/fieldMap：create 缺省回退厂商级默认，激活配置可覆盖', async () => {
    await declareProviders({
      samp_vendor: {
        id: 'samp_vendor', name: 'Samp Vendor', baseUrl: 'https://api.samp.example/v1',
        defaultModel: 's-1', envKey: 'SAMP_API_KEY',
        // 厂商级默认采样参数（provider-meta.sampling）
        sampling: { temperature: 0.3, topP: 0.8 },
        // wire 字段名覆盖（OpenAI 兼容端点用标准 user 而非 user_id）
        fieldMap: { userId: 'user' },
      },
    });
    const factory = getProviderFactory('samp_vendor')!;

    // 未传 sampling：回退 meta.sampling；fieldMap 传入 provider
    const p1 = factory.create({ type: 'samp_vendor', apiKey: 'k', model: 's-1' });
    const internals1 = p1 as unknown as { sampling: unknown; fieldMap: unknown };
    expect(internals1.sampling).toEqual({ temperature: 0.3, topP: 0.8 });
    expect(internals1.fieldMap).toEqual({ userId: 'user' });

    // 激活配置 sampling 覆盖厂商级默认
    const p2 = factory.create({ type: 'samp_vendor', apiKey: 'k', model: 's-1', sampling: { temperature: 1.0 } });
    const internals2 = p2 as unknown as { sampling: unknown };
    expect(internals2.sampling).toEqual({ temperature: 1.0 });
  });

  it('anthropic 协议声明 + sampling：同样支持厂商级默认采样', async () => {
    await declareProviders({
      samp_anthy: {
        id: 'samp_anthy', name: 'Samp Anthy', baseUrl: 'https://api.samp-anthy.com/anthropic',
        defaultModel: 'sa-1', envKey: 'SAMP_ANTHY_API_KEY', protocol: 'anthropic',
        sampling: { temperature: 0.2 },
      },
    });
    const p = getProviderFactory('samp_anthy')!.create({ type: 'samp_anthy', apiKey: 'k', model: 'sa-1' });
    const internals = p as unknown as { sampling: unknown };
    expect(internals.sampling).toEqual({ temperature: 0.2 });
  });

  // ── 字段映射数据化：内置厂商 fieldMap 缺省走 meta，可被 providers.json 覆盖 ──

  it('内置厂商 fieldMap 缺省走 meta（openrouter → userId: user，而非 openai 默认 user_id）', async () => {
    await declareProviders({}); // 清空用户声明，只验证内置 meta 兜底
    const p = PROVIDER_FACTORIES.openrouter.create({ type: 'openrouter', apiKey: 'test-key', model: 'test-model' });
    const internals = p as unknown as { fieldMap: unknown };
    expect(internals.fieldMap).toEqual({ userId: 'user' });
  });

  it('内置厂商 fieldMap 可被 providers.json 覆盖（映射数据化：厂商换代即改配置，零代码）', async () => {
    await declareProviders({
      openrouter: {
        id: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openrouter/auto',
        envKey: 'OPENROUTER_API_KEY',
        fieldMap: { userId: 'custom_user' }, // 覆盖内置 meta 的 { userId: 'user' }
      },
    });
    const p = PROVIDER_FACTORIES.openrouter.create({ type: 'openrouter', apiKey: 'test-key', model: 'test-model' });
    const internals = p as unknown as { fieldMap: unknown };
    expect(internals.fieldMap).toEqual({ userId: 'custom_user' });
  });

  it('createFromEnv：envKey 存在时检测到 JSON 声明厂商，否则跳过', async () => {
    await declareProviders({
      env_vendor: {
        id: 'env_vendor', name: 'Env Vendor', baseUrl: 'https://api.env-vendor.com/v1',
        defaultModel: 'e-1', envKey: 'ENV_VENDOR_API_KEY',
      },
    });
    expect(getProviderFactory('env_vendor')!.createFromEnv?.()).toBeNull();
    vi.stubEnv('ENV_VENDOR_API_KEY', 'secret');
    try {
      const p = getProviderFactory('env_vendor')!.createFromEnv?.();
      expect(p?.getProviderType()).toBe('env_vendor');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('未声明的 type：保持原行为返回 undefined（不吞错误）', async () => {
    await declareProviders({});
    expect(getProviderFactory('no-such-vendor')).toBeUndefined();
  });

  it('listProviderFactories 合并 JSON 声明厂商（内置之后）', async () => {
    await declareProviders({
      extra_one: {
        id: 'extra_one', name: 'Extra 1', baseUrl: 'https://x.example/v1',
        defaultModel: 'x-1', envKey: 'EXTRA_ONE_API_KEY',
      },
    });
    const all = listProviderFactories();
    const names = all.map(([t]) => t);
    expect(names).toContain('extra_one');
    // 内置键序优先：extra_one 出现在 anthropic 之后
    expect(names.indexOf('extra_one')).toBeGreaterThan(names.indexOf('anthropic'));
    // 内置厂商不重复出现
    expect(names.filter((t) => t === 'openai')).toHaveLength(1);
  });
});

// ─── create：全厂商冒烟 ───────────────────────────────────────────

describe('PROVIDER_FACTORIES.create 全厂商冒烟', () => {
  it('在线厂商：create 返回实例且 getProviderType 匹配', () => {
    for (const type of EXPECTED_TYPES.filter((t) => !LOCAL_TYPES.includes(t))) {
      const p = PROVIDER_FACTORIES[type as keyof typeof PROVIDER_FACTORIES].create(makeConfig(type));
      expect(p.getProviderType()).toBe(type);
    }
  });

  it('local/ollama：返回 LocalProvider 实例（ollama 显式 backend）', () => {
    const local = PROVIDER_FACTORIES.local.create(makeConfig('local'));
    const ollama = PROVIDER_FACTORIES.ollama.create(makeConfig('ollama'));
    expect(local.getProviderType()).toMatch(/^(local|ollama|llamacpp)$/);
    expect(ollama.getProviderType()).toBe('ollama');
  });

  it('llamacpp：仅后端，不可直接创建（抛错）', () => {
    expect(() => PROVIDER_FACTORIES.llamacpp.create(makeConfig('llamacpp'))).toThrow(
      /llamacpp is a local backend/,
    );
  });

  it('未知类型：createProviderFromConfig 抛 Unknown provider type', () => {
    expect(() =>
      ProviderManager.createProviderFromConfig({ type: 'no-such-provider' as never, apiKey: 'k', model: 'm' }),
    ).toThrow(/Unknown provider type: no-such-provider/);
  });
});

// ─── detectFromEnv：顺序即优先级 ───────────────────────────────────

describe('ProviderManager.detectFromEnv（注册表遍历，键序即优先级）', () => {
  it('多 key 并存：anthropic 最优先（与旧 if 链一致）', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-d');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-a');
    expect(ProviderManager.detectFromEnv()?.getProviderType()).toBe('anthropic');
  });

  it('无任何 key：local 兜底（local-config 默认配置存在）', () => {
    const p = ProviderManager.detectFromEnv();
    expect(p).toBeTruthy();
    expect(p!.getProviderType()).toMatch(/^(local|ollama|llamacpp)$/);
  });

  it('gemini 双 key：仅 GOOGLE_API_KEY 也可检测到', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'gk');
    expect(ProviderManager.detectFromEnv()?.getProviderType()).toBe('gemini');
  });

  it('ollama/llamacpp 不参与主检测（无 createFromEnv）', () => {
    vi.stubEnv('MIMO_API_KEY', 'sk-m');
    expect(ProviderManager.detectFromEnv()?.getProviderType()).toBe('mimo');
  });
});

// ─── getAvailableProviders：顺序与语义 ─────────────────────────────

describe('ProviderManager.getAvailableProviders（注册表遍历）', () => {
  it('env 驱动的在线厂商按注册表顺序返回，local 兜底、ollama/llamacpp 不出现', () => {
    vi.stubEnv('MIMO_API_KEY', 'm');
    vi.stubEnv('DEEPSEEK_API_KEY', 'd');
    vi.stubEnv('ANTHROPIC_API_KEY', 'a');
    const avail = ProviderManager.getAvailableProviders();
    // 顺序 = 注册表顺序（anthropic → deepseek → mimo），不受 stub 顺序影响
    expect(avail.slice(0, 3)).toEqual(['anthropic', 'deepseek', 'mimo']);
    expect(avail).toContain('local'); // local-config 兜底
    expect(avail).not.toContain('ollama');
    expect(avail).not.toContain('llamacpp');
  });

  it('gemini 双 key 计入可用性', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'gk');
    expect(ProviderManager.getAvailableProviders()).toContain('gemini');
  });
});

// ─── API_KEY_MAP 派生链 ───────────────────────────────────────────

describe('API_KEY_MAP 派生链（DEFAULT_PROVIDERS → API_KEY_MAP 自动收敛）', () => {
  it('每个在线厂商的 envKey 与注册表 meta 一致', async () => {
    const { API_KEY_MAP } = await import('../setup/config.js');
    for (const [id, meta] of Object.entries(DEFAULT_PROVIDERS.providers)) {
      expect(API_KEY_MAP[id]).toBe(meta.envKey);
    }
  });
});

// ─── B-3：registerProviderFactory 运行时扩展 ───────────────────────

/** 最小 Provider mock（扩展厂商工厂的 create 返回；内联 mock 用 as 断言） */
function mockExtProvider(type: string, model: string): Provider {
  return {
    getProviderType: () => type as Provider['getProviderType'] extends () => infer R ? R : never,
    getModel: () => model,
  } as Provider;
}

describe('registerProviderFactory（B-3 运行时扩展，同 B-1 原语）', () => {
  it('运行时注册：createProviderFromConfig 纳入扩展厂商，卸载回滚抛 Unknown', () => {
    const disposer = registerProviderFactory('my-foo', {
      create: (cfg) => mockExtProvider('my-foo', cfg.model),
    });
    const p = ProviderManager.createProviderFromConfig({ type: 'my-foo', apiKey: 'k', model: 'm' });
    expect(p.getProviderType()).toBe('my-foo');
    expect(p.getModel()).toBe('m');

    // 卸载回滚：扩展厂商消失，create 抛 Unknown
    disposer.dispose();
    expect(() =>
      ProviderManager.createProviderFromConfig({ type: 'my-foo', apiKey: 'k', model: 'm' }),
    ).toThrow(/Unknown provider type: my-foo/);
  });

  it('detectFromEnv / getAvailableProviders 纳入扩展（内置键序优先，扩展殿后）', () => {
    const disposer = registerProviderFactory('my-ext', {
      create: (cfg) => mockExtProvider('my-ext', cfg.model),
      checkAvailability: () => true, // 恒可用：验证 getAvailableProviders 纳入
    });
    const avail = ProviderManager.getAvailableProviders();
    expect(avail).toContain('my-ext');
    // 扩展殿后：内置（anthropic…llamacpp）之后
    expect(avail.at(-1)).toBe('my-ext');
    disposer.dispose();
    expect(ProviderManager.getAvailableProviders()).not.toContain('my-ext');
  });

  it('同名注册覆盖内置：dispose 恢复内置（热替换回滚语义）', () => {
    // 用内置 type 'openai' 覆盖测试：注册同名工厂，dispose 后恢复内置
    const disposer = registerProviderFactory('openai', {
      create: (cfg) => mockExtProvider('openai-override', cfg.model),
    });
    const p = ProviderManager.createProviderFromConfig({ type: 'openai', apiKey: 'k', model: 'm' });
    expect(p.getProviderType()).toBe('openai-override'); // 覆盖生效

    disposer.dispose();
    const restored = ProviderManager.createProviderFromConfig({ type: 'openai', apiKey: 'k', model: 'm' });
    expect(restored.getProviderType()).toBe('openai'); // 恢复内置
  });
});
