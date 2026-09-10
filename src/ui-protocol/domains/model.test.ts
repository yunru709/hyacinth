// ============================================================
// UI 协议层 — 模型域测试
// ============================================================
// 用 mock ModelRegistryLike + ProviderManagerLike 验证：
//  1. model.getActive → 当前 provider/model + 能力
//  2. model.listProviders → 提供商列表 + active 标记
//  3. model.switch → 调 manager.switchProvider + registry.setChannelModel + 发事件
//  4. model.setThinking → 转发 registry.setThinking
//  5. model.listChannels → 返回通道列表
//  6. model.upsertChannel → 后 list 反映
//  7. model.setChannelModel → 生效（registry 更新）
//  8. model.removeChannel → main 不可删
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createModelDomain } from './model.js';
import type {
  ChannelConfigLike,
  ChannelInfoLike,
  ModelRegistryLike,
  ProviderManagerLike,
  ProviderMetaLike,
  ProviderView,
} from './model.js';
import type { UiResponse } from '../types.js';

// ── mock 注册表 ────────────────────────────────────────────

class MockRegistry implements ModelRegistryLike {
  channels = new Map<string, ChannelConfigLike & { name: string }>();
  thinkingCalls: Array<{ enabled: boolean; effort?: string | number }> = [];
  mainProviderType = 'anthropic';
  mainModel = 'claude-sonnet-5';

  constructor() {
    this.channels.set('main', { name: 'main', provider: 'anthropic', model: 'claude-sonnet-5', description: 'Main' });
    this.channels.set('compression', { name: 'compression', provider: 'deepseek', model: 'deepseek-v4-flash' });
  }

  listChannels(): Array<ChannelConfigLike & { name: string }> {
    return [...this.channels.values()];
  }
  upsertChannel(name: string, config: ChannelConfigLike): void {
    this.channels.set(name, { name, ...config });
  }
  removeChannel(name: string): void {
    this.channels.delete(name);
  }
  setChannelModel(name: string, provider: string, model?: string): void {
    const existing = this.channels.get(name) ?? { name };
    this.channels.set(name, { ...existing, name, provider, ...(model ? { model } : {}) });
    if (name === 'main') {
      this.mainProviderType = provider;
      this.mainModel = model ?? this.mainModel;
    }
  }
  resetChannelModel(_name: string): void {
    // no-op in mock
  }
  getChannelInfo(name: string): ChannelInfoLike | null {
    const c = this.channels.get(name);
    if (!c) return null;
    return {
      name,
      provider: c.provider ?? '',
      model: c.model ?? '',
      description: c.description,
      roles: [],
      isMain: name === 'main',
      providerType: c.provider ?? '',
    };
  }
  getMainProvider(): ProviderView | null {
    return {
      getProviderType: () => this.mainProviderType,
      getModel: () => this.mainModel,
      getCapabilities: () => ({ isLocal: false, maxContextTokens: 200000 }),
    };
  }
  getProviderType(): string {
    return this.mainProviderType;
  }
  getModel(): string {
    return this.mainModel;
  }
  setThinking(enabled: boolean, effort?: string | number): void {
    this.thinkingCalls.push({ enabled, effort });
  }
  roles = new Map<string, string>();
  roleCalls: Array<{ role: string; channel: string }> = [];
  listRoles(): Record<string, string> {
    return Object.fromEntries(this.roles);
  }
  setRoleMapping(role: string, channelName: string): void {
    this.roleCalls.push({ role, channel: channelName });
    this.roles.set(role, channelName);
  }
}

class MockManager implements ProviderManagerLike {
  switches: Array<{ type: string; model?: string; apiKey?: string; baseUrl?: string }> = [];
  switchProvider(config: { type: string; model?: string; apiKey?: string; baseUrl?: string }): void {
    this.switches.push(config);
  }
}

const PROVIDERS_META: ProviderMetaLike[] = [
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5' },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.5' },
  { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-v4-flash' },
  { id: 'local', name: 'Local (Ollama)', defaultModel: 'qwen3:8b' },
];

function setup(
  getLoop?: () => import('./state.js').LoopLike | null,
  getActiveProvider?: () => ProviderView | null,
  listLocalModels?: () => import('../types.js').LocalModelEntry[],
  localModelOps?: import('./model.js').LocalModelOpsLike,
) {
  const registry = new MockRegistry();
  const manager = new MockManager();
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const domain = createModelDomain({
    registry,
    manager,
    listProvidersMeta: () => PROVIDERS_META,
    listLocalModels,
    localModelOps,
    emit: (type, payload) => server.broadcast(type, payload),
    getLoop,
    getActiveProvider,
  });
  server.registerDomain('model', domain);
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  const events: { type: string; payload?: unknown }[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push({ type: m.type, payload: m.payload });
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { registry, manager, client, server, domain, responses, events, flush };
}

describe('模型域', () => {
  it('model.getActive 返回当前 provider/model + 能力', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'model.getActive' });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(responses[0].result).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      isLocal: false,
      maxContextTokens: 200000,
    });
  });

  it('model.listProviders 返回提供商列表 + 当前活跃标记', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'model.listProviders' });
    await flush();
    const providers = (responses[0].result as any).providers;
    expect(providers).toHaveLength(4);
    expect(providers.find((p: any) => p.type === 'anthropic').active).toBe(true);
    expect(providers.find((p: any) => p.type === 'openai').active).toBe(false);
    expect(providers.find((p: any) => p.type === 'local').isLocal).toBe(true);
  });

  it('model.listProviders 标记 configured（envKey 环境变量非空 / 本地无 envKey）', async () => {
    const { client, responses, flush } = setup();
    // 模拟：deepseek 已配 key，anthropic/openai 未配，local 无 envKey
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const metas: ProviderMetaLike[] = [
        { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-5', envKey: 'ANTHROPIC_API_KEY' },
        { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.5', envKey: 'OPENAI_API_KEY' },
        { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-v4-flash', envKey: 'DEEPSEEK_API_KEY' },
        { id: 'local', name: 'Local (Ollama)', defaultModel: 'qwen3:8b' },
      ];
      const registry = new MockRegistry();
      const manager = new MockManager();
      const client2 = new InProcAdapter('client2');
      const serverAdp2 = new InProcAdapter('server2');
      client2.connect(serverAdp2);
      const server2 = new UiProtocolServer();
      const domain2 = createModelDomain({
        registry, manager, listProvidersMeta: () => metas, listLocalModels: () => [],
      });
      server2.registerDomain('model', domain2);
      server2.attach(serverAdp2);
      const responses2: UiResponse[] = [];
      client2.onMessage((m) => { if (m.kind === 'response') responses2.push(m); });
      client2.send({ kind: 'request', id: 'c1', method: 'model.listProviders' });
      await new Promise((r) => setTimeout(r, 20));
      const providers = (responses2[0].result as any).providers;
      expect(providers.find((p: any) => p.type === 'deepseek').configured).toBe(true);
      expect(providers.find((p: any) => p.type === 'deepseek').status).toBe('configured');
      // anthropic 是 MockRegistry 默认活跃 provider → status active（非 unconfigured）
      expect(providers.find((p: any) => p.type === 'anthropic').status).toBe('active');
      // openai 非活跃且未配置 → unconfigured
      expect(providers.find((p: any) => p.type === 'openai').configured).toBe(false);
      expect(providers.find((p: any) => p.type === 'openai').status).toBe('unconfigured');
      expect(providers.find((p: any) => p.type === 'local').configured).toBe(true); // 本地无 envKey → 视为就绪
      expect(providers.find((p: any) => p.type === 'local').status).toBe('local');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it('model.switch 调 manager.switchProvider + registry 同步 + 发事件', async () => {
    const { registry, manager, client, responses, events, flush } = setup();
    client.send({
      kind: 'request',
      id: 'r1',
      method: 'model.switch',
      params: { provider: 'openai', model: 'gpt-5.5' },
    });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    // manager 收到切换
    expect(manager.switches).toHaveLength(1);
    expect(manager.switches[0]).toMatchObject({ type: 'openai', model: 'gpt-5.5' });
    // registry main 已同步
    expect(registry.getProviderType()).toBe('openai');
    expect(registry.getModel()).toBe('gpt-5.5');
    // 事件
    const evt = events.find((e) => e.type === 'model.change');
    expect(evt).toBeTruthy();
    expect((evt!.payload as any)).toMatchObject({ action: 'switch', provider: 'openai' });
  });

  it('model.switch 在提供 loop.switchProvider 时委托真实 loop（非 registry-only）', async () => {
    const switched: string[] = [];
    const loop = {
      getTurnInfo: () => ({
        turnCount: 0,
        maxTurns: 20,
        tokensUsed: 0,
        maxContextTokens: 200000,
        sessionId: 'sess_1',
        compressCount: 0,
      }),
      getProviderRoutingInfo: () => null,
      getActiveProvider: () => ({ getProviderType: () => 'openai', getModel: () => 'gpt-5.5' }),
      switchProvider: async (name: string) => { switched.push(name); },
    } as unknown as import('./state.js').LoopLike;
    const { registry, manager, client, responses, flush } = setup(() => loop);

    client.send({
      kind: 'request',
      id: 'r1',
      method: 'model.switch',
      params: { provider: 'openai', model: 'gpt-5.5' },
    });
    await flush();

    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    // 委托真实 loop.switchProvider
    expect(switched).toEqual(['openai']);
    // 不 fallback 到假 manager
    expect(manager.switches).toHaveLength(0);
    // registry main 仍同步
    expect(registry.getProviderType()).toBe('openai');
    expect(registry.getModel()).toBe('gpt-5.5');
  });

  it('model.setThinking 转发 registry.setThinking', async () => {
    const { registry, client, responses, flush } = setup();
    client.send({
      kind: 'request',
      id: 'r1',
      method: 'model.setThinking',
      params: { enabled: true, effort: 'high' },
    });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(registry.thinkingCalls).toHaveLength(1);
    expect(registry.thinkingCalls[0]).toEqual({ enabled: true, effort: 'high' });
  });

  it('model.setThinking 在提供 getActiveProvider 时委托真实 provider（非 registry-only）', async () => {
    const providerThinking: Array<{ enabled: boolean; effort?: string | number }> = [];
    const provider = {
      getProviderType: () => 'anthropic',
      getModel: () => 'claude-sonnet-5',
      setThinking: (enabled: boolean, effort?: string | number) => {
        providerThinking.push({ enabled, effort });
      },
    } as ProviderView;
    const { registry, client, responses, events, flush } = setup(undefined, () => provider);

    client.send({
      kind: 'request',
      id: 'r1',
      method: 'model.setThinking',
      params: { enabled: true, effort: 'high' },
    });
    await flush();

    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    // 委托真实 provider.setThinking
    expect(providerThinking).toHaveLength(1);
    expect(providerThinking[0]).toEqual({ enabled: true, effort: 'high' });
    // 不 fallback 到 registry
    expect(registry.thinkingCalls).toHaveLength(0);
    // 事件
    const evt = events.find((e) => e.type === 'model.change');
    expect((evt!.payload as any)).toMatchObject({ action: 'setThinking', enabled: true });
  });

  it('model.listChannels 返回通道列表', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'model.listChannels' });
    await flush();
    const channels = (responses[0].result as any).channels;
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({ name: 'main', provider: 'anthropic' });
    expect(channels[1]).toMatchObject({ name: 'compression', provider: 'deepseek' });
  });

  it('model.upsertChannel 后 listChannels 反映新通道', async () => {
    const { client, responses, flush } = setup();
    // 新增通道
    client.send({
      kind: 'request',
      id: 'u1',
      method: 'model.upsertChannel',
      params: { name: 'sub-agent', provider: 'openai', model: 'gpt-5.4-mini' },
    });
    await flush();
    expect(responses.find((r) => r.id === 'u1')).toMatchObject({ ok: true });

    // list 反映
    client.send({ kind: 'request', id: 'l1', method: 'model.listChannels' });
    await flush();
    const channels = (responses.find((r) => r.id === 'l1')!.result as any).channels;
    expect(channels).toHaveLength(3);
    expect(channels.some((c: any) => c.name === 'sub-agent' && c.provider === 'openai')).toBe(true);
  });

  it('model.setChannelModel 生效（registry 更新）', async () => {
    const { registry, client, responses, flush } = setup();
    client.send({
      kind: 'request',
      id: 'r1',
      method: 'model.setChannelModel',
      params: { name: 'compression', provider: 'deepseek', model: 'deepseek-v4-pro' },
    });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    // registry 已更新
    const info = registry.getChannelInfo('compression');
    expect(info).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  });

  it('model.removeChannel main 不可删除；普通通道可删', async () => {
    const { registry, client, responses, flush } = setup();

    // 删 main → 错误
    client.send({ kind: 'request', id: 'r1', method: 'model.removeChannel', params: { name: 'main' } });
    await flush();
    expect(responses.find((r) => r.id === 'r1')).toMatchObject({ ok: false });
    expect((responses.find((r) => r.id === 'r1')!.error as any).message).toContain('main');

    // 删 compression → 成功
    client.send({ kind: 'request', id: 'r2', method: 'model.removeChannel', params: { name: 'compression' } });
    await flush();
    expect(responses.find((r) => r.id === 'r2')).toMatchObject({ ok: true });
    expect(registry.getChannelInfo('compression')).toBeNull();
  });

  it('model.listLocalModels 返回本地模型列表', async () => {
    const localModels = [
      { name: 'qwen3:8b', modelFile: 'qwen3-8b.q4_k_m.gguf', backend: 'ollama', enabled: true },
      { name: 'llama-3-8b', modelFile: 'llama-3-8b-instruct.Q4_K_M.gguf', backend: 'llama.cpp', enabled: false, ctxSize: 8192 },
    ];
    const { client, responses, flush } = setup(undefined, undefined, () => localModels);
    client.send({ kind: 'request', id: 'r1', method: 'model.listLocalModels' });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    const models = (responses[0].result as any).models;
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ name: 'qwen3:8b', backend: 'ollama', enabled: true });
    expect(models[1]).toMatchObject({ name: 'llama-3-8b', enabled: false });
  });

  it('model.listLocalModels 缺省返回空列表（未注入提供者）', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'model.listLocalModels' });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect((responses[0].result as any).models).toEqual([]);
  });

  it('model.setChannelRole 写入 role→channel 映射并 emit model.change', async () => {
    const { registry, client, responses, events, flush } = setup();
    // 先建一个通道供 role 映射
    client.send({ kind: 'request', id: 'r0', method: 'model.upsertChannel', params: { name: 'compression', provider: 'deepseek', model: 'deepseek-v4-flash' } });
    await flush();
    // 设置 role 映射
    client.send({ kind: 'request', id: 'r1', method: 'model.setChannelRole', params: { role: 'compression', channel: 'compression' } });
    await flush();
    expect(responses.find((r) => r.id === 'r1')).toMatchObject({ ok: true });
    expect(registry.roleCalls).toHaveLength(1);
    expect(registry.roleCalls[0]).toEqual({ role: 'compression', channel: 'compression' });
    expect(registry.listRoles()).toMatchObject({ compression: 'compression' });
    const evt = events.find((e) => e.type === 'model.change' && (e.payload as any)?.action === 'setChannelRole');
    expect((evt!.payload as any)).toMatchObject({ action: 'setChannelRole', role: 'compression', channel: 'compression' });
  });

  it('model.setChannelRole 缺参报错', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'model.setChannelRole', params: { role: 'compression' } });
    await flush();
    expect(responses.find((r) => r.id === 'r1')).toMatchObject({ ok: false });
  });

  it('model.localStart 委托 localModelOps.start', async () => {
    const started: string[] = [];
    const ops = {
      start: async (name: string) => { started.push(name); return { name, state: 'running' }; },
    };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({ kind: 'request', id: 'ls1', method: 'model.localStart', params: { name: 'qwen3:8b' } });
    await flush();
    expect(responses.find((r) => r.id === 'ls1')).toMatchObject({ ok: true });
    expect(started).toEqual(['qwen3:8b']);
  });

  it('model.localStart 缺 name 报错', async () => {
    const ops = { start: async () => ({ name: 'x', state: 'running' }) };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({ kind: 'request', id: 'ls2', method: 'model.localStart', params: {} });
    await flush();
    expect(responses.find((r) => r.id === 'ls2')).toMatchObject({ ok: false });
  });

  it('model.localStop 委托 localModelOps.stop', async () => {
    const stopped: string[] = [];
    const ops = { stop: async (name: string) => { stopped.push(name); } };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({ kind: 'request', id: 'lst1', method: 'model.localStop', params: { name: 'qwen3:8b' } });
    await flush();
    expect(responses.find((r) => r.id === 'lst1')).toMatchObject({ ok: true });
    expect(stopped).toEqual(['qwen3:8b']);
  });

  it('model.localRegister 委托 localModelOps.register（含字段透传）', async () => {
    const registered: Record<string, unknown>[] = [];
    const ops = {
      register: (opts: Record<string, unknown>) => { registered.push(opts); return { name: opts.name }; },
    };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({
      kind: 'request', id: 'reg1', method: 'model.localRegister',
      params: { name: 'my-model', modelFile: 'models/my-model.gguf', backend: 'llama.cpp', ctxSize: 8192 },
    });
    await flush();
    expect(responses.find((r) => r.id === 'reg1')).toMatchObject({ ok: true });
    expect(registered[0]).toMatchObject({ name: 'my-model', modelFile: 'models/my-model.gguf', ctxSize: 8192 });
  });

  it('model.localUnregister 委托 localModelOps.unregister', async () => {
    const unregistered: string[] = [];
    const ops = { unregister: (name: string) => { unregistered.push(name); return true; } };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({ kind: 'request', id: 'unreg1', method: 'model.localUnregister', params: { name: 'my-model' } });
    await flush();
    expect(responses.find((r) => r.id === 'unreg1')).toMatchObject({ ok: true });
    expect(unregistered).toEqual(['my-model']);
  });

  it('model.localScan 委托 localModelOps.scanUnregistered', async () => {
    const ops = { scanUnregistered: async () => [{ name: 'found', modelFile: 'models/found.gguf', backend: 'llama.cpp' }] };
    const { client, responses, flush } = setup(undefined, undefined, undefined, ops);
    client.send({ kind: 'request', id: 'scan1', method: 'model.localScan' });
    await flush();
    const resp = responses.find((r) => r.id === 'scan1');
    expect(resp).toMatchObject({ ok: true });
    expect((resp!.result as { models: unknown[] }).models).toHaveLength(1);
  });
});
