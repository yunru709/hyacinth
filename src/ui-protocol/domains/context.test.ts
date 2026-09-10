// ============================================================
// UI 协议层 — 上下文域测试
// ============================================================
// 覆盖：
//  1. context.previewZone → 委托 loop.previewContextZone 返回真实 Zone 文本
//  2. 默认 zone 为 zone1
//  3. loop 不支持时 → 报错
//  4. context.manifest → 查询 zone 状态（缺依赖降级空列表）
//  5. context.setZoneEnabled → 写入开关（缺依赖/非法参数报错）
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createContextDomain, type ContextLoopLike, type ManifestLike } from './context.js';
import type { UiResponse } from '../types.js';

function setup(loop: ContextLoopLike | null, manifest?: ManifestLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('context', createContextDomain({
    getLoop: () => loop,
    getManifest: () => manifest ?? null,
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });

  const waitForResponse = async (id: string, timeout = 2000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for response "${id}"`);
  };

  return { client, waitForResponse };
}

describe('上下文域', () => {
  it('previewZone 委托 loop 返回 Zone 文本；默认 zone=zone1', async () => {
    let calledZone = '';
    const loop: ContextLoopLike = {
      previewContextZone: async (zone) => {
        calledZone = zone;
        return { zone, text: `[${zone} 组装内容]`, tokens: 42 };
      },
    };
    const { client, waitForResponse } = setup(loop);

    client.send({ kind: 'request', id: 'p1', method: 'context.previewZone', params: {} });
    const resp = await waitForResponse('p1');
    expect(resp.ok).toBe(true);
    expect(calledZone).toBe('zone1');
    expect(resp.result).toEqual({ zone: 'zone1', text: '[zone1 组装内容]', tokens: 42 });
  });

  it('显式指定 zone 参数', async () => {
    let calledZone = '';
    const loop: ContextLoopLike = {
      previewContextZone: async (zone) => {
        calledZone = zone;
        return { zone, text: 'zone5 内容', tokens: 0 };
      },
    };
    const { client, waitForResponse } = setup(loop);

    client.send({ kind: 'request', id: 'p2', method: 'context.previewZone', params: { zone: 'zone5' } });
    const resp = await waitForResponse('p2');
    expect(resp.ok).toBe(true);
    expect(calledZone).toBe('zone5');
  });

  it('loop 不支持 previewContextZone → 返回错误', async () => {
    const { client, waitForResponse } = setup({});
    client.send({ kind: 'request', id: 'p3', method: 'context.previewZone', params: {} });
    const resp = await waitForResponse('p3');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not supported');
  });

  // ── context.manifest / setZoneEnabled（zone 开关 · manifest 真源）──

  const makeManifest = (): ManifestLike & { writes: Array<{ zone: string; enabled: boolean }> } => {
    const writes: Array<{ zone: string; enabled: boolean }> = [];
    return {
      writes,
      getZones: () => [
        { name: 'zone1', order: 1, enabled: true, sectionCount: 3 },
        { name: 'zone5', order: 5, enabled: false, sectionCount: 1 },
      ],
      setZoneEnabled: (zone, enabled) => {
        writes.push({ zone, enabled });
      },
    };
  };

  it('manifest 返回全部 zone 状态（含 disabled，按序）', async () => {
    const m = makeManifest();
    const { client, waitForResponse } = setup({}, m);

    client.send({ kind: 'request', id: 'm1', method: 'context.manifest', params: {} });
    const resp = await waitForResponse('m1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({
      zones: [
        { name: 'zone1', order: 1, enabled: true, sectionCount: 3 },
        { name: 'zone5', order: 5, enabled: false, sectionCount: 1 },
      ],
    });
  });

  it('manifest 缺依赖（降级）→ 返回空列表', async () => {
    const { client, waitForResponse } = setup({});
    client.send({ kind: 'request', id: 'm2', method: 'context.manifest', params: {} });
    const resp = await waitForResponse('m2');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ zones: [] });
  });

  it('setZoneEnabled 写入开关并回显', async () => {
    const m = makeManifest();
    const { client, waitForResponse } = setup({}, m);

    client.send({
      kind: 'request', id: 'z1', method: 'context.setZoneEnabled',
      params: { zone: 'zone3', enabled: false },
    });
    const resp = await waitForResponse('z1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ ok: true, zone: 'zone3', enabled: false });
    expect(m.writes).toEqual([{ zone: 'zone3', enabled: false }]);
  });

  it('setZoneEnabled 缺依赖 → 报错', async () => {
    const { client, waitForResponse } = setup({});
    client.send({
      kind: 'request', id: 'z2', method: 'context.setZoneEnabled',
      params: { zone: 'zone1', enabled: true },
    });
    const resp = await waitForResponse('z2');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not supported');
  });

  it('setZoneEnabled 缺 zone / enabled 非 boolean → 报错', async () => {
    const m = makeManifest();
    const { client, waitForResponse } = setup({}, m);

    client.send({
      kind: 'request', id: 'z3', method: 'context.setZoneEnabled',
      params: { enabled: true },
    });
    const r1 = await waitForResponse('z3');
    expect(r1.ok).toBe(false);
    expect(r1.error?.message).toContain('requires "zone"');

    client.send({
      kind: 'request', id: 'z4', method: 'context.setZoneEnabled',
      params: { zone: 'zone1', enabled: 'yes' },
    });
    const r2 = await waitForResponse('z4');
    expect(r2.ok).toBe(false);
    expect(r2.error?.message).toContain('boolean "enabled"');
  });
});
