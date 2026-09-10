// ============================================================
// UI 协议层 — 陪伴模式域测试
// ============================================================
// 覆盖：
//  1. companion.get 返回当前状态（active/character/characters）
//  2. companion.activate 从 normal 进入陪伴模式（走 syncRouter）
//  3. companion.activate 已激活同角色 → 幂等返回
//  4. companion.activate 已激活但换角色 → 手动 onDeactivate→onActivate
//  5. companion.deactivate 切回 normal（走 syncRouter）
//  6. 重复 activate/deactivate 幂等
//  7. 后端组件缺失 → get 优雅降级 / activate 报错
//  8. 音色库 / 生成语音 / 台词历史（P5-2：全部经注入接口，不落真实 ~/.agent/）
// ============================================================
//
// Fake 设计：模拟真实的 Router 生命周期闭环
//   - makeRouterSim 构造 normal / companion 两个 Router 模拟对象
//   - makeLoop 的 syncRouter 复刻 loop.ts 的真实行为：
//     读全局名（state.activeName）→ 与 loop.activeRouter.name 不同
//     → onDeactivate → 切换 activeRouter → onActivate
//   - makeRouter 的 switchRouter 设置 state.activeName（全局副作用）
//
// P5-2 纯净化：协议层不再直读 ~/.agent/companion / 不再 import 全局单例，
// 所有业务依赖经 createCompanionDomain 注入（mgr.listCharacters /
// getLastCharacter / setLastCharacter；voice 库注入临时实例；makeVoiceUrl 注入）。
// 因此测试不再需要 mock node:os —— home 目录完全不参与。
// ============================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createCompanionDomain, type CompanionMgrLike, type RouterSwitcherLike, type CompanionLoopLike, type SceneReaderLike } from './companion.js';
import { VoiceLibrary } from '../../companion/voice-library.js';
import { SayHistoryStore } from '../../companion/say-history.js';
import { GeneratedVoiceStore } from '../../companion/voice-store.js';

// ── Fake 后端 ──────────────────────────────────────────────

interface FakeLoopCalls {
  switchSession: string[];
  setActiveUserId: string[];
  deactivateAll: number;
}

interface FakeRouterState {
  /** 全局激活的 Router 名（switchRouter 的副作用） */
  activeName: string;
  onActivateCalled: boolean;
  onDeactivateCalled: boolean;
  clearPromptCacheCalled: boolean;
}

/** Router 模拟对象（IContextRouter 最小结构） */
interface RouterSim {
  name: string;
  activeCompanionName: string;
  onActivate?(loop: unknown): Promise<void>;
  onDeactivate?(loop: unknown): Promise<void>;
}

function makeRouterSims(state: FakeRouterState, calls: FakeLoopCalls): { normal: RouterSim; companion: RouterSim } {
  const companion: RouterSim = {
    name: 'companion',
    activeCompanionName: '',
    onActivate: async (loop: unknown) => {
      state.onActivateCalled = true;
      const l = loop as CompanionLoopLike;
      // 模拟真实 CompanionRouter.onActivate：切换 session + 激活 bypass
      await l.switchSession('/tmp/companion/' + companion.activeCompanionName);
      await l.bypassManager?.activateForMode('companion');
    },
    onDeactivate: async (loop: unknown) => {
      state.onDeactivateCalled = true;
      const l = loop as CompanionLoopLike;
      // 模拟真实 CompanionRouter.onDeactivate：停用 bypass
      await l.bypassManager?.deactivateAll();
    },
  };
  const normal: RouterSim = {
    name: 'normal',
    activeCompanionName: '',
    // 真实 NormalRouter 没有生命周期钩子
  };
  return { normal, companion };
}

function makeLoop(
  sims: { normal: RouterSim; companion: RouterSim },
  state: FakeRouterState,
  calls: FakeLoopCalls,
): CompanionLoopLike {
  const loop: CompanionLoopLike = {
    sessionDir: '/tmp/fake-session',
    switchSession: async (dir) => { calls.switchSession.push(dir); },
    setActiveUserId: (id) => { calls.setActiveUserId.push(id); },
    bypassManager: {
      activateForMode: async () => {},
      deactivateAll: async () => { calls.deactivateAll += 1; },
      getAgent: () => undefined,
      register: () => {},
    },
    activeRouter: state.activeName === 'companion' ? sims.companion : sims.normal,
    syncRouter: async () => {
      // 复刻 loop.ts syncRouter：读全局名，与 activeRouter.name 不一致才切换
      const target = state.activeName === 'companion' ? sims.companion : sims.normal;
      if (loop.activeRouter.name === target.name) return;
      await loop.activeRouter.onDeactivate?.(loop);
      loop.activeRouter = target;
      await target.onActivate?.(loop);
    },
  };
  return loop;
}

function makeRouter(
  sims: { normal: RouterSim; companion: RouterSim },
  state: FakeRouterState,
): RouterSwitcherLike {
  return {
    switchRouter: (name) => {
      state.activeName = name; // 副作用：设全局激活名
      return name === 'companion' ? sims.companion : sims.normal;
    },
    getActiveRouterName: () => state.activeName,
    clearPromptCache: () => { state.clearPromptCacheCalled = true; },
  };
}

function makeMgr(characters: string[] = ['test-char'], lastCharacter = ''): CompanionMgrLike {
  return {
    setCharacter: () => {},
    getOrCreate: () => '/tmp/companion/test-char',
    listCharacters: () => characters,
    getLastCharacter: () => lastCharacter,
    setLastCharacter: () => {},
  };
}

/** 完整后端：loop + router + mgr 共享同一状态，构成闭环 */
function makeBackend(initName: 'normal' | 'companion' = 'normal') {
  const state: FakeRouterState = {
    activeName: initName,
    onActivateCalled: false,
    onDeactivateCalled: false,
    clearPromptCacheCalled: false,
  };
  const calls: FakeLoopCalls = {
    switchSession: [],
    setActiveUserId: [],
    deactivateAll: 0,
  };
  const sims = makeRouterSims(state, calls);
  const loop = makeLoop(sims, state, calls);
  const router = makeRouter(sims, state);
  return { state, calls, loop, router };
}

// ── 测试基础设施 ───────────────────────────────────────────

function setup(
  loop: CompanionLoopLike | null,
  mgr: CompanionMgrLike | null,
  router: RouterSwitcherLike | null,
  voiceLib?: VoiceLibrary,
  voiceGenStore?: GeneratedVoiceStore,
  sayStore?: SayHistoryStore,
  makeVoiceUrl?: (id: string) => string,
  sceneReader?: SceneReaderLike | null,
  makeSceneUrl?: (character: string) => string,
) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('companion', createCompanionDomain({
    getLoop: () => loop,
    getCompanionMgr: () => mgr,
    getRouterSwitcher: () => router,
    // P5-2：协议层不持有实现，全部经注入；null = 不支持 voice/sayHistory 动作
    getVoiceLibrary: () => voiceLib ?? null,
    getVoiceGenStore: () => voiceGenStore ?? null,
    getSayHistoryStore: () => sayStore ?? null,
    getSceneReader: () => sceneReader ?? null,
    keepPerCharacter: 300,
    ...(makeVoiceUrl ? { makeVoiceUrl } : {}),
    ...(makeSceneUrl ? { makeSceneUrl } : {}),
  }));
  server.attach(serverAdp);

  const responses: unknown[] = [];
  client.onMessage((m) => { responses.push(m); });
  const wait = async (id: string, timeout = 2000): Promise<unknown> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) =>
        r && typeof r === 'object' && 'id' in r && (r as Record<string, unknown>).id === id
      );
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  return { client, wait };
}

// ── 语音库（真实实现 + 临时目录）───────────────────────────
// 协议层只负责把库数据映射成 UI 契约，因此用真实库实例验证接线与返回格式；
// 走临时目录，避免读写真实 ~/.agent/companion/。
function makeVoiceLibs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvlib-'));
  const lib = new VoiceLibrary(path.join(root, 'voices'));
  const store = new GeneratedVoiceStore(path.join(root, 'generated'));
  const srcDir = fs.mkdtempSync(path.join(root, 'src-'));
  // 参考音频：register 要求 ≥1KB
  const wav = path.join(srcDir, 'rourou.wav');
  fs.writeFileSync(wav, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(2048)]));
  lib.register(wav, { id: 'v_rourou', desc: '柔柔默认' });
  return { lib, store, srcDir, wav, root };
}

// ── 测试用例 ───────────────────────────────────────────────

describe('Companion 域', () => {
  it('companion.get 返回 inactive 状态和可用角色列表', async () => {
    const { state, calls, loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr(['alice', 'bob']), router);

    client.send({ kind: 'request', id: 'g1', method: 'companion.get' });
    const res = await wait('g1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      active: false,
      character: '',
      characters: ['alice', 'bob'],
    });
    // get 不应产生任何切换副作用
    expect(state.activeName).toBe('normal');
    expect(state.onActivateCalled).toBe(false);
    expect(calls.switchSession).toEqual([]);
  });

  it('companion.get 在激活后返回 active + 角色名', async () => {
    const { loop, router } = makeBackend('companion');
    // 预置角色名
    (loop.activeRouter as { activeCompanionName: string }).activeCompanionName = 'alice';
    const { client, wait } = setup(loop, makeMgr(['alice']), router);

    client.send({ kind: 'request', id: 'g2', method: 'companion.get' });
    const res = await wait('g2') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect((res.result as Record<string, unknown>).active).toBe(true);
    expect((res.result as Record<string, unknown>).character).toBe('alice');
  });

  it('companion.activate 从 normal 进入陪伴模式（走 syncRouter）', async () => {
    const { state, calls, loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr(['alice']), router);

    client.send({ kind: 'request', id: 'a1', method: 'companion.activate', params: { character: 'alice' } });
    const res = await wait('a1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ active: true, character: 'alice' });
    // 完整切换闭环：switchRouter 设全局名 → syncRouter → onActivate → session 切换
    expect(state.activeName).toBe('companion');
    expect(state.onActivateCalled).toBe(true);
    expect(calls.switchSession).toEqual(['/tmp/companion/alice']);
    // 切换后清 prompt 缓存 + 记住角色
    expect(state.clearPromptCacheCalled).toBe(true);
  });

  it('companion.activate 自动选择角色（参数缺省时）', async () => {
    // P5-2：角色列表来自注入的 mgr.listCharacters（协议层不再直读 ~/.agent/companion）
    const { state, loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr(['solo-char']), router);

    client.send({ kind: 'request', id: 'a2', method: 'companion.activate' });
    const res = await wait('a2') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    // 角色名来源：参数 > .last-character（makeMgr 缺省 ''）> 唯一可用角色（注入列表）
    expect((res.result as Record<string, unknown>).character).toBe('solo-char');
    expect(state.onActivateCalled).toBe(true);
  });

  it('companion.activate 已激活且同角色 → 幂等返回', async () => {
    const { state, calls, loop, router } = makeBackend('companion');
    (loop.activeRouter as { activeCompanionName: string }).activeCompanionName = 'alice';
    const { client, wait } = setup(loop, makeMgr(['alice']), router);

    client.send({ kind: 'request', id: 'a3', method: 'companion.activate', params: { character: 'alice' } });
    const res = await wait('a3') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ active: true, character: 'alice' });
    // 幂等：不触发任何生命周期钩子
    expect(state.onActivateCalled).toBe(false);
    expect(state.onDeactivateCalled).toBe(false);
    expect(calls.switchSession).toEqual([]);
  });

  it('companion.activate 已激活但换角色 → 手动 onDeactivate → 设名字 → onActivate', async () => {
    const { state, calls, loop, router } = makeBackend('companion');
    (loop.activeRouter as { activeCompanionName: string }).activeCompanionName = 'alice';
    const { client, wait } = setup(loop, makeMgr(['alice', 'bob']), router);

    client.send({ kind: 'request', id: 'a4', method: 'companion.activate', params: { character: 'bob' } });
    const res = await wait('a4') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ active: true, character: 'bob' });
    // 换角色必须手动触发完整生命周期（syncRouter 同名直接 return，无法换角色）
    expect(state.onDeactivateCalled).toBe(true);
    expect(state.onActivateCalled).toBe(true);
    // 最后切到新角色 session
    expect(calls.switchSession[calls.switchSession.length - 1]).toBe('/tmp/companion/bob');
    // Router 上已更新新角色名
    expect((loop.activeRouter as { activeCompanionName: string }).activeCompanionName).toBe('bob');
  });

  it('companion.deactivate 切回 normal（走 syncRouter）', async () => {
    const { state, calls, loop, router } = makeBackend('companion');
    (loop.activeRouter as { activeCompanionName: string }).activeCompanionName = 'alice';
    const { client, wait } = setup(loop, makeMgr(['alice']), router);

    client.send({ kind: 'request', id: 'd1', method: 'companion.deactivate' });
    const res = await wait('d1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ active: false });
    // switchRouter('normal') → syncRouter 触发 companion.onDeactivate（停 bypass）
    expect(state.activeName).toBe('normal');
    expect(state.onDeactivateCalled).toBe(true);
    expect(calls.deactivateAll).toBeGreaterThan(0);
    expect(state.clearPromptCacheCalled).toBe(true);
  });

  it('companion.deactivate 幂等（未激活时直接返回）', async () => {
    const { state, calls, loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr([]), router);

    client.send({ kind: 'request', id: 'd2', method: 'companion.deactivate' });
    const res = await wait('d2') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ active: false });
    expect(state.onDeactivateCalled).toBe(false);
    expect(calls.deactivateAll).toBe(0);
  });

  it('companion.activate 信任调用者传入的角色名（不做存在性校验）', async () => {
    const { state, loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr([]), router);

    client.send({ kind: 'request', id: 'e1', method: 'companion.activate', params: { character: 'nonexistent-char' } });
    const res = await wait('e1') as Record<string, unknown>;

    // 与 companion_mode 工具一致：角色名由调用方保证，激活流程不校验 persona 是否存在
    expect(res.ok).toBe(true);
    expect((res.result as Record<string, unknown>).character).toBe('nonexistent-char');
    expect(state.onActivateCalled).toBe(true);
  });

  it('后端组件缺失 → companion.get 优雅降级返回 inactive', async () => {
    const { client, wait } = setup(null, null, null);

    client.send({ kind: 'request', id: 'f1', method: 'companion.get' });
    const res = await wait('f1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const result = res.result as Record<string, unknown>;
    expect(result.active).toBe(false);
    expect(result.character).toBe('');
    // characters 可能从真实 FS 扫到（测试环境可能有 ~/.agent/companion/*），只验证是数组
    expect(Array.isArray(result.characters)).toBe(true);
  });

  it('后端组件缺失 → companion.activate 报错', async () => {
    const { client, wait } = setup(null, null, null);

    client.send({ kind: 'request', id: 'f2', method: 'companion.activate' });
    const res = await wait('f2') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    const err = res.error as { code: string; message: string };
    expect(err.message).toBeTruthy();
    expect(err.message).toContain('not supported');
  });

  // ── 语音动作：voices / voiceBind / voiceList ──────────────

  it('companion.voices 返回音色库条目（注入实例，不落真实目录）', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({ kind: 'request', id: 'v1', method: 'companion.voices' });
    const res = await wait('v1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const voices = (res.result as { voices: Array<{ id: string; desc?: string }> }).voices;
    expect(voices.map((v) => v.id)).toContain('v_rourou');
  });

  it('companion.voiceBind 绑定角色默认音色（写回注入的音色库）', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({
      kind: 'request', id: 'v2', method: 'companion.voiceBind',
      params: { voiceId: 'v_rourou', character: '柔柔' },
    });
    const res = await wait('v2') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ ok: true, voiceId: 'v_rourou', character: '柔柔' });
    // 绑定确实写回了注入的实例
    expect(lib.resolveForCharacter('柔柔')?.id).toBe('v_rourou');
    expect(lib.list().find((v) => v.id === 'v_rourou')?.bind).toBe('柔柔');
  });

  it('companion.voiceBind 缺参数 → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({
      kind: 'request', id: 'v3', method: 'companion.voiceBind',
      params: { voiceId: 'v_rourou' }, // 缺 character
    });
    const res = await wait('v3') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });

  it('companion.voiceList 返回生成语音（含可播放 URL，按角色隔离）', async () => {
    const { loop, router } = makeBackend('normal');
    const { store, srcDir, wav } = makeVoiceLibs();
    const row = store.insert(wav, {
      character: '柔柔', textNorm: '你回来啦', textHash: 'h1', emotionKey: 'happy',
      voiceId: 'v_rourou', provider: 'indextts', format: 'wav', byteSize: 2048,
    });
    // 别的角色的语音不应串进柔柔的列表
    const otherSrc = path.join(srcDir, 'other.wav');
    fs.writeFileSync(otherSrc, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(2048)]));
    store.insert(otherSrc, {
      character: '小蝶', textNorm: '别的一句话', textHash: 'h2',
      voiceId: 'v_rourou', provider: 'indextts', format: 'wav', byteSize: 2048,
    });

    // P5-2：URL 由注入的 makeVoiceUrl 生成（协议层不硬编码 HTTP 路由）
    const makeVoiceUrl = (id: string) => `/api/companion/voice/${id}/file`;
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, store, undefined, makeVoiceUrl);
    client.send({
      kind: 'request', id: 'v4', method: 'companion.voiceList',
      params: { character: '柔柔' },
    });
    const res = await wait('v4') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const out = res.result as {
      character: string;
      voices: Array<{ id: string; text: string; emotion: string; url: string }>;
    };
    expect(out.character).toBe('柔柔');
    expect(out.voices).toHaveLength(1);
    expect(out.voices[0].text).toBe('你回来啦');
    expect(out.voices[0].emotion).toBe('happy');
    // URL 契约：前端直接拿它播（对应 /api/companion/voice/:id/file 端点）
    expect(out.voices[0].url).toBe(`/api/companion/voice/${row.id}/file`);
  });

  it('companion.voiceList 缺 character → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const { store } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, store);

    client.send({ kind: 'request', id: 'v5', method: 'companion.voiceList' });
    const res = await wait('v5') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });

  // ── 台词历史：companion.sayHistory ─────────────────────────
  it('companion.sayHistory 返回台词历史（倒序、按角色隔离）', async () => {
    const { loop, router } = makeBackend('normal');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sayhist-'));
    const sayStore = new SayHistoryStore(root);
    sayStore.append({ sayId: 's1', character: 'alice', mode: 'speak', text: '你好', at: '2026-08-31T10:00:00Z' });
    sayStore.append({ sayId: 's2', character: 'alice', mode: 'speak', text: '今天天气不错', think: '她心情好', at: '2026-08-31T10:01:00Z' });
    sayStore.append({ sayId: 's3', character: 'bob', mode: 'speak', text: 'bob 的话', at: '2026-08-31T10:02:00Z' });
    const { client, wait } = setup(loop, makeMgr(['alice']), router, undefined, undefined, sayStore);

    client.send({ kind: 'request', id: 'sh1', method: 'companion.sayHistory', params: { character: 'alice' } });
    const res = await wait('sh1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const out = res.result as { character: string; entries: Array<{ sayId: string; text: string; think?: string }> };
    expect(out.character).toBe('alice');
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0].sayId).toBe('s2'); // 倒序
    expect(out.entries[0].think).toBe('她心情好');
  });

  it('companion.sayHistory 缺 character → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sayhist-'));
    const sayStore = new SayHistoryStore(root);
    const { client, wait } = setup(loop, makeMgr(['alice']), router, undefined, undefined, sayStore);

    client.send({ kind: 'request', id: 'sh2', method: 'companion.sayHistory' });
    const res = await wait('sh2') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });

  // ── 音色库管理（原 voice_manage 工具的能力，收回后改由用户经 UI 操作）──

  it('companion.voiceRegister 登记音色（复制音频进库，可同时绑定角色）', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib, wav } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({
      kind: 'request', id: 'vr1', method: 'companion.voiceRegister',
      params: { path: wav, id: 'v_new', desc: '测试音色', character: '柔柔' },
    });
    const res = await wait('vr1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const voice = (res.result as { voice: { id: string; bind?: string } }).voice;
    expect(voice.id).toBe('v_new');
    expect(voice.bind).toBe('柔柔');
    // 音频真的复制进库目录，且成为该角色默认音色
    expect(lib.get('v_new')).toBeTruthy();
    expect(fs.existsSync(path.join(lib.voicesDir, 'v_new.wav'))).toBe(true);
    expect(lib.resolveForCharacter('柔柔')?.id).toBe('v_new');
  });

  it('companion.voiceRegister 缺 path → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({
      kind: 'request', id: 'vr2', method: 'companion.voiceRegister',
      params: { id: 'x' },
    });
    const res = await wait('vr2') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });

  it('companion.voiceDelete 删除音色（索引与音频文件一并移除）', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib } = makeVoiceLibs();
    expect(lib.get('v_rourou')).toBeTruthy();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib);

    client.send({
      kind: 'request', id: 'vd1', method: 'companion.voiceDelete',
      params: { id: 'v_rourou' },
    });
    const res = await wait('vd1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(lib.get('v_rourou')).toBeUndefined();
    expect(fs.existsSync(path.join(lib.voicesDir, 'v_rourou.wav'))).toBe(false);
  });

  it('companion.voiceStats 返回两个库的容量统计', async () => {
    const { loop, router } = makeBackend('normal');
    const { lib, store, wav } = makeVoiceLibs();
    store.insert(wav, {
      character: '柔柔', textNorm: '你回来啦', textHash: 'hs1',
      provider: 'indextts', format: 'wav', byteSize: 2048,
    });
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, lib, store);

    client.send({ kind: 'request', id: 'vs1', method: 'companion.voiceStats' });
    const res = await wait('vs1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const out = res.result as {
      voices: { count: number; totalBytes: number; entries: Array<{ id: string; bytes: number }> };
      generated: {
        count: number;
        totalBytes: number;
        byCharacter: Array<{ character: string; count: number; bytes: number }>;
      };
      keepPerCharacter: number;
    };
    // 音色库：预登记的 1 个，字节数 > 0（真实文件）
    expect(out.voices.count).toBe(1);
    expect(out.voices.entries[0].bytes).toBeGreaterThan(0);
    // 生成语音库：1 条 2048 字节，按角色聚合
    expect(out.generated.count).toBe(1);
    expect(out.generated.totalBytes).toBe(2048);
    expect(out.generated.byCharacter).toEqual([{ character: '柔柔', count: 1, bytes: 2048 }]);
    expect(out.keepPerCharacter).toBeGreaterThan(0);
  });

  it('companion.voicePrune 按角色保留最近 N 条（返回删除数与剩余数）', async () => {
    const { loop, router } = makeBackend('normal');
    const { store, srcDir } = makeVoiceLibs();
    for (const [i, hash] of ['p1', 'p2', 'p3'].entries()) {
      const p = path.join(srcDir, `pr${i}.wav`);
      fs.writeFileSync(p, Buffer.concat([Buffer.from('RIFF0000WAVEfmt '), Buffer.alloc(2048)]));
      store.insert(p, {
        character: '柔柔', textNorm: `第${i}句`, textHash: hash,
        provider: 'indextts', format: 'wav', byteSize: 2048,
      });
    }
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, store);

    client.send({
      kind: 'request', id: 'vp1', method: 'companion.voicePrune',
      params: { character: '柔柔', keep: 1 },
    });
    const res = await wait('vp1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ ok: true, character: '柔柔', keep: 1, removed: 2, remaining: 1 });
  });

  it('companion.voicePrune 缺 character → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const { store } = makeVoiceLibs();
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, store);

    client.send({
      kind: 'request', id: 'vp2', method: 'companion.voicePrune',
      params: { keep: 1 },
    });
    const res = await wait('vp2') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });

  // ── companion.scene（场景元数据 · 只读）────────────────────────
  // 读取类语义：缺 reader / 无场景文件 → 返回 null（降级，前端回落默认背景），
  // 不报错；imageUrl 由注入的 makeSceneUrl 构造（协议层不硬编码路由）。

  it('companion.scene 返回场景元数据 + 注入构造的 imageUrl', async () => {
    const { loop, router } = makeBackend('normal');
    const reader: SceneReaderLike = {
      read: () => ({ signature: 'abc123', prompt: '雨夜书房', provider: 'volc', createdAt: '2026-09-01T00:00:00Z' }),
    };
    const makeSceneUrl = (character: string) => `/api/companion/${encodeURIComponent(character)}/scene.png`;
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, undefined, undefined, undefined, reader, makeSceneUrl);

    client.send({
      kind: 'request', id: 'sc1', method: 'companion.scene',
      params: { character: '柔柔' },
    });
    const res = await wait('sc1') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      signature: 'abc123',
      prompt: '雨夜书房',
      provider: 'volc',
      createdAt: '2026-09-01T00:00:00Z',
      imageUrl: '/api/companion/%E6%9F%94%E6%9F%94/scene.png',
    });
  });

  it('companion.scene 无场景文件（reader 返回 null）→ 返回 null', async () => {
    const { loop, router } = makeBackend('normal');
    const reader: SceneReaderLike = { read: () => null };
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, undefined, undefined, undefined, reader);

    client.send({
      kind: 'request', id: 'sc2', method: 'companion.scene',
      params: { character: '柔柔' },
    });
    const res = await wait('sc2') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
  });

  it('companion.scene 缺 reader（降级）→ 返回 null 不报错', async () => {
    const { loop, router } = makeBackend('normal');
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router);

    client.send({
      kind: 'request', id: 'sc3', method: 'companion.scene',
      params: { character: '柔柔' },
    });
    const res = await wait('sc3') as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
  });

  it('companion.scene 缺 character → 报错', async () => {
    const { loop, router } = makeBackend('normal');
    const reader: SceneReaderLike = {
      read: () => ({ signature: 's', prompt: 'p', provider: 'v', createdAt: 't' }),
    };
    const { client, wait } = setup(loop, makeMgr(['柔柔']), router, undefined, undefined, undefined, undefined, reader);

    client.send({
      kind: 'request', id: 'sc4', method: 'companion.scene',
      params: {},
    });
    const res = await wait('sc4') as Record<string, unknown>;

    expect(res.ok).toBe(false);
    expect((res.error as { message: string }).message).toContain('requires');
  });
});
