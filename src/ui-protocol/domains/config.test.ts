// ============================================================
// UI 协议层 — 配置域测试
// ============================================================
// 验证：
//  1. config.get / getAll 读取配置
//  2. config.set 后 getAll 反映变更（转发到配置中心）
//  3. config.set 触发 config.change 事件推送（订阅 watch('*')）
//  4. config.schema 返回可遍历路径（含嵌套路径、类型、默认值）
//  5. config.reset / merge 转发
//  6. dispose 取消订阅
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createConfigDomain, type ConfigCenterLike } from './config.js';
import type { ConfigChangeEvent, UiResponse } from '../types.js';

// ── mock 配置中心 ──────────────────────────────────────────
// 语义对齐真实 RuntimeConfigCenter：defaults（不可变基准）+ runtime（override）
// get 优先查 runtime，回落 defaults；reset 删除 runtime 使值回落到 defaults。

function makeMockConfig(initial?: Record<string, unknown>): ConfigCenterLike & {
  get: (path: string) => unknown;
  getAll: () => Record<string, unknown>;
  state: Record<string, unknown>;
  saveCalls: number;
  emitChange: (path: string, oldValue: unknown, newValue: unknown) => void;
} {
  const defaults: Record<string, unknown> = initial ?? {
    provider: { active: 'anthropic', routeMode: 'auto' },
    session: { maxTurns: 100, maxContext: 200000, maxMessages: 10000 },
    context: { compressThreshold: 0.75, emergencyThreshold: 0.92, compressDepth: 0.5 },
  };
  // runtime overrides（deep clone 的 defaults 作为合并基准）
  const runtime: Record<string, unknown> = JSON.parse(JSON.stringify(defaults));
  const watchers = new Set<(event: ConfigChangeEvent) => void>();
  let saveCalls = 0;

  function getByPath(obj: unknown, path: string): unknown {
    let cur: unknown = obj;
    for (const seg of path.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  }
  function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] === null || typeof cur[s] !== 'object') cur[s] = {};
      cur = cur[s] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]] = value;
  }
  function deleteByPath(obj: Record<string, unknown>, path: string): void {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (cur[s] === null || typeof cur[s] !== 'object') return;
      cur = cur[s] as Record<string, unknown>;
    }
    delete cur[segs[segs.length - 1]];
  }

  return {
    get: (path: string): unknown => {
      // 先查 runtime override，回落 defaults
      const overridden = getByPath(runtime, path);
      if (overridden !== undefined) return overridden;
      return getByPath(defaults, path);
    },
    getAll: (): Record<string, unknown> => JSON.parse(JSON.stringify(runtime)),
    set: (path: string, value: unknown): void => {
      const oldValue = getByPath(runtime, path);
      setByPath(runtime, path, value);
      const event = { path, oldValue, newValue: value, timestamp: new Date().toISOString() };
      for (const cb of watchers) cb(event);
    },
    merge: (partial: Record<string, unknown>): void => {
      Object.assign(runtime, JSON.parse(JSON.stringify(partial)));
    },
    reset: (path?: string): void => {
      if (path) {
        // 删除 runtime override，使 get 回落到 defaults
        deleteByPath(runtime, path);
      } else {
        for (const k of Object.keys(runtime)) delete runtime[k];
      }
    },
    watch: (_pattern: string, cb: (event: ConfigChangeEvent) => void): (() => void) => {
      watchers.add(cb);
      return () => {
        watchers.delete(cb);
      };
    },
    emitChange: (path: string, oldValue: unknown, newValue: unknown): void => {
      const event = { path, oldValue, newValue, timestamp: new Date().toISOString() };
      for (const cb of watchers) cb(event);
    },
    // 用 method（非箭头函数）并依赖 this，语义对齐真实 RuntimeConfigCenter.save：
    // 后者内部访问 this.ensureInitialized()/this.getAll()/this.configManager，
    // 若调用方丢失 this 绑定（如 `const s = c.save; s()`）会抛 TypeError。
    save: async function (this: { getAll: () => unknown }): Promise<void> {
      if (!this || typeof this.getAll !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'ensureInitialized')");
      }
      saveCalls++;
    },
    get state() {
      return runtime;
    },
    get saveCalls() {
      return saveCalls;
    },
  } as unknown as ConfigCenterLike & {
    get: (path: string) => unknown;
    getAll: () => Record<string, unknown>;
    state: Record<string, unknown>;
    saveCalls: number;
    emitChange: (path: string, oldValue: unknown, newValue: unknown) => void;
  };
}

/** 建立 client + server + 已注册配置域的完整链路 */
function setup(emitEvents = true) {
  const mock = makeMockConfig();
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const domain = createConfigDomain({
    configCenter: mock,
    emit: emitEvents ? (type, payload) => server.broadcast(type, payload) : undefined,
  });
  server.registerDomain('config', domain);
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  const events: { type: string; payload?: unknown }[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push({ type: m.type, payload: m.payload });
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { mock, client, server, domain, responses, events, flush };
}

describe('配置域', () => {
  it('config.get 读取单路径', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'config.get', params: { path: 'session.maxTurns' } });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(responses[0].result).toEqual({ path: 'session.maxTurns', value: 100 });
  });

  it('config.getAll 返回完整配置', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'config.getAll' });
    await flush();
    const result = responses[0].result as Record<string, unknown>;
    expect(result).toHaveProperty('provider');
    expect((result.provider as any).active).toBe('anthropic');
    expect((result.session as any).maxTurns).toBe(100);
  });

  it('config.set 后 getAll 反映变更 + 发出 config.change 事件', async () => {
    const { client, responses, events, flush, mock } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'config.set', params: { path: 'session.maxTurns', value: 250 } });
    await flush();

    // 响应
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(responses[0].result).toEqual({ ok: true, path: 'session.maxTurns', value: 250 });
    // 配置中心已更新
    expect(mock.get('session.maxTurns')).toBe(250);

    // config.change 事件已推送
    const change = events.find((e) => e.type === 'config.change');
    expect(change).toBeTruthy();
    const payload = change!.payload as ConfigChangeEvent;
    expect(payload.path).toBe('session.maxTurns');
    expect(payload.newValue).toBe(250);
    expect(payload.oldValue).toBe(100);
  });

  // 回归守卫：config.set 必须真正落盘。
  // 曾出现 bug —— maybePersist 用 `await save()` 调用，丢失 this 绑定并抛 TypeError，
  // 而 catch{} 静默吞掉异常，导致所有配置改动只存在于内存、重启即丢。
  it('config.set 触发持久化（save 必须绑定 this，否则静默失败不落盘）', async () => {
    const { client, flush, mock } = setup(false);
    client.send({ kind: 'request', id: 'r1', method: 'config.set', params: { path: 'session.maxTurns', value: 300 } });
    await flush();
    // 等待 fire-and-forget 的 maybePersist 完成
    await flush();
    expect(mock.saveCalls).toBe(1);
  });

  it('config.merge / config.reset 同样触发持久化', async () => {
    const { client, flush, mock } = setup(false);
    client.send({ kind: 'request', id: 'm1', method: 'config.merge', params: { session: { maxTurns: 123 } } });
    await flush();
    await flush();
    expect(mock.saveCalls).toBe(1);

    client.send({ kind: 'request', id: 'm2', method: 'config.reset', params: { path: 'session.maxTurns' } });
    await flush();
    await flush();
    expect(mock.saveCalls).toBe(2);
  });

  it('config.schema 返回可遍历路径（嵌套、类型、默认值、描述）', async () => {
    const { client, responses, flush } = setup(false);
    client.send({ kind: 'request', id: 'r1', method: 'config.schema' });
    await flush();

    expect(responses[0].ok).toBe(true);
    const entries = (responses[0].result as { entries: any[] }).entries;
    // 嵌套路径存在
    const maxTurns = entries.find((e) => e.path === 'session.maxTurns');
    expect(maxTurns).toBeTruthy();
    expect(maxTurns).toMatchObject({ type: 'number', default: 100 });
    // 全部带 description
    for (const e of entries) {
      expect(e.path).toBeTruthy();
      expect(e.description).toBeTruthy();
    }
    // 可遍历：至少含 8 个叶子
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  it('config.merge 合并部分配置', async () => {
    const { client, responses, flush, mock } = setup();
    client.send({
      kind: 'request',
      id: 'r1',
      method: 'config.merge',
      params: { session: { maxMessages: 500 } },
    });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(mock.get('session.maxMessages')).toBe(500);
  });

  it('config.reset 重置配置（回落到默认值）', async () => {
    const { client, responses, flush, mock } = setup();
    mock.set('session.maxTurns', 999);
    expect(mock.get('session.maxTurns')).toBe(999);
    client.send({ kind: 'request', id: 'r1', method: 'config.reset', params: { path: 'session.maxTurns' } });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    // reset 删除 runtime override，值回落到 defaults=100
    expect(mock.get('session.maxTurns')).toBe(100);
  });

  it('config.get 未知路径返回错误', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'config.get', params: { path: 'nope.doesnt.exist' } });
    await flush();
    expect(responses[0]).toMatchObject({ id: 'r1', ok: false });
    expect(responses[0].error?.code).toBe('INTERNAL_ERROR');
  });

  it('dispose 取消 watch 订阅（不再转发 change 事件）', async () => {
    const { mock, server, domain, client, events, flush } = setup();
    // 先确认有订阅
    mock.emitChange('session.maxTurns', 100, 200);
    await flush();
    expect(events.some((e) => e.type === 'config.change')).toBe(true);

    // dispose 后不再转发
    domain.dispose();
    mock.emitChange('session.maxTurns', 200, 300);
    await flush();
    const count = events.filter((e) => e.type === 'config.change').length;
    expect(count).toBe(1); // 只有第一次
    expect(server.hasDomain('config')).toBe(true);
  });
});
