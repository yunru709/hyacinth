// ============================================================
// HttpWebhookChannel — /ui 协议端点集成测试
// ============================================================
// 启动真实 HttpWebhookChannel（fastify + WS），验证：
//  1. /ui 端点握手正常：连接后收到 ui.connected 事件，
//     发送 state.get / config.get 请求收到响应（协议往返）
//  2. 现有端点回归：/tui /desktop 仍能建立连接并收到 connected
//  3. 未知路径 upgrade 被拒绝（socket.destroy）
// ============================================================

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { HttpWebhookChannel } from './http-webhook.js';
import { SessionManager } from '../../memory/session.js';
import { appendEvent } from '../../memory/events.js';
import type { AgentFactory } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';

// ── helpers ───────────────────────────────────────────────

/** 模拟 AgentLoop 的最小实现（满足 LoopLike + turnNumber；switchProvider/setThinking 更新内部状态） */
function makeMockLoop(): AgentLoop {
  const state = {
    providerType: 'anthropic',
    model: 'claude-sonnet-5',
    thinkingCalls: [] as Array<{ enabled: boolean; effort?: string | number }>,
  };
  return {
    turnNumber: 1,
    async run() {},
    interrupt() {},
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'sess-ui-test',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: state.providerType, isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({
      getProviderType: () => state.providerType,
      getModel: () => state.model,
      setThinking: (enabled: boolean, effort?: string | number) => {
        state.thinkingCalls.push({ enabled, effort });
      },
    }),
    async switchProvider(providerName: string) {
      state.providerType = providerName;
      if (providerName === 'openai') state.model = 'gpt-5.5';
    },
  } as unknown as AgentLoop;
}

/** 启动一个 http-webhook 测试实例，返回 base url + channel */
async function startChannel(): Promise<{ channel: HttpWebhookChannel; port: number; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ui-webhook-'));
  const provider = {
    getProviderType: () => 'anthropic',
    getModel: () => 'claude-sonnet-5',
  } as never;
  const sessionManager = new SessionManager(cwd) as never;
  const agentFactory: AgentFactory = {
    createAgent: async () => ({ loop: makeMockLoop() }),
  } as never;
  const channel = new HttpWebhookChannel();
  await channel.start({
    // port 0 → 系统自动分配，避免 getFreePort 的 close-后-复用 TOCTOU 竞态（de-flake）
    port: 0,
    host: '127.0.0.1',
    cwd,
    provider,
    sessionManager,
    maxTurns: 20,
    maxContext: 200000,
    agentFactory,
    // 安全契约（kernel/security P0）：WS 未配置 apiKey 一律 401（fail-closed），
    // 测试实例必须带 key，连接方经 connectWs 注入 Bearer 头。
    apiKey: TEST_KEY,
  } as never);
  const port = channel.boundPort;
  if (!port) throw new Error('channel 未暴露实际端口（start 未完成？）');
  return { channel, port, cwd };
}

const openChannels: Array<{ channel: HttpWebhookChannel; cwd: string }> = [];
const openSockets: (() => void)[] = [];

afterEach(() => {
  for (const close of openSockets.splice(0)) close();
});

afterAll(async () => {
  for (const { channel, cwd } of openChannels.splice(0)) {
    await channel.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
});

/** 主测试实例的鉴权 key（startChannel 与 connectWs 共用；WS 无 key 一律 401） */
const TEST_KEY = 'test-secret-key-123';

/** 连接 WS 并收集收到的 JSON 消息（轮询式，无 waiter 竞态） */
function connectWs(port: number, pathname: string): {
  ws: WebSocket;
  messages: Record<string, unknown>[];
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, {
    headers: { Authorization: `Bearer ${TEST_KEY}` },
  });
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data: Buffer) => {
    try {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch { /* 非 JSON 忽略 */ }
  });
  openSockets.push(() => ws.terminate());
  return { ws, messages };
}

/** 轮询等待条件成立（默认 5s；全量并发满载时 WS 握手可能显著变慢 → 放宽到 30s，de-flake） */
async function waitFor(cond: () => boolean, timeout = 30000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── tests ────────────────────────────────────────────────

describe('HttpWebhookChannel /ui 协议端点', () => {
  let port: number;
  let cwd: string;

  beforeAll(async () => {
    const { channel, port: p, cwd: c } = await startChannel();
    openChannels.push({ channel, cwd: c });
    port = p;
    cwd = c;
  });

  it('/ui 握手正常：连接后收到 ui.connected 事件', async () => {
    const { messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1);
    const msg = messages[0];
    expect(msg.kind).toBe('event');
    expect(msg.type).toBe('ui.connected');
    expect((msg.payload as Record<string, unknown>).sessionId).toBeTruthy();
  });

  it('/ui 协议往返：state.get 收到响应', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // 等 ui.connected
    ws.send(JSON.stringify({ kind: 'request', id: 'r1', method: 'state.get' }));
    await waitFor(() => messages.length >= 2);
    const resp = messages[1];
    expect(resp).toMatchObject({ kind: 'response', id: 'r1', ok: true });
    const result = (resp as Record<string, unknown>).result as Record<string, unknown>;
    expect(result).toMatchObject({ model: 'claude-sonnet-5', provider: 'anthropic' });
  });

  it('/ui 协议往返：config.get 收到响应', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1);
    ws.send(JSON.stringify({ kind: 'request', id: 'r2', method: 'config.get', params: { path: 'session.maxTurns' } }));
    await waitFor(() => messages.length >= 2);
    const resp = messages[1];
    expect(resp).toMatchObject({ kind: 'response', id: 'r2', ok: true });
  });

  it('/ui message.history 返回该 session 的 events.jsonl 历史', async () => {
    // 用真实 SessionManager 创建 session 并写入历史事件
    const sm = new SessionManager(cwd);
    const sess = await sm.create('normal');
    const dir = sm.getSessionDir(sess.id);
    await appendEvent(dir, { type: 'user_input', content: '你好', timestamp: new Date().toISOString() });
    await appendEvent(dir, { type: 'text', content: '你好！有什么可以帮你？', timestamp: new Date().toISOString() });

    // 连接 /ui 调 message.history
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    ws.send(JSON.stringify({
      kind: 'request', id: 'h1', method: 'message.history',
      params: { sessionId: sess.id, limit: 50 },
    }));
    await waitFor(() => messages.length >= 2);
    const resp = messages[1];
    expect(resp).toMatchObject({ kind: 'response', id: 'h1', ok: true });
    const result = (resp as Record<string, unknown>).result as { messages: Array<Record<string, unknown>> };
    // create() 会写 session_start 事件，故用包含断言而非硬编码长度
    expect(result.messages.some((m) => m.type === 'user_input' && m.content === '你好')).toBe(true);
    expect(result.messages.some((m) => m.type === 'text' && String(m.content).includes('有什么可以帮你'))).toBe(true);
  });

  it('现有端点回归：/tui 仍能建立连接并收到 connected（迁移后为 ui.connected 事件）', async () => {
    const { messages } = connectWs(port, '/tui');
    await waitFor(() => messages.length >= 1);
    const msg = messages[0] as Record<string, unknown>;
    expect(msg).toMatchObject({ kind: 'event', type: 'ui.connected' });
  });

  it('/ui model.switch 委托真实 loop 后 state.get 反映新 provider', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    // 切到 openai
    ws.send(JSON.stringify({ kind: 'request', id: 's1', method: 'model.switch', params: { provider: 'openai', model: 'gpt-5.5' } }));
    // 响应可能被 model.change 事件插队，按 id 查找 s1 响应
    await waitFor(() => messages.some((m) => (m as any).id === 's1' && (m as any).kind === 'response'));
    const switchResp = messages.find((m) => (m as any).id === 's1')!;
    expect(switchResp).toMatchObject({ kind: 'response', id: 's1', ok: true });
    // state.get 反映新 provider（loop.switchProvider 已更新内部状态）
    ws.send(JSON.stringify({ kind: 'request', id: 'g1', method: 'state.get' }));
    await waitFor(() => messages.some((m) => (m as any).id === 'g1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 'g1')!;
    expect(resp).toMatchObject({ kind: 'response', id: 'g1', ok: true });
    const result = (resp as Record<string, unknown>).result as Record<string, unknown>;
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('/ui model.setThinking 委托真实 provider 且 emit model.change', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    const before = messages.length;
    ws.send(JSON.stringify({ kind: 'request', id: 't1', method: 'model.setThinking', params: { enabled: true, effort: 'high' } }));
    await waitFor(() => messages.some((m) => (m as any).id === 't1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 't1')!;
    expect(resp).toMatchObject({ kind: 'response', id: 't1', ok: true });
    // 事件在 before 之后到达（model.change 或 message.*）
    await waitFor(() => messages.length > before);
    expect(messages.some((m) => (m as any).kind === 'event' && (m as any).type === 'model.change')).toBe(true);
    const change = messages.find((m) => (m as any).type === 'model.change')!;
    expect((change as any).payload).toMatchObject({ action: 'setThinking', enabled: true });
  });

  it('/ui model.listLocalModels 返回本地模型列表（真实桥接 LocalModelModule）', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    ws.send(JSON.stringify({ kind: 'request', id: 'l1', method: 'model.listLocalModels' }));
    await waitFor(() => messages.some((m) => (m as any).id === 'l1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 'l1')!;
    expect(resp).toMatchObject({ kind: 'response', id: 'l1', ok: true });
    const models = ((resp as Record<string, unknown>).result as { models: unknown[] }).models;
    // 测试环境无本地模型注册，返回数组（真实桥接 LocalModelModule.getInstance().list() 已接线）
    expect(Array.isArray(models)).toBe(true);
  });

  it('/ui model.setChannelRole 写入 role→channel 映射（真实 ModelChannelRegistry）', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    // 先确保一个通道存在
    ws.send(JSON.stringify({ kind: 'request', id: 'r0', method: 'model.upsertChannel', params: { name: 'compression', provider: 'deepseek', model: 'deepseek-v4-flash' } }));
    await waitFor(() => messages.some((m) => (m as any).id === 'r0' && (m as any).kind === 'response'));
    // 设置 role 映射
    ws.send(JSON.stringify({ kind: 'request', id: 'r1', method: 'model.setChannelRole', params: { role: 'compression', channel: 'compression' } }));
    await waitFor(() => messages.some((m) => (m as any).id === 'r1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 'r1')!;
    expect(resp).toMatchObject({ kind: 'response', id: 'r1', ok: true });
  });

  it('现有端点回归：/desktop 仍能建立连接并收到 connected（迁移后为 ui.connected 事件）', async () => {
    const { messages } = connectWs(port, '/desktop');
    await waitFor(() => messages.length >= 1);
    const msg = messages[0] as Record<string, unknown>;
    expect(msg).toMatchObject({ kind: 'event', type: 'ui.connected' });
  });

  it('/ui command.execute 委托内置 executor 返回非 backend-not-wired', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    // model/online/<provider>/<model> 是真实非 executeLocal 后端命令，应走内置 executor
    ws.send(JSON.stringify({
      kind: 'request', id: 'c1', method: 'command.execute',
      params: { name: 'model/online/openai/gpt-5.5' },
    }));
    await waitFor(() => messages.some((m) => (m as any).id === 'c1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 'c1')!;
    if (!(resp as any).ok) console.log('DIAG resp =', JSON.stringify(resp));
    expect(resp).toMatchObject({ kind: 'response', id: 'c1', ok: true });
    const result = (resp as Record<string, unknown>).result as Record<string, unknown>;
    // 非 backend-not-wired：executor 已执行，返回真实切换结果
    expect(result.unsupported).toBeUndefined();
    expect(result.command).toBe('model/online/openai/gpt-5.5');
    expect(result.result).toMatchObject({ ok: true, provider: 'openai', model: 'gpt-5.5' });
  });

  it('/ui schedule.list 域已注册（mock loop 无调度器 → 返回空列表不报错）', async () => {
    const { ws, messages } = connectWs(port, '/ui');
    await waitFor(() => messages.length >= 1); // ui.connected
    ws.send(JSON.stringify({ kind: 'request', id: 'sl1', method: 'schedule.list' }));
    await waitFor(() => messages.some((m) => (m as any).id === 'sl1' && (m as any).kind === 'response'));
    const resp = messages.find((m) => (m as any).id === 'sl1')!;
    expect(resp).toMatchObject({ kind: 'response', id: 'sl1', ok: true });
    const result = (resp as Record<string, unknown>).result as Record<string, unknown>;
    // mock loop 无 getScheduler → tasks 为空数组（协议层不抛错）
    expect(Array.isArray((result as { tasks?: unknown }).tasks)).toBe(true);
    expect((result as { tasks: unknown[] }).tasks).toHaveLength(0);
  });
});

// ── WS 认证（安全漏洞回归）───────────────────────────────────────────

describe('HttpWebhookChannel WS 认证（Bearer token）', () => {
  let port: number;
  let cwd: string;
  const TEST_KEY = 'test-secret-key-123';

  beforeAll(async () => {
    const cwd0 = await mkdtemp(path.join(tmpdir(), 'ui-webhook-auth-'));
    const provider = { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never;
    const sessionManager = new SessionManager(cwd0) as never;
    const agentFactory: AgentFactory = { createAgent: async () => ({ loop: makeMockLoop() }) } as never;
    const channel = new HttpWebhookChannel();
    await channel.start({
      port: 0, // 自动分配，避免 TOCTOU（de-flake）
      host: '127.0.0.1',
      cwd: cwd0,
      provider,
      sessionManager,
      maxTurns: 20,
      maxContext: 200000,
      agentFactory,
      apiKey: TEST_KEY,
    } as never);
    openChannels.push({ channel, cwd: cwd0 });
    port = channel.boundPort;
    cwd = cwd0;
  });

  it('无 Authorization 头的 WS 连接被拒绝（401 + socket 销毁）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
    openSockets.push(() => ws.terminate());

    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', () => resolve('error'));
      setTimeout(() => resolve('open'), 3000); // 兜底：3s 未定即视为 open
    });

    expect(outcome).toBe('error');
  });

  it('错误 token 的 WS 连接被拒绝', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers: { Authorization: 'Bearer wrong-key' } });
    openSockets.push(() => ws.terminate());

    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', () => resolve('error'));
      setTimeout(() => resolve('open'), 3000);
    });

    expect(outcome).toBe('error');
  });

  it('正确 token 的 WS 连接成功并收到 ui.connected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`, { headers: { Authorization: `Bearer ${TEST_KEY}` } });
    openSockets.push(() => ws.terminate());
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer) => {
      try { messages.push(JSON.parse(data.toString()) as Record<string, unknown>); } catch { /* ignore */ }
    });

    await waitFor(() => messages.length >= 1);
    const msg = messages[0];
    expect(msg).toMatchObject({ kind: 'event', type: 'ui.connected' });
  });

  it('浏览器场景：?token= 查询参数通过 WS 鉴权（浏览器无法设置 Authorization 头）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui?token=${encodeURIComponent(TEST_KEY)}`);
    openSockets.push(() => ws.terminate());
    const messages: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer) => {
      try { messages.push(JSON.parse(data.toString()) as Record<string, unknown>); } catch { /* ignore */ }
    });

    await waitFor(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ kind: 'event', type: 'ui.connected' });
  });

  it('?token= 错误值同样被拒绝（常量时间比较，不因查询参数通道放宽）', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ui?token=wrong-key`);
    openSockets.push(() => ws.terminate());
    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', () => resolve('error'));
      setTimeout(() => resolve('open'), 3000);
    });
    expect(outcome).toBe('error');
  });

  it('未配置 apiKey 的实例：WS 升级一律 401（fail-closed，不再放行）', async () => {
    // 独立启动一个不带 apiKey 的实例，锁定 kernel/security P0 的新契约
    const cwd0 = await mkdtemp(path.join(tmpdir(), 'ui-webhook-nokey-'));
    const channel = new HttpWebhookChannel();
    await channel.start({
      port: 0,
      host: '127.0.0.1',
      cwd: cwd0,
      provider: { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never,
      sessionManager: new SessionManager(cwd0) as never,
      maxTurns: 20,
      maxContext: 200000,
      agentFactory: { createAgent: async () => ({ loop: makeMockLoop() }) } as never,
    } as never);
    openChannels.push({ channel, cwd: cwd0 });

    const ws = new WebSocket(`ws://127.0.0.1:${channel.boundPort}/ui`);
    openSockets.push(() => ws.terminate());
    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', () => resolve('error'));
      setTimeout(() => resolve('open'), 3000);
    });
    expect(outcome).toBe('error');
  });
});
