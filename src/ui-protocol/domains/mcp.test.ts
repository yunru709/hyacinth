// ============================================================
// UI 协议层 — MCP 域测试
// ============================================================
// 覆盖：
//  1. mcp.list 以配置文件为准，合并运行时状态（含被禁用的 Server）
//  2. mcp.enable / mcp.disable 写 _disabled 并触发重载
//  3. mcp.add / mcp.remove / mcp.reconnect 委托 MCPSystem
//  4. 后端组件缺失 → 报错
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createMCPDomain, type MCPSystemLike, type MCPServerManagerLike } from './mcp.js';
import type { UiResponse } from '../types.js';

function makeManager(name: string, connected: boolean, toolCount: number, onReconnect?: () => void): MCPServerManagerLike {
  return {
    getName: () => name,
    isConnected: () => connected,
    getClient: () => ({ getTools: () => new Array(toolCount) }),
    reconnect: async () => { onReconnect?.(); },
  };
}

interface FakeCalls {
  added: unknown[];
  removed: string[];
  toggled: { name: string; enabled: boolean }[];
  reloads: number;
}

function makeSystem(
  managers: MCPServerManagerLike[] = [],
  configView: { name: string; enabled: boolean; file: string; scope: 'user' | 'project' | 'project-agent'; command?: string }[] = [],
  calls: FakeCalls = { added: [], removed: [], toggled: [], reloads: 0 },
): MCPSystemLike {
  return {
    getStatus: () => managers.map((m) => ({ name: m.getName(), connected: m.isConnected() })),
    getManagers: () => managers,
    getConfigView: async () => configView,
    setServerEnabled: async (name, enabled) => {
      calls.toggled.push({ name, enabled });
      calls.reloads += 1;
      const entry = configView.find((c) => c.name === name);
      if (!entry) throw new Error(`MCP server "${name}" not found in any config file`);
      entry.enabled = enabled;
      return entry.file;
    },
    addExternalServer: async (config) => { calls.added.push(config); },
    removeExternalServer: async (name) => { calls.removed.push(name); },
  };
}

function setup(system: MCPSystemLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('mcp', createMCPDomain({ getMCP: () => system }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const wait = async (id: string, timeout = 2000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  return { client, wait };
}

describe('MCP 域', () => {
  it('mcp.list 以配置文件为准，合并运行时连接状态', async () => {
    const system = makeSystem(
      [makeManager('filesystem', true, 8), makeManager('github', false, 0)],
      [
        { name: 'filesystem', enabled: true, file: '/home/u/.agent/mcp.json', scope: 'user', command: 'npx' },
        // 被禁用的：配置文件里有，但没连 → UI 仍要能看到并给出启用开关
        { name: 'github', enabled: false, file: '/proj/.agent/mcp.json', scope: 'project-agent', command: 'node' },
        // 启用但连接失败的：enabled=true 却 connected=false
        { name: 'broken', enabled: true, file: '/proj/.mcp.json', scope: 'project', command: 'node' },
      ],
    );
    const { client, wait } = setup(system);
    client.send({ kind: 'request', id: 'l1', method: 'mcp.list' });
    const resp = await wait('l1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({
      servers: [
        { name: 'filesystem', enabled: true, connected: true, toolCount: 8, file: '/home/u/.agent/mcp.json', scope: 'user', command: 'npx' },
        { name: 'github', enabled: false, connected: false, toolCount: 0, file: '/proj/.agent/mcp.json', scope: 'project-agent', command: 'node' },
        { name: 'broken', enabled: true, connected: false, toolCount: 0, file: '/proj/.mcp.json', scope: 'project', command: 'node' },
      ],
    });
  });

  it('mcp.list 包含运行时热插拔添加、配置文件里没有的 Server', async () => {
    const system = makeSystem([makeManager('hot-plugged', true, 3)], []);
    const { client, wait } = setup(system);
    client.send({ kind: 'request', id: 'l2', method: 'mcp.list' });
    const resp = await wait('l2');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({
      servers: [{ name: 'hot-plugged', enabled: true, connected: true, toolCount: 3, scope: 'runtime' }],
    });
  });

  it('mcp.enable / mcp.disable 写 _disabled 并返回受影响文件', async () => {
    const calls: FakeCalls = { added: [], removed: [], toggled: [], reloads: 0 };
    const system = makeSystem(
      [],
      [{ name: 'github', enabled: false, file: '/proj/.agent/mcp.json', scope: 'project-agent' }],
      calls,
    );
    const { client, wait } = setup(system);

    client.send({ kind: 'request', id: 'e1', method: 'mcp.enable', params: { name: 'github' } });
    const en = await wait('e1');
    expect(en.ok).toBe(true);
    expect(en.result).toEqual({ ok: true, name: 'github', file: '/proj/.agent/mcp.json' });

    client.send({ kind: 'request', id: 'd1', method: 'mcp.disable', params: { name: 'github' } });
    const dis = await wait('d1');
    expect(dis.ok).toBe(true);

    expect(calls.toggled).toEqual([
      { name: 'github', enabled: true },
      { name: 'github', enabled: false },
    ]);
    // 每次启停都应触发一次重载，否则开关不生效
    expect(calls.reloads).toBe(2);
  });

  it('mcp.enable 作用于不存在的 Server → 报错', async () => {
    const { client, wait } = setup(makeSystem());
    client.send({ kind: 'request', id: 'e2', method: 'mcp.enable', params: { name: 'nope' } });
    const resp = await wait('e2');
    expect(resp.ok).toBe(false);
  });

  it('mcp.add / mcp.remove 委托 MCPSystem（热插拔）', async () => {
    const calls: FakeCalls = { added: [], removed: [], toggled: [], reloads: 0 };
    const system = makeSystem([], [], calls);
    const { client, wait } = setup(system);
    client.send({ kind: 'request', id: 'a1', method: 'mcp.add', params: { name: 'my-server', command: 'npx', args: ['-y', 'server'] } });
    const added = await wait('a1');
    expect(added.ok).toBe(true);
    expect(calls.added[0]).toMatchObject({ name: 'my-server', command: 'npx' });

    client.send({ kind: 'request', id: 'r1', method: 'mcp.remove', params: { name: 'my-server' } });
    const removed = await wait('r1');
    expect(removed.ok).toBe(true);
    expect(calls.removed).toEqual(['my-server']);
  });

  it('mcp.add 缺 name → 报错', async () => {
    const { client, wait } = setup(makeSystem());
    client.send({ kind: 'request', id: 'a1', method: 'mcp.add', params: { command: 'npx' } });
    const resp = await wait('a1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('requires "name"');
  });

  it('mcp.reconnect 重连指定服务器；不存在 → 报错', async () => {
    let reconnected = '';
    const system = makeSystem([makeManager('ghost-server', false, 0, () => { reconnected = 'ghost-server'; })]);
    const { client, wait } = setup(system);
    client.send({ kind: 'request', id: 'rc1', method: 'mcp.reconnect', params: { name: 'ghost-server' } });
    const ok = await wait('rc1');
    expect(ok.ok).toBe(true);
    expect(reconnected).toBe('ghost-server');

    client.send({ kind: 'request', id: 'rc2', method: 'mcp.reconnect', params: { name: 'no-such' } });
    const fail = await wait('rc2');
    expect(fail.ok).toBe(false);
  });

  it('后端组件缺失 → 报错', async () => {
    const { client, wait } = setup(null);
    client.send({ kind: 'request', id: 'l1', method: 'mcp.list' });
    const resp = await wait('l1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not supported');
  });
});
