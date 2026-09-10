// ============================================================
// UI 协议层 — 权限域测试
// ============================================================
// 覆盖 PendingRequestRegistry（请求-应答关联表）与
// permission.resolve，重点验证：
//  1. 关联表语义：注册→应答→resolver 收值，幂等保护（二次应答失败）
//  2. RPC 端到端：UI 发 permission.resolve → 等待中的 Promise 被 resolve
//  3. 参数校验：缺 id / 非法 result（非 yes|no|always|aor）/ 未知 id
//
// pending 注册表与消息域（ask_user）共享，本测试同时锁定其
// "通用关联表"性质（不绑定权限语义）。
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createPermissionDomain, PendingRequestRegistry } from './permission.js';
import type { UiResponse } from '../types.js';

function setup() {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const pending = new PendingRequestRegistry();
  server.registerDomain('permission', createPermissionDomain({ pending }));
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
  return { client, wait, pending, server };
}

describe('PendingRequestRegistry（请求-应答关联表）', () => {
  it('create 生成唯一 ID', () => {
    const reg = new PendingRequestRegistry();
    const ids = new Set(Array.from({ length: 50 }, () => reg.create()));
    expect(ids.size).toBe(50);
  });

  it('register + resolve：resolver 收到应答值，条目随即移除', () => {
    const reg = new PendingRequestRegistry();
    let answered: unknown;
    reg.register('req_1', (v: string) => { answered = v; });

    expect(reg.has('req_1')).toBe(true);
    expect(reg.size).toBe(1);

    const ok = reg.resolve('req_1', 'yes');
    expect(ok).toBe(true);
    expect(answered).toBe('yes');
    expect(reg.has('req_1')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('resolve 不存在的 id → false（不抛错）', () => {
    const reg = new PendingRequestRegistry();
    expect(reg.resolve('nope', 'yes')).toBe(false);
  });

  it('重复 resolve 同一 id → 第二次 false（幂等保护）', () => {
    const reg = new PendingRequestRegistry();
    let calls = 0;
    reg.register('req_2', () => { calls++; });
    expect(reg.resolve('req_2', 'no')).toBe(true);
    expect(reg.resolve('req_2', 'yes')).toBe(false);
    expect(calls).toBe(1);
  });

  it('clear 清空全部待应答请求（连接断开场景）', () => {
    const reg = new PendingRequestRegistry();
    reg.register('a', () => {});
    reg.register('b', () => {});
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.has('a')).toBe(false);
    expect(reg.resolve('a', 'yes')).toBe(false);
  });
});

describe('permission.resolve（RPC 端到端）', () => {
  it('应答等待中的请求 → resolver 收值、返回 ok 快照', async () => {
    const { client, wait, pending } = setup();
    const waited = new Promise<unknown>((resolve) => pending.register('perm_1', resolve));

    client.send({ kind: 'request', id: 'r1', method: 'permission.resolve', params: { id: 'perm_1', result: 'always' } });
    const resp = await wait('r1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ ok: true, id: 'perm_1', result: 'always' });

    // 请求-应答闭环：OutputHandler.onPermissionRequest 返回的 Promise 在此被 resolve
    expect(await waited).toBe('always');
  });

  it('缺 id → 报错', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'r2', method: 'permission.resolve', params: { result: 'yes' } });
    const resp = await wait('r2');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('requires "id"');
  });

  it.each(['maybe', '', 1, null])('非法 result=%p → 报错（白名单 yes|no|always|aor）', async (bad) => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'r3', method: 'permission.resolve', params: { id: 'perm_x', result: bad } });
    const resp = await wait('r3');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('valid "result"');
  });

  it('未注册的 id → 报错 not found or already resolved', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'r4', method: 'permission.resolve', params: { id: 'ghost', result: 'yes' } });
    const resp = await wait('r4');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not found or already resolved');
  });

  it('同一请求二次应答 → 第二次报错（防重放）', async () => {
    const { client, wait, pending } = setup();
    pending.register('perm_2', () => {});

    client.send({ kind: 'request', id: 'r5', method: 'permission.resolve', params: { id: 'perm_2', result: 'no' } });
    expect((await wait('r5')).ok).toBe(true);

    client.send({ kind: 'request', id: 'r6', method: 'permission.resolve', params: { id: 'perm_2', result: 'no' } });
    const resp = await wait('r6');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not found or already resolved');
  });
});
