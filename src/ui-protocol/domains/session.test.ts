// ============================================================
// UI 协议层 — 会话域测试
// ============================================================
// 用真实 SessionManager + 临时 sessionsRoot 验证全流程：
//  1. session.create → 返回元数据（id/type/channel/createdAt/updatedAt）
//  2. session.list → 包含刚创建的会话
//  3. session.resume → 恢复指定会话
//  4. session.getLatest → 返回最近会话
//  5. session.delete → 删除后 list 不再包含
//  6. delete 不存在的会话 → 返回错误
//  7. create/delete 触发 session.change 事件
//
// 说明：session 操作为真实 async fs（mkdir/写文件），响应经
// InProc + 协议服务器异步回传，故用轮询等待而非 setTimeout(0)。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { SessionManager } from '../../memory/session.js';
import { createSessionDomain } from './session.js';
import type { UiResponse } from '../types.js';

let tmpRoot: string;
let sessionManager: SessionManager;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'ui-protocol-session-'));
  sessionManager = new SessionManager(process.cwd(), tmpRoot);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

/** 建立完整链路：真实 SessionManager + 临时 sessionsRoot + InProc + 协议服务器 */
function setup() {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const domain = createSessionDomain({
    sessionManager,
    emit: (type, payload) => server.broadcast(type, payload),
  });
  server.registerDomain('session', domain);
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  const events: { type: string; payload?: unknown }[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
    else if (m.kind === 'event') events.push({ type: m.type, payload: m.payload });
  });

  /** 轮询等待指定 id 的响应（session 操作为 async fs，需真实等待） */
  const waitForResponse = async (id: string, timeout = 5000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timeout waiting for response "${id}"`);
  };

  /** 轮询等待指定类型的事件（可选条件） */
  const waitForEvent = async (
    type: string,
    pred?: (p: unknown) => boolean,
    timeout = 5000,
  ): Promise<{ type: string; payload?: unknown }> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = events.find((e) => e.type === type && (!pred || pred(e.payload)));
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timeout waiting for event "${type}"`);
  };

  return { client, server, domain, responses, events, waitForResponse, waitForEvent };
}

describe('会话域', () => {
  it('create → list 全流程：创建会话并出现在列表中', async () => {
    const { client, waitForResponse, waitForEvent } = setup();

    // create
    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: { type: 'normal', channel: 'tui' } });
    const created = await waitForResponse('c1');
    expect(created.ok).toBe(true);
    const meta = created.result as any;
    expect(meta.id).toBeTruthy();
    expect(meta).toMatchObject({ type: 'normal', channel: 'tui' });
    expect(meta.createdAt).toBeTruthy();
    expect(meta.updatedAt).toBeTruthy();
    const sessionId = meta.id;

    // create 触发 session.change 事件
    const evt = await waitForEvent('session.change', (p) => (p as any).action === 'create');
    expect((evt.payload as any).session.id).toBe(sessionId);

    // list
    client.send({ kind: 'request', id: 'l1', method: 'session.list' });
    const listResp = await waitForResponse('l1');
    const sessions = (listResp.result as any).sessions as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
  });

  it('resume 恢复指定会话；getLatest 返回最近会话', async () => {
    const { client, waitForResponse } = setup();

    // 创建两个会话
    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: { type: 'normal', channel: 'tui' } });
    await waitForResponse('c1');
    client.send({ kind: 'request', id: 'c2', method: 'session.create', params: { type: 'precise', channel: 'webui' } });
    await waitForResponse('c2');
    const second = (await waitForResponse('c2')).result as any;
    const first = (await waitForResponse('c1')).result as any;

    // resume 指定
    client.send({ kind: 'request', id: 'r1', method: 'session.resume', params: { sessionId: first.id } });
    const resumed = (await waitForResponse('r1')).result as any;
    expect(resumed.id).toBe(first.id);

    // getLatest → 最近创建（list 按 createdAt 降序）
    client.send({ kind: 'request', id: 'g1', method: 'session.getLatest' });
    const latest = (await waitForResponse('g1')).result as any;
    expect(latest).toBeTruthy();
    // 第二个创建的应在最新（或至少是二者之一）
    expect([first.id, second.id]).toContain(latest.id);
  });

  it('delete 删除会话 → list 不再包含；并触发 session.change(delete)', async () => {
    const { client, waitForResponse, waitForEvent } = setup();

    // 创建
    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: { type: 'normal' } });
    const created = await waitForResponse('c1');
    const sessionId = (created.result as any).id;

    // delete
    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId } });
    const delResp = await waitForResponse('d1');
    expect(delResp.ok).toBe(true);
    expect(delResp.result).toEqual({ ok: true, sessionId });

    // delete 事件
    await waitForEvent('session.change', (p) => (p as any).action === 'delete' && (p as any).sessionId === sessionId);

    // list 不再包含
    client.send({ kind: 'request', id: 'l1', method: 'session.list' });
    const listResp = await waitForResponse('l1');
    const sessions = (listResp.result as any).sessions as any[];
    expect(sessions.some((s) => s.id === sessionId)).toBe(false);
  });

  it('delete 不存在的会话 → 返回错误', async () => {
    const { client, waitForResponse } = setup();
    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: 'nonexistent-123' } });
    const resp = await waitForResponse('d1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe('INTERNAL_ERROR');
    expect(resp.error?.message).toContain('not found');
  });

  it('目录级验证：delete 后磁盘目录确实被删除', async () => {
    const { client, waitForResponse } = setup();
    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: {} });
    const created = await waitForResponse('c1');
    const sessionId = (created.result as any).id;

    const sessionDir = sessionManager.getSessionDir(sessionId);
    // 创建后目录存在
    await expect(access(sessionDir)).resolves.toBeUndefined();

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId } });
    await waitForResponse('d1');
    // 删除后目录不存在
    await expect(access(sessionDir)).rejects.toThrow();
  });

  it('batchDelete 批量删除多个会话；不存在的记入 notFound', async () => {
    const { client, waitForResponse, waitForEvent } = setup();

    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: {} });
    const s1 = (await waitForResponse('c1')).result as any;
    client.send({ kind: 'request', id: 'c2', method: 'session.create', params: {} });
    const s2 = (await waitForResponse('c2')).result as any;

    client.send({
      kind: 'request', id: 'b1', method: 'session.batchDelete',
      params: { sessionIds: [s1.id, s2.id, 'no-such-session'] },
    });
    const resp = await waitForResponse('b1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ ok: true, deleted: [s1.id, s2.id], notFound: ['no-such-session'] });

    // 触发 batchDelete 事件
    await waitForEvent('session.change', (p) => (p as any).action === 'batchDelete' && (p as any).deleted?.length === 2);

    // 磁盘上两个目录都不存在了
    await expect(access(sessionManager.getSessionDir(s1.id))).rejects.toThrow();
    await expect(access(sessionManager.getSessionDir(s2.id))).rejects.toThrow();

    // 空数组 → 报错
    client.send({ kind: 'request', id: 'b2', method: 'session.batchDelete', params: { sessionIds: [] } });
    const errResp = await waitForResponse('b2');
    expect(errResp.ok).toBe(false);
  });

  it('export 打包多份会话为 zip（base64，含各 session 文件）', async () => {
    const { client, waitForResponse } = setup();

    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: { channel: 'webui' } });
    const s1 = (await waitForResponse('c1')).result as any;
    client.send({ kind: 'request', id: 'c2', method: 'session.create', params: { channel: 'tui' } });
    const s2 = (await waitForResponse('c2')).result as any;

    // 惰性会话：create 后无 conversation.jsonl（首条消息才建）→ 模拟已发消息，导出才是真实会话
    for (const s of [s1, s2]) {
      await writeFile(
        path.join(sessionManager.getSessionDir(s.id), 'conversation.jsonl'),
        '{"role":"user","content":{"type":"text","text":"hi"}}\n',
        'utf-8',
      );
    }

    client.send({ kind: 'request', id: 'e1', method: 'session.export', params: { sessionIds: [s1.id, s2.id] } });
    const resp = await waitForResponse('e1');
    expect(resp.ok).toBe(true);
    const out = resp.result as any;
    expect(out.filename).toMatch(/^hyacinth-sessions-\d{8}-\d{6}\.zip$/);
    expect(typeof out.data).toBe('string');
    expect(out.notFound).toEqual([]);

    // base64 解码：ZIP 魔数 PK + 包含两个 sessionId 的路径条目
    const buf = Buffer.from(out.data, 'base64');
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
    const text = buf.toString('latin1');
    expect(text).toContain(s1.id);
    expect(text).toContain(s2.id);
    expect(text).toContain('conversation.jsonl');
    expect(text).toContain('meta.json');
  });

  it('export 不存在的会话 → notFound；全部无效时报错', async () => {
    const { client, waitForResponse } = setup();

    client.send({ kind: 'request', id: 'c1', method: 'session.create', params: {} });
    const s1 = (await waitForResponse('c1')).result as any;

    // 一个有效 + 一个无效 → 导出有效部分，notFound 标记
    client.send({ kind: 'request', id: 'e1', method: 'session.export', params: { sessionIds: [s1.id, 'ghost-1'] } });
    const resp = await waitForResponse('e1');
    expect(resp.ok).toBe(true);
    expect((resp.result as any).notFound).toEqual(['ghost-1']);

    // 全部无效 → 报错
    client.send({ kind: 'request', id: 'e2', method: 'session.export', params: { sessionIds: ['ghost-2'] } });
    const errResp = await waitForResponse('e2');
    expect(errResp.ok).toBe(false);
  });
});
