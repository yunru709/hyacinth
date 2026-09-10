// ============================================================
// UI 协议层 — UiProtocolServer 核心路由测试
// ============================================================
// 验证：
//  1. 注册领域后，按 method 前缀分发请求 → 正确响应关联
//  2. 未知 domain / 未知 method → 返回 UiError
//  3. 处理器抛错 → 返回 INTERNAL_ERROR
//  4. emit / broadcast → 事件到达所有（或指定）adapter
//  5. 多 adapter 各自独立关联响应
// ============================================================

import { describe, it, expect } from 'vitest';
import { InProcAdapter } from './adapter.js';
import { UiProtocolServer } from './server.js';
import type { UiMessage, UiResponse, UiEvent } from './types.js';

/** 建立 [client, server] 已互连的 InProc 对 + 已 attach 的协议服务器 */
function setup() {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.attach(serverAdp);
  return { client, serverAdp, server };
}

/** 从 client 侧收集响应/事件 */
function collect(client: InProcAdapter) {
  const responses: UiResponse[] = [];
  const events: UiEvent[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push(m);
  });
  return { responses, events };
}

/** 等待微任务队列清空（dispatch 是 async，即使同步 action 也需等一个 tick） */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('UiProtocolServer 路由', () => {
  it('按 method 前缀分发请求并正确关联响应', async () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', {
      get: (params) => ({ value: params }),
      async list() {
        return ['a', 'b'];
      },
    });

    client.send({ kind: 'request', id: 'r1', method: 'config.get', params: { path: 'x' } });
    client.send({ kind: 'request', id: 'r2', method: 'config.list' });
    await flush();

    expect(responses).toHaveLength(2);
    const r1 = responses.find((r) => r.id === 'r1')!;
    const r2 = responses.find((r) => r.id === 'r2')!;
    expect(r1).toMatchObject({ kind: 'response', id: 'r1', ok: true });
    expect((r1.result as any).value).toEqual({ path: 'x' });
    expect(r2).toMatchObject({ ok: true });
    expect(r2.result).toEqual(['a', 'b']);
  });

  it('未知 domain 返回 UNKNOWN_DOMAIN 错误', () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', { get: () => ({}) });
    client.send({ kind: 'request', id: 'r1', method: 'nope.get' });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 'r1', ok: false });
    expect(responses[0].error?.code).toBe('UNKNOWN_DOMAIN');
  });

  it('未知 method 返回 UNKNOWN_METHOD 错误', () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', { get: () => ({}) });
    client.send({ kind: 'request', id: 'r1', method: 'config.nope' });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 'r1', ok: false });
    expect(responses[0].error?.code).toBe('UNKNOWN_METHOD');
  });

  it('处理器抛错返回 INTERNAL_ERROR 且带 details', () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', {
      get: () => {
        throw new Error('boom');
      },
    });
    client.send({ kind: 'request', id: 'r1', method: 'config.get' });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 'r1', ok: false });
    expect(responses[0].error?.code).toBe('INTERNAL_ERROR');
    expect(responses[0].error?.message).toBe('boom');
    expect((responses[0].error?.details as any).method).toBe('config.get');
  });

  it('异步处理器正常工作', async () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('session', {
      async list() {
        await new Promise((r) => setTimeout(r, 10));
        return [{ id: 's1' }];
      },
    });
    client.send({ kind: 'request', id: 'r1', method: 'session.list' });
    await new Promise((r) => setTimeout(r, 30));

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ ok: true });
    expect(responses[0].result).toEqual([{ id: 's1' }]);
  });

  it('emit 广播事件到达所有 adapter；指定 target 只到达该 adapter', () => {
    const c1 = new InProcAdapter('client1');
    const s1 = new InProcAdapter('server1');
    c1.connect(s1);
    const c2 = new InProcAdapter('client2');
    const s2 = new InProcAdapter('server2');
    c2.connect(s2);

    const server = new UiProtocolServer();
    server.attach(s1);
    server.attach(s2);

    const e1: UiEvent[] = [];
    const e2: UiEvent[] = [];
    c1.onMessage((m) => { if (m.kind === 'event') e1.push(m); });
    c2.onMessage((m) => { if (m.kind === 'event') e2.push(m); });

    // 广播 → 两个都收到
    server.broadcast('message.text', { content: 'hi' });
    expect(e1).toHaveLength(1);
    expect(e2).toHaveLength(1);
    expect((e1[0] as UiEvent).payload).toEqual({ content: 'hi' });

    // 指定 target → 仅 c1 收到
    server.emit('message.status', { message: 'w' }, s1);
    expect(e1).toHaveLength(2);
    expect(e2).toHaveLength(1);
  });

  it('多 adapter 各自独立关联响应（互不串扰）', async () => {
    const c1 = new InProcAdapter('client1');
    const s1 = new InProcAdapter('server1');
    c1.connect(s1);
    const c2 = new InProcAdapter('client2');
    const s2 = new InProcAdapter('server2');
    c2.connect(s2);

    const server = new UiProtocolServer();
    server.attach(s1);
    server.attach(s2);
    server.registerDomain('config', { get: (p: any) => ({ echo: p }) });

    const r1: UiResponse[] = [];
    const r2: UiResponse[] = [];
    c1.onMessage((m) => { if (m.kind === 'response') r1.push(m); });
    c2.onMessage((m) => { if (m.kind === 'response') r2.push(m); });

    c1.send({ kind: 'request', id: 'a1', method: 'config.get', params: { who: 'one' } });
    c2.send({ kind: 'request', id: 'b1', method: 'config.get', params: { who: 'two' } });
    await flush();

    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect((r1[0].result as any).echo).toEqual({ who: 'one' });
    expect((r2[0].result as any).echo).toEqual({ who: 'two' });
    expect(r1[0].id).toBe('a1');
    expect(r2[0].id).toBe('b1');
  });

  // ── meta 域（版本/能力协商，P5-3）─────────────────────────

  it('meta 域内建注册：构造后即可 protocol.meta.get', async () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', { get: () => ({}) });
    client.send({ kind: 'request', id: 'm1', method: 'meta.get' });
    await flush();

    expect(responses).toHaveLength(1);
    const res = responses[0];
    expect(res).toMatchObject({ id: 'm1', ok: true });
    const meta = res.result as {
      version: string;
      domains: string[];
      methods: Record<string, string[]>;
    };
    expect(typeof meta.version).toBe('string');
    // 版本语义化：主.次.修订
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    // 能力清单反映注册状态；meta 自身不列入
    expect(meta.domains).toContain('config');
    expect(meta.domains).not.toContain('meta');
    expect(meta.methods.config).toEqual(['get']);
  });

  it('meta.get 实时反映后续注册的域与方法', async () => {
    const { client, server } = setup();
    const { responses } = collect(client);

    server.registerDomain('config', { get: () => ({}) });
    client.send({ kind: 'request', id: 'm1', method: 'meta.get' });
    await flush();
    expect((responses[0].result as any).methods.config).toEqual(['get']);

    // 追加域与方法 → 再次 get 应包含
    server.registerDomain('session', { list: () => [], create: () => ({}) });
    client.send({ kind: 'request', id: 'm2', method: 'meta.get' });
    await flush();
    const meta2 = responses[1].result as { domains: string[]; methods: Record<string, string[]> };
    expect(meta2.domains).toEqual(expect.arrayContaining(['config', 'session']));
    expect(meta2.methods.session).toEqual(['list', 'create']);
  });

  it('listDomains 包含内建 meta 域（可被显式注册覆盖）', () => {
    const server = new UiProtocolServer();
    expect(server.listDomains()).toContain('meta');
    expect(server.hasDomain('meta')).toBe(true);

    // 显式注册同名域 → 覆盖内建实现
    server.registerDomain('meta', { custom: () => ({ ok: true }) });
    expect(server.listDomains()).toContain('meta');
  });
});
