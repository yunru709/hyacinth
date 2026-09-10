// ============================================================
// UI 协议层 — 后台进程域测试
// ============================================================
// 覆盖 process.list / process.kill，重点验证：
//  1. 注册表未就绪时 list 降级为空列表（UI 不报错）
//  2. kill 的 handle 参数校验与注册表缺失语义
//  3. registry.kill 返回 false（进程不存在）时的响应语义
//
// 依赖用结构化 fake（BackgroundRegistryLike），不启动真实进程。
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createProcessDomain, type BackgroundRegistryLike } from './process.js';
import type { UiResponse, ProcessInfoLike } from '../types.js';

function makeProcess(over: Partial<ProcessInfoLike> = {}): ProcessInfoLike {
  return {
    handle: 'bg_1',
    name: 'sleep',
    command: 'sleep 30',
    pid: 1234,
    status: 'running',
    startTime: new Date().toISOString(),
    outputSize: 0,
    ...over,
  };
}

function makeRegistry(processes: ProcessInfoLike[] = [makeProcess()]) {
  const killed: string[] = [];
  const registry: BackgroundRegistryLike & { killed: string[] } = {
    killed,
    list: () => processes,
    kill: async (handle: string) => {
      killed.push(handle);
      return processes.some((p) => p.handle === handle);
    },
  };
  return registry;
}

function setup(getRegistry: () => BackgroundRegistryLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('process', createProcessDomain({ getRegistry }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const wait = async (id: string, timeout = 3000): Promise<UiResponse> => {
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

describe('后台进程域', () => {
  describe('process.list', () => {
    it('返回全部后台进程', async () => {
      const { client, wait } = setup(() => makeRegistry([
        makeProcess(),
        makeProcess({ handle: 'bg_2', name: 'build', command: 'npm run build', pid: 5678 }),
      ]));
      client.send({ kind: 'request', id: 'l1', method: 'process.list' });
      const resp = await wait('l1');
      expect(resp.ok).toBe(true);
      const result = resp.result as any;
      expect(result.processes).toHaveLength(2);
      expect(result.processes[0]).toMatchObject({ handle: 'bg_1', status: 'running', pid: 1234 });
    });

    it('注册表未就绪 → 空列表（读取类操作降级而非报错）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 'l2', method: 'process.list' });
      const resp = await wait('l2');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ processes: [] });
    });

    it('无后台进程 → 空列表', async () => {
      const { client, wait } = setup(() => makeRegistry([]));
      client.send({ kind: 'request', id: 'l3', method: 'process.list' });
      expect((await wait('l3')).result).toEqual({ processes: [] });
    });
  });

  describe('process.kill', () => {
    it('终止存在的进程 → ok=true 并回传 handle', async () => {
      const registry = makeRegistry([makeProcess()]);
      const { client, wait } = setup(() => registry);
      client.send({ kind: 'request', id: 'k1', method: 'process.kill', params: { handle: 'bg_1' } });
      const resp = await wait('k1');
      expect(resp.result).toEqual({ ok: true, handle: 'bg_1' });
      expect(registry.killed).toEqual(['bg_1']);
    });

    it('终止不存在的进程 → ok=false（注册表如实回报，不伪造成功）', async () => {
      const { client, wait } = setup(() => makeRegistry([makeProcess()]));
      client.send({ kind: 'request', id: 'k2', method: 'process.kill', params: { handle: 'nope' } });
      const resp = await wait('k2');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ ok: false, handle: 'nope' });
    });

    it('缺少 handle → 报错', async () => {
      const { client, wait } = setup(() => makeRegistry());
      client.send({ kind: 'request', id: 'k3', method: 'process.kill', params: {} });
      const resp = await wait('k3');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('requires "handle"');
    });

    it('注册表未就绪 → 报错（写入类操作不做静默降级）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 'k4', method: 'process.kill', params: { handle: 'bg_1' } });
      const resp = await wait('k4');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('not available');
    });
  });

  it('未知 action → UNKNOWN_METHOD', async () => {
    const { client, wait } = setup(() => makeRegistry());
    client.send({ kind: 'request', id: 'u1', method: 'process.restart' });
    const resp = await wait('u1');
    expect(resp.error?.code).toBe('UNKNOWN_METHOD');
  });
});
