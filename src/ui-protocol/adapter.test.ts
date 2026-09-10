// ============================================================
// UI 协议层 — InProcAdapter 冒烟测试
// ============================================================
// 验证：
//  1. 两个 InProcAdapter connect 后可双向互发 UiMessage
//  2. send 消息被对端 onMessage 收到
//  3. close 后消息不再传递
//  4. createInProcPair 便捷工厂可用
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { InProcAdapter, createInProcPair } from './adapter.js';
import type { UiMessage } from './types.js';

function req(id: string, method: string, params?: unknown): UiMessage {
  return { kind: 'request', id, method, params };
}
function resp(id: string, ok = true, result?: unknown): UiMessage {
  return { kind: 'response', id, ok, result };
}

describe('InProcAdapter', () => {
  it('双向互发消息：send 被对端 onMessage 收到', () => {
    const a = new InProcAdapter('a');
    const b = new InProcAdapter('b');
    a.connect(b);

    const bReceived: UiMessage[] = [];
    const aReceived: UiMessage[] = [];
    b.onMessage((m) => bReceived.push(m));
    a.onMessage((m) => aReceived.push(m));

    // a → b
    a.send(req('r1', 'config.get', { path: 'session.maxTurns' }));
    // b → a
    b.send(resp('r1', true, { value: 100 }));

    expect(bReceived).toHaveLength(1);
    expect(bReceived[0]).toMatchObject({ kind: 'request', id: 'r1', method: 'config.get' });
    expect((bReceived[0] as any).params).toEqual({ path: 'session.maxTurns' });

    expect(aReceived).toHaveLength(1);
    expect(aReceived[0]).toMatchObject({ kind: 'response', id: 'r1', ok: true });
    expect((aReceived[0] as any).result).toEqual({ value: 100 });
  });

  it('onMessage 处理器抛错不会中断链路', () => {
    const a = new InProcAdapter('a');
    const b = new InProcAdapter('b');
    a.connect(b);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    b.onMessage(() => {
      throw new Error('boom');
    });

    a.send(req('x', 'state.get'));

    // 对端 handler 抛错被捕获，链路仍在，可继续接收
    a.send(req('y', 'state.get'));
    expect(b.received).toHaveLength(2);
    errorSpy.mockRestore();
  });

  it('close 后消息不再传递', () => {
    const a = new InProcAdapter('a');
    const b = new InProcAdapter('b');
    a.connect(b);

    const bReceived: UiMessage[] = [];
    b.onMessage((m) => bReceived.push(m));

    a.send(req('r1', 'session.list'));
    expect(bReceived).toHaveLength(1);

    a.close();
    a.send(req('r2', 'session.list'));
    expect(bReceived).toHaveLength(1); // 不再新增
    expect(a.closed).toBe(true);
    // 对端 peer 已解除
    expect((a as any).peer).toBeNull();
  });

  it('createInProcPair 返回已互连的 [client, server]', () => {
    const [client, server] = createInProcPair();
    const serverReceived: UiMessage[] = [];
    server.onMessage((m) => serverReceived.push(m));

    client.send(req('r1', 'config.getAll'));
    expect(serverReceived).toHaveLength(1);
    expect(serverReceived[0]).toMatchObject({ kind: 'request', id: 'r1', method: 'config.getAll' });
  });

  it('sent / received 记录可追溯（调试辅助）', () => {
    const a = new InProcAdapter('a');
    const b = new InProcAdapter('b');
    a.connect(b);
    a.send(req('r1', 'model.listProviders'));
    expect(a.sent).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });
});
