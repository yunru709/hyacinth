// ============================================================
// UI 契约层 — 会话域测试
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
import { createSessionClaims } from '../../memory/session-claims.js';
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
    client.send({ kind: 'request', id: 'c2', method: 'session.create', params: { type: 'companion', channel: 'webui' } });
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
    // 2026-10-24：应答新增 nextSessionId / createdNew（删当前会话的自愈结果），
    // 故用 objectContaining 而不是全等 —— 全等会把"多回一个有用字段"判成失败。
    expect(delResp.result).toEqual(expect.objectContaining({ ok: true, sessionId }));

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
    expect(resp.result).toEqual(expect.objectContaining({ ok: true, deleted: [s1.id, s2.id], notFound: ['no-such-session'] }));

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

// ============================================================
// 删当前会话后的自愈（settleAfterDelete）
// ============================================================
// 规矩：删掉的若正是 loop 指向的会话，域里必须把它切走（或有/无剩余两条路），
// 并把 nextSessionId 回给调用方。前端不再自己排序、也不判断"该不该切"。
//
// 这里用**假 loop**（只实现 currentSessionDir getter + switchSession），因为真实
// AgentLoop 的切换是延迟生效的（pendingSessionDir），断言"切到哪"看假 loop 记录即可。
describe('删当前会话后的自愈', () => {
  /** 带假 loop 的装配：current 指向某个会话目录，switchSession 只记录调用 */
  function setupWithLoop(currentId: string | null) {
    const client = new InProcAdapter('client');
    const serverAdp = new InProcAdapter('server');
    client.connect(serverAdp);
    const server = new UiProtocolServer();
    const switched: string[] = [];
    const loop = {
      get currentSessionDir() {
        return currentId ? sessionManager.getSessionDir(currentId) : undefined;
      },
      async switchSession(dir: string) {
        switched.push(path.basename(dir));
        // 假 loop 立即生效（真实 loop 是延迟到轮次边界，本测试只关心"切到哪"）
        currentId = path.basename(dir);
      },
    };
    const domain = createSessionDomain({
      sessionManager,
      emit: (type, payload) => server.broadcast(type, payload),
      getLoop: () => loop as never,
    });
    server.registerDomain('session', domain);
    server.attach(serverAdp);
    const responses: UiResponse[] = [];
    client.onMessage((m) => { if (m.kind === 'response') responses.push(m); });
    const waitForResponse = async (id: string): Promise<UiResponse> => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`timeout waiting for response "${id}"`);
    };
    const setCurrent = (id: string | null) => { currentId = id; };
    return { client, waitForResponse, switched, setCurrent };
  }

  it('删的不是当前会话 → nextSessionId 为 null，不做任何切换', async () => {
    const s1 = await sessionManager.create('normal');
    const s2 = await sessionManager.create('normal');
    const { client, waitForResponse, switched } = setupWithLoop(s1.id);

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: s2.id } });
    const res = (await waitForResponse('d1')).result as any;
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe(s2.id);
    expect(res.nextSessionId).toBeNull();
    expect(res.createdNew).toBe(false);
    expect(switched).toEqual([]);
  });

  it('删的是当前会话且有剩余 → 切到剩余里最新的一条', async () => {
    const older = await sessionManager.create('normal');
    const newer = await sessionManager.create('normal');
    // create 之间隔一会，保证 updatedAt 有先后（同毫秒会让排序不稳定）
    await new Promise((r) => setTimeout(r, 20));
    const target = await sessionManager.create('normal');
    // 手动把 older 的 meta 时间改早：靠 touch 拿不到，这里直接依赖创建顺序
    const { client, waitForResponse, switched } = setupWithLoop(target.id);

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: target.id } });
    const res = (await waitForResponse('d1')).result as any;
    expect(res.nextSessionId).toBeTruthy();
    expect(res.nextSessionId).not.toBe(target.id);
    expect(res.createdNew).toBe(false);
    // 切到的是剩下两条里 updatedAt 更大的那条
    expect(res.nextSessionId).toBe(newer.id);
    expect(switched).toEqual([newer.id]);
    expect(older.id).toBeTruthy();
  });

  it('删的是最后一条 → 新建一条并切过去', async () => {
    const only = await sessionManager.create('normal');
    const { client, waitForResponse, switched } = setupWithLoop(only.id);

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: only.id } });
    const res = (await waitForResponse('d1')).result as any;
    expect(res.createdNew).toBe(true);
    expect(res.nextSessionId).toBeTruthy();
    expect(res.nextSessionId).not.toBe(only.id);
    expect(switched).toEqual([res.nextSessionId]);
    // 新会话确实落盘了
    const list = await sessionManager.list();
    expect(list.map((s) => s.id)).toContain(res.nextSessionId);
  });

  it('batchDelete 删到当前会话 → 同样自愈（不论当前是哪一条）', async () => {
    const a = await sessionManager.create('normal');
    const b = await sessionManager.create('normal');
    const c = await sessionManager.create('normal');
    const { client, waitForResponse, switched } = setupWithLoop(b.id);

    client.send({
      kind: 'request', id: 'b1', method: 'session.batchDelete',
      params: { sessionIds: [a.id, b.id] },
    });
    const res = (await waitForResponse('b1')).result as any;
    expect(res.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(res.nextSessionId).toBe(c.id);
    expect(switched).toEqual([c.id]);
  });

  it('没有 loop（无 agent 场景）→ 不自愈，但删除本身成功', async () => {
    const only = await sessionManager.create('normal');
    const { client, waitForResponse } = setup();  // 这个 setup 不注入 loop

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: only.id } });
    const res = (await waitForResponse('d1')).result as any;
    expect(res.ok).toBe(true);
    expect(res.nextSessionId).toBeNull();
    expect(res.createdNew).toBe(false);
  });
});

// ── 回归：切换是"待生效"的 ────────────────────────────────────
// 真实 AgentLoop.switchSession 只登记 pendingSessionDir（本轮 tool_result 必须落在
// 原会话，故生效推迟到轮次边界）。于是"空闲时切了会话"之后 currentSessionDir 仍是旧的，
// 而用户界面上显示的是新会话。
//
// 只读 currentSessionDir 判断"删的是不是当前"会**全部漏判**：删了正在看的会话，
// nextSessionId 恒为 null，前端只能自己兜 —— 那正是这次下沉要消灭的东西。
// 这条用假 loop 把两个 getter 显式分开，钉住"必须用 target"。
describe('自愈判定用目标会话（待切换优先）', () => {
  it('current 是旧会话、target 是用户正在看的 → 删 target 触发自愈', async () => {
    const oldOne = await sessionManager.create('normal');
    const viewed = await sessionManager.create('normal');
    const client = new InProcAdapter('client');
    const serverAdp = new InProcAdapter('server');
    client.connect(serverAdp);
    const server = new UiProtocolServer();
    const switched: string[] = [];
    // 模拟"已切到 viewed，但还没到轮次边界"：current 仍指 oldOne
    const loop = {
      get currentSessionDir() { return sessionManager.getSessionDir(oldOne.id); },
      get targetSessionDir() { return sessionManager.getSessionDir(viewed.id); },
      async switchSession(dir: string) { switched.push(path.basename(dir)); },
    };
    server.registerDomain('session', createSessionDomain({
      sessionManager,
      getLoop: () => loop as never,
    }));
    server.attach(serverAdp);
    const responses: UiResponse[] = [];
    client.onMessage((m) => { if (m.kind === 'response') responses.push(m); });
    const waitForResponse = async (id: string): Promise<UiResponse> => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('timeout');
    };

    client.send({ kind: 'request', id: 'd1', method: 'session.delete', params: { sessionId: viewed.id } });
    const res = (await waitForResponse('d1')).result as any;
    // 关键断言：必须触发自愈并切到 oldOne（唯一剩下的）
    expect(res.nextSessionId).toBe(oldOne.id);
    expect(res.createdNew).toBe(false);
    expect(switched).toEqual([oldOne.id]);
  });
});

// ── 会话占用（多标签互斥） ────────────────────────────────────
// 一个会话只允许一个标签驱动：切换前的占用转移必须原子，
// 被他人占用时 loop 绝不能动（否则消息会写进对方会话）。
describe('会话占用（多标签互斥）', () => {
  function setupWithClaims(arg: {
    owner: string;
    claimedId: string | null;
    loopId: string | null;
    claims: ReturnType<typeof createSessionClaims>;
  }) {
    const client = new InProcAdapter('client');
    const serverAdp = new InProcAdapter('server');
    client.connect(serverAdp);
    const server = new UiProtocolServer();
    let claimed = arg.claimedId;
    const switched: string[] = [];
    const loop = {
      get targetSessionDir() {
        return arg.loopId ? sessionManager.getSessionDir(arg.loopId) : undefined;
      },
      async switchSession(dir: string) {
        switched.push(path.basename(dir));
      },
    };
    server.registerDomain('session', createSessionDomain({
      sessionManager,
      getLoop: () => loop as never,
      claims: arg.claims,
      claimOwner: arg.owner,
      getClaimedSessionId: () => claimed,
      setClaimedSessionId: (id) => { claimed = id; },
    }));
    server.attach(serverAdp);
    const responses: UiResponse[] = [];
    client.onMessage((m) => { if (m.kind === 'response') responses.push(m); });
    const waitForResponse = async (id: string): Promise<UiResponse> => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('timeout');
    };
    return { client, waitForResponse, switched, claimed: () => claimed };
  }

  it('目标会话被他人占用 → 拒绝切换（loop 不动、占用不变）', async () => {
    const mine = await sessionManager.create('normal');
    const theirs = await sessionManager.create('normal');
    const claims = createSessionClaims();
    claims.claim(theirs.id, 'other-owner');
    const { client, waitForResponse, switched, claimed } = setupWithClaims({
      owner: 'me', claimedId: mine.id, loopId: mine.id, claims,
    });
    claims.claim(mine.id, 'me');

    client.send({ kind: 'request', id: 's1', method: 'session.switch', params: { sessionId: theirs.id } });
    const resp = await waitForResponse('s1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('另一个标签');
    expect(switched).toEqual([]);
    expect(claims.ownerOf(theirs.id)).toBe('other-owner');
    expect(claimed()).toBe(mine.id);
  });

  it('切换成功 → 占用从旧会话转移到新会话', async () => {
    const a = await sessionManager.create('normal');
    const b = await sessionManager.create('normal');
    const claims = createSessionClaims();
    const { client, waitForResponse, switched, claimed } = setupWithClaims({
      owner: 'me', claimedId: a.id, loopId: a.id, claims,
    });
    claims.claim(a.id, 'me');

    client.send({ kind: 'request', id: 's2', method: 'session.switch', params: { sessionId: b.id } });
    const resp = await waitForResponse('s2');
    expect(resp.ok).toBe(true);
    expect(switched).toEqual([b.id]);
    expect(claims.ownerOf(a.id)).toBeNull();
    expect(claims.ownerOf(b.id)).toBe('me');
    expect(claimed()).toBe(b.id);
  });
});
