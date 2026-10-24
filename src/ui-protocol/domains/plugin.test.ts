// ============================================================
// UI 契约层 — 插件域测试
// ============================================================
// 覆盖两列分置的能力面：
//   内核插件：plugin.list（挂载状态，含 error 可见性）——只读
//   目录插件：plugin.listDirectory / activate / deactivate / reload
// 重点：
//   1. 管理面未注入 ⇒ 查询返回空、写操作报错（fail-closed，不静默成功）
//   2. 参数校验（缺 id 报错）
//   3. 方法面登记（UI_METHOD 同源守卫另有 index.test.ts 兜底）
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createPluginDomain, type PluginManagerLike, type DirectoryPluginLike } from './plugin.js';
import type { UiResponse } from '../types.js';

function makeManager(entries: DirectoryPluginLike[] = []) {
  const calls: string[] = [];
  const manager: PluginManagerLike & { calls: string[] } = {
    calls,
    getAll: () => entries,
    activate: async (id: string) => { calls.push(`activate:${id}`); },
    deactivate: async (id: string) => { calls.push(`deactivate:${id}`); },
    reloadFromDisk: async (id: string) => { calls.push(`reload:${id}`); },
  };
  return manager;
}

function setup(manager: PluginManagerLike | null, hosts: Array<{ id: string; state: string; error?: string; deps: string[] }> = []) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('plugin', createPluginDomain({
    getPluginHosts: () => hosts as never,
    getDirectoryManager: () => manager,
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const req = async (method: string, params?: unknown): Promise<UiResponse> => {
    const id = 'r' + Math.random().toString(36).slice(2);
    client.send({ kind: 'request', id, method, params });
    const start = Date.now();
    for (;;) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      if (Date.now() - start > 3000) throw new Error(`timeout waiting for ${id}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { req };
}

describe('内核插件（plugin.list，只读）', () => {
  it('返回挂载状态；error 插件的错误信息可见', async () => {
    const { req } = setup(makeManager(), [
      { id: 'bypass', state: 'mounted', deps: [] },
      { id: 'world-engine', state: 'error', error: 'mount boom', deps: ['bypass'] },
    ]);
    const resp = await req('plugin.list');
    expect(resp.ok).toBe(true);
    const list = resp.result as Array<{ id: string; state: string; error?: string }>;
    expect(list).toHaveLength(2);
    expect(list[1].error).toBe('mount boom');
  });
});

describe('目录插件（plugin.listDirectory / activate / deactivate / reload）', () => {
  it('listDirectory 返回映射后的清单', async () => {
    const { req } = setup(makeManager([
      { id: 'companion', name: '陪伴', description: 'd', status: 'activated', dir: 'C:\\p', skillCount: 2, mcpServerCount: 1 },
    ] as DirectoryPluginLike[]));
    const resp = await req('plugin.listDirectory');
    expect(resp.ok).toBe(true);
    const plugins = (resp.result as { plugins: Array<{ id: string; status: string; skillCount: number }> }).plugins;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ id: 'companion', status: 'activated', skillCount: 2 });
  });

  it('管理面未注入：listDirectory 返回空、写操作报错（fail-closed）', async () => {
    const { req } = setup(null);
    const list = await req('plugin.listDirectory');
    expect(list.result).toEqual({ plugins: [] });

    const act = await req('plugin.activate', { id: 'companion' });
    expect(act.ok).toBe(false);
    expect(act.error?.message).toContain('not available');
  });

  it('activate/deactivate/reload 调用管理面并回传 ok', async () => {
    const mgr = makeManager();
    const { req } = setup(mgr);
    for (const [method, op] of [['plugin.activate', 'activate'], ['plugin.deactivate', 'deactivate'], ['plugin.reload', 'reload']] as const) {
      const resp = await req(method, { id: 'companion' });
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ ok: true, id: 'companion' });
    }
    expect(mgr.calls).toEqual(['activate:companion', 'deactivate:companion', 'reload:companion']);
  });

  it('缺 id 报错', async () => {
    const { req } = setup(makeManager());
    const resp = await req('plugin.activate', {});
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('requires "id"');
  });
});
