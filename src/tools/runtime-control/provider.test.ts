/**
 * list_providers —— 两个视角合一的契约（声明层 + 实例层）。
 *
 * 锁四件事。起因（2026-10-01）：旧实现只列 providerRouter（运行时已实例化的），
 * 于是"声明了但没 key / 还没被用过"的厂商**完全不显示**，而描述写的是"所有已注册"
 * —— 实际把"opencode 声明生效了"误读成"没生效"。所以①是本文件的核心断言。
 *
 *   ① DECLARED 必须含**未实例化**的声明厂商（旧实现在这条上必然失败）
 *   ② 可用性判定与 ProviderManager 同源：有 env key ⇒ ready；没有 ⇒ no-key ＋ 指名缺哪个键
 *   ③ 声明缺 baseUrl（工厂建不出来）⇒ 显式 NO-FACTORY，而不是静默消失
 *   ④ loader 未初始化时降级：实例层照常输出，不整段失败
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createListProvidersTool } from './provider.js';
import { ProviderRouter } from '../../provider/router.js';
import { ProviderConfigLoader, __setProviderConfigLoaderForTest } from '../../provider/config.js';

const KEY_A = 'HX_TEST_LISTPROV_KEY_A';
const KEY_B = 'HX_TEST_LISTPROV_KEY_B';

let tmpDir: string;

/** 写一份临时 providers.json；返回路径（不碰 ~/.agent 真配置） */
function writeProviders(providers: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'providers.json');
  fs.writeFileSync(p, JSON.stringify({ providers }, null, 2), 'utf-8');
  return p;
}

/** 注入指向临时文件的 loader 单例（须 await —— load() 是异步的，未 await 会读到 DEFAULT_PROVIDERS） */
async function useLoader(configPath: string): Promise<void> {
  const loader = new ProviderConfigLoader(process.cwd(), configPath);
  await loader.load();
  __setProviderConfigLoaderForTest(loader);
}

/** 只注册"已实例化"的假 provider —— 复现 router 的窄视角 */
function makeRouter(loaded: string[], defaultName?: string): ProviderRouter {
  const router = new ProviderRouter();
  for (const name of loaded) {
    router.register(name, {
      getProviderType: () => name,
      getModel: () => `${name}-model`,
      getCapabilities: () => ({ isLocal: false }),
    } as never);
  }
  if (defaultName) router.setDefault(defaultName);
  return router;
}

/** 用**非内置** id，确保走 JSON 声明工厂（内置 id 的可用性判定会用内置 meta.envKey） */
function declaredVendor(id: string, envKey: string, withBaseUrl = true): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id,
    name: id,
    defaultModel: `${id}-default`,
    envKey,
    protocol: 'openai',
  };
  if (withBaseUrl) meta.baseUrl = 'https://example.invalid/v1';
  return meta;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-listprov-'));
  delete process.env[KEY_A];
  delete process.env[KEY_B];
});

afterEach(() => {
  __setProviderConfigLoaderForTest(undefined);
  delete process.env[KEY_A];
  delete process.env[KEY_B];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('list_providers 工具', () => {
  it('① DECLARED 含未实例化的声明厂商，并指名缺哪个环境变量', async () => {
    await useLoader(writeProviders({
      'hx-ready': declaredVendor('hx-ready', KEY_A),
      'hx-nokey': declaredVendor('hx-nokey', KEY_B),
    }));
    process.env[KEY_A] = 'present';
    // 只实例化了 hx-ready —— hx-nokey 在旧实现里根本不会出现
    const out = await createListProvidersTool(makeRouter(['hx-ready'])).execute({});

    expect(out).toContain('DECLARED (2)');
    expect(out).toContain('hx-nokey');            // ← 核心：声明了就必须看得见
    expect(out).toContain('no-key');
    expect(out).toContain(`needs ${KEY_B}`);
    expect(out).toContain('hx-ready');
    expect(out).toContain('ready');
  });

  it('② 有 env key ⇒ ready，并显示声明里的 defaultModel', async () => {
    await useLoader(writeProviders({ 'hx-a': declaredVendor('hx-a', KEY_A) }));
    process.env[KEY_A] = 'present';

    const out = await createListProvidersTool(makeRouter([])).execute({});

    expect(out).toMatch(/hx-a\s+ready/);
    expect(out).toContain('default=hx-a-default');
    expect(out).not.toContain('no-key');
  });

  it('③ 声明缺 baseUrl ⇒ NO-FACTORY（不静默消失）', async () => {
    await useLoader(writeProviders({ 'hx-broken': declaredVendor('hx-broken', KEY_A, false) }));

    const out = await createListProvidersTool(makeRouter([])).execute({});

    expect(out).toContain('hx-broken');
    expect(out).toContain('NO-FACTORY');
    expect(out).toContain('DECLARED (1)');
  });

  it('④ LOADED 只列已实例化的，active 标 *（声明层与实例层互不冒充）', async () => {
    await useLoader(writeProviders({ 'hx-a': declaredVendor('hx-a', KEY_A) }));
    const router = makeRouter(['hx-a', 'hx-extra'], 'hx-extra');

    const out = await createListProvidersTool(router).execute({});

    expect(out).toContain('LOADED (2)');
    expect(out).toContain('* hx-extra');   // active = setDefault 指定的那个
    // hx-extra 未声明 ⇒ 只在 LOADED 出现，不污染 DECLARED
    expect(out).toContain('DECLARED (1)');
    expect(out).toContain('Route mode: manual');
  });

  it('⑤ loader 未初始化时降级：实例层照常输出，不整段失败', async () => {
    __setProviderConfigLoaderForTest(undefined);

    const out = await createListProvidersTool(makeRouter(['solo'])).execute({});

    expect(out).toContain('LOADED (1)');
    expect(out).toContain('solo');
    expect(out).toContain('声明层不可用');
  });

  it('⑥ active 标记须落到声明层（router 存的是通道名，按实例类型对齐）', async () => {
    await useLoader(writeProviders({ 'hx-live': declaredVendor('hx-live', KEY_A) }));
    process.env[KEY_A] = 'present';

    // 复现真实形态：router 注册名是"通道名"，其厂商类型才是 hx-live
    const router = new ProviderRouter();
    router.register('main', {
      getProviderType: () => 'hx-live',
      getModel: () => 'hx-live-model',
      getCapabilities: () => ({ isLocal: false }),
    } as never);
    router.setDefault('main');

    const out = await createListProvidersTool(router).execute({});

    expect(out).toMatch(/\* hx-live\s+ready/);                  // 声明层拿到了 *
    expect(out).toContain('* main -> hx-live/hx-live-model');   // 实例层标出"通道名 → 厂商/模型"
  });
});
