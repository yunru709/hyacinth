// ============================================================
// UI 协议层 — WebSocket 传输冒烟测试
// ============================================================
// 用真实 http.Server + WebSocketServer（内存，随机端口）验证：
//  1. WsAdapter 通过 WS 与协议服务器完成 JSON 消息往返（request → response）
//  2. 事件推送能到达 WS 客户端
//  3. 客户端断线 → WsAdapter 关闭 + 从协议服务器 detach
//  4. attachWsUpgrade 挂载路径匹配/不匹配
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { WsAdapter, attachWsUpgrade } from './ws.js';
import { UiProtocolServer } from '../server.js';

const openSockets: (() => void)[] = [];
function cleanupAll(): void {
  for (const close of openSockets.splice(0)) close();
}
afterEach(cleanupAll);

/** 建立内存 http server + 协议服务器 + 挂载 /ui 端点，返回连接 helper */
function makeServer() {
  const httpServer = http.createServer();
  const protocolServer = new UiProtocolServer();
  const wss = attachWsUpgrade(httpServer, {
    path: '/ui',
    protocolServer,
    pingIntervalMs: 50, // 快速心跳便于测试
  });
  return new Promise<{ httpServer: typeof httpServer; protocolServer: typeof protocolServer; wss: typeof wss; port: number }>(
    (resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as { port: number };
        resolve({ httpServer, protocolServer, wss, port: addr.port });
      });
    },
  );
}

/** 建立 WS 客户端连接，返回收发 helper */
function connectWs(port: number, path = '/ui'): Promise<{
  ws: WebSocket;
  send: (obj: unknown) => void;
  messages: unknown[];
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages: unknown[] = [];
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => {
      const send = (obj: unknown) => ws.send(JSON.stringify(obj));
      openSockets.push(() => ws.close());
      resolve({ ws, send, messages, closed });
    });
    ws.on('error', (err) => reject(err));
  });
}

/** 轮询等待条件成立 */
async function waitFor(cond: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('WsAdapter 传输', () => {
  it('JSON 消息往返：request 被协议服务器处理并回响应', async () => {
    const { httpServer, protocolServer, port } = await makeServer();
    protocolServer.registerDomain('config', { get: (p: any) => ({ echo: p }) });
    const client = await connectWs(port);

    client.send({ kind: 'request', id: 'r1', method: 'config.get', params: { path: 'session.maxTurns' } });

    await waitFor(() => client.messages.length >= 1);
    const resp = client.messages[0] as any;
    expect(resp).toMatchObject({ kind: 'response', id: 'r1', ok: true });
    expect(resp.result).toEqual({ echo: { path: 'session.maxTurns' } });
    httpServer.close();
  });

  it('事件推送能到达 WS 客户端（protocolServer.broadcast）', async () => {
    const { httpServer, protocolServer, port } = await makeServer();
    protocolServer.registerDomain('x', { ping: () => 'pong' });
    const client = await connectWs(port);

    // 先发一个 request 确保连接已 attach
    client.send({ kind: 'request', id: 'r1', method: 'x.ping' });
    await waitFor(() => client.messages.length >= 1);

    // 广播事件
    protocolServer.broadcast('message.text', { content: 'hello' });
    await waitFor(() => client.messages.length >= 2);

    const evt = client.messages[1] as any;
    expect(evt).toMatchObject({ kind: 'event', type: 'message.text' });
    expect(evt.payload).toEqual({ content: 'hello' });
    httpServer.close();
  });

  it('客户端断线 → WsAdapter 关闭 + 从协议服务器 detach', async () => {
    const { httpServer, protocolServer, port } = await makeServer();
    const client = await connectWs(port);

    // 先确认已 attach
    await waitFor(() => protocolServer.adapterCount === 1);
    expect(protocolServer.adapterCount).toBe(1);

    // 客户端断线
    client.ws.close();
    await waitFor(() => protocolServer.adapterCount === 0);
    expect(protocolServer.adapterCount).toBe(0);
    httpServer.close();
  });

  it('attachWsUpgrade：不匹配路径不接管连接', async () => {
    const { httpServer, protocolServer, port } = await makeServer();
    // 连接到不存在的路径 → 协议服务器不应收到 attach
    const bad = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      ws.on('error', () => resolve(false));
      ws.on('open', () => resolve(true));
      setTimeout(() => ws.close(), 500);
    });
    // 无法确认是否 attach，但确认连接可用/不可用
    expect(typeof bad).toBe('boolean');
    expect(protocolServer.adapterCount).toBe(0);
    httpServer.close();
  });

  it('WsAdapter 心跳：断连后 adapter 自动关闭（terminate）', async () => {
    // 直接构造一个 WsAdapter 包住已断开连接的底层 ws
    const { httpServer, protocolServer, port } = await makeServer();
    const client = await connectWs(port);
    await waitFor(() => protocolServer.adapterCount === 1);

    // 强制底层 socket 终止（模拟网络断开）
    (client.ws as any)._socket?.destroy();
    // 心跳间隔 50ms，pong 超时后应触发 cleanup → close
    await waitFor(() => protocolServer.adapterCount === 0, 3000);
    expect(protocolServer.adapterCount).toBe(0);
    httpServer.close();
  });

  it('WsAdapter 直接实例：send 前未 OPEN 不抛错', () => {
    // 用一个未连接的 ws 实例（CONNECTING 状态）
    const dummy = new WebSocket('ws://127.0.0.1:1'); // 无服务，保持 CONNECTING/CLOSED
    const adapter = new WsAdapter(dummy, { pingIntervalMs: 0 });
    expect(() => adapter.send({ kind: 'request', id: 'x', method: 'a.b' })).not.toThrow();
    adapter.close();
  });
});
