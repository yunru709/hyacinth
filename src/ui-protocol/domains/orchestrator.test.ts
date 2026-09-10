// ============================================================
// UI 协议层 — 旁路 agent 编排域测试
// ============================================================
// 覆盖 orchestrator.get / orchestrator.setEnabled，重点验证：
//  1. manager 未就绪时 get 降级为空状态
//  2. setEnabled 的参数校验（必须 boolean，避免 undefined 被当成关闭）
//  3. manager 能力缺失（无 activateAgent）时明确报错
//  4. activeAgents 在 getActiveNames 缺失时降级为空数组
//
// 依赖用结构化 fake（BypassManagerLike），不启真实旁路 agent。
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createOrchestratorDomain, type BypassManagerLike } from './orchestrator.js';
import type { UiResponse } from '../types.js';

/** 旁路 manager fake：维护激活集合，记录调用 */
function makeManager(active: string[] = []) {
  const activeSet = new Set(active);
  const calls: string[] = [];
  const manager: BypassManagerLike & { calls: string[] } = {
    calls,
    isActive: (name: string) => activeSet.has(name),
    async activateAgent(name: string) {
      calls.push(`activate:${name}`);
      activeSet.add(name);
    },
    async deactivateAgent(name: string) {
      calls.push(`deactivate:${name}`);
      activeSet.delete(name);
    },
    getActiveNames: () => [...activeSet],
  };
  return manager;
}

function setup(getBypassManager: () => BypassManagerLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('orchestrator', createOrchestratorDomain({ getBypassManager }));
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

describe('旁路 agent 编排域', () => {
  describe('orchestrator.get', () => {
    it('未激活 → { active: false, activeAgents: [] }', async () => {
      const { client, wait } = setup(() => makeManager([]));
      client.send({ kind: 'request', id: 'g1', method: 'orchestrator.get' });
      const resp = await wait('g1');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ orchestrator: { active: false, activeAgents: [] } });
    });

    it('已激活 → 同时回传全部激活的旁路 agent', async () => {
      const { client, wait } = setup(() => makeManager(['orchestrator', 'reviewer']));
      client.send({ kind: 'request', id: 'g2', method: 'orchestrator.get' });
      const resp = await wait('g2');
      expect((resp.result as any).orchestrator).toEqual({
        active: true,
        activeAgents: ['orchestrator', 'reviewer'],
      });
    });

    it('manager 未就绪 → 降级为空状态（读取类操作不报错）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 'g3', method: 'orchestrator.get' });
      const resp = await wait('g3');
      expect(resp.ok).toBe(true);
      expect(resp.result).toEqual({ orchestrator: { active: false, activeAgents: [] } });
    });

    it('manager 未提供 getActiveNames → activeAgents 降级为空数组', async () => {
      const { client, wait } = setup(() => ({
        isActive: () => true,
        activateAgent: async () => {},
        deactivateAgent: async () => {},
      }));
      client.send({ kind: 'request', id: 'g4', method: 'orchestrator.get' });
      expect((await wait('g4')).result).toEqual({
        orchestrator: { active: true, activeAgents: [] },
      });
    });
  });

  describe('orchestrator.setEnabled', () => {
    it('启用 → 调用 activateAgent 并返回激活快照', async () => {
      const manager = makeManager([]);
      const { client, wait } = setup(() => manager);
      client.send({ kind: 'request', id: 's1', method: 'orchestrator.setEnabled', params: { enabled: true } });
      const resp = await wait('s1');
      expect(resp.result).toEqual({
        ok: true,
        orchestrator: { active: true, activeAgents: ['orchestrator'] },
      });
      expect(manager.calls).toEqual(['activate:orchestrator']);
    });

    it('停用 → 调用 deactivateAgent 并返回未激活快照', async () => {
      const manager = makeManager(['orchestrator']);
      const { client, wait } = setup(() => manager);
      client.send({ kind: 'request', id: 's2', method: 'orchestrator.setEnabled', params: { enabled: false } });
      const resp = await wait('s2');
      expect(resp.result).toEqual({
        ok: true,
        orchestrator: { active: false, activeAgents: [] },
      });
      expect(manager.calls).toEqual(['deactivate:orchestrator']);
    });

    it('非 boolean 参数 → 报错（避免 undefined 被当成关闭而误停服务）', async () => {
      const { client, wait } = setup(() => makeManager(['orchestrator']));
      client.send({ kind: 'request', id: 's3', method: 'orchestrator.setEnabled', params: { enabled: 1 } });
      const resp = await wait('s3');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('requires boolean');
    });

    it('manager 未就绪 → 报错（切换类操作不做静默降级）', async () => {
      const { client, wait } = setup(() => null);
      client.send({ kind: 'request', id: 's4', method: 'orchestrator.setEnabled', params: { enabled: true } });
      const resp = await wait('s4');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('not available');
    });

    it('manager 不支持 activateAgent → 明确报错而非静默忽略', async () => {
      const { client, wait } = setup(() => ({ isActive: () => false, getActiveNames: () => [] }));
      client.send({ kind: 'request', id: 's5', method: 'orchestrator.setEnabled', params: { enabled: true } });
      const resp = await wait('s5');
      expect(resp.ok).toBe(false);
      expect(resp.error?.message).toContain('activateAgent not supported');
    });
  });

  it('未知 action → UNKNOWN_METHOD', async () => {
    const { client, wait } = setup(() => makeManager());
    client.send({ kind: 'request', id: 'u1', method: 'orchestrator.list' });
    expect((await wait('u1')).error?.code).toBe('UNKNOWN_METHOD');
  });
});
