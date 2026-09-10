// ============================================================
// 黄金主测试（Golden Master）：TUI 远程 / 桌面端迁移回归
// ============================================================
// 用新实现（UiWsSession，统一协议层）重放与录制时完全相同的
// 场景，将规范化事件流与 __golden__/tui-legacy-golden.json
// （旧 TuiWsSession 的录制快照）对比，确保迁移不改变既有行为。
//
// 对比规则：
//   - response / state.update 等协议新机制不在黄金对比范围
//     （normalizeProto 已忽略）
//   - 显式行为升级 allowlist：
//       stop 场景的 interrupt —— 旧协议 stop 是空操作
//       （AgentLoop 无 requestStop），新协议 message.stop 触发
//       loop.interrupt 真实中断。此为有意修复，单独断言。
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { UiWsSession } from './ui-ws-session.js';
import type { UiProtocolSessionBackend } from './ui-protocol-session.js';
import type { AgentFactory } from '../interface.js';
import {
  GOLDEN_SCENARIOS,
  createGoldenLoop,
  normalizeProto,
  waitFor,
  sleep,
  collectOps,
  extractPermRequestId,
  type GoldenScenario,
  type GoldenOp,
  type HandlerRef,
} from './golden-scenarios.js';
import type { OutputHandler } from '../../orchestrator/loop.js';

const GOLDEN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__golden__',
  'tui-legacy-golden.json',
);

// ── backend stub（与契约测试一致的最小实现） ────────────────

function makeBackend(): UiProtocolSessionBackend {
  return {
    configCenter: {
      get: <T = unknown>(p: string): T => (p === 'session.maxTurns' ? 100 as T : undefined as T),
      getAll: () => ({ session: { maxTurns: 100 } }),
      set: () => {},
      merge: () => {},
      reset: () => {},
      watch: () => () => {},
    } as never,
    sessionStore: {
      create: async () => ({ id: 's1', projectKey: 'p', createdAt: 't', updatedAt: 't' }),
      resume: async () => ({ id: 's1', projectKey: 'p', createdAt: 't', updatedAt: 't' }),
      list: async () => [],
      getLatest: async () => null,
      getLatestByChannel: async () => null,
      getSessionDir: () => '/tmp',
    } as never,
    registry: {
      listChannels: () => [],
      upsertChannel: () => {},
      removeChannel: () => {},
      setChannelModel: () => {},
      resetChannelModel: () => {},
      getChannelInfo: () => null,
      getMainProvider: () => null,
      getProviderType: () => 'test',
      getModel: () => 'gm',
      setThinking: () => {},
    } as never,
    manager: { switchProvider: () => {} } as never,
    commandRegistry: { getByCategory: () => new Map(), find: () => undefined } as never,
    listProvidersMeta: () => [{ id: 'test', name: 'Test', defaultModel: 'gm' }],
  };
}

// ── 内存 http server + /tui 端点（模拟 http-webhook） ────────

async function makeServer(behavior: GoldenScenario['behavior']): Promise<{ httpServer: http.Server; port: number }> {
  const ref: HandlerRef = { h: null };
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/tui') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const factory: AgentFactory = {
    createAgent: async (options: unknown) => {
      const opts = options as { outputHandler?: OutputHandler };
      ref.h = opts.outputHandler ?? null;
      return {
        loop: createGoldenLoop(ref, behavior),
        sessionDir: '/tmp/golden_new',
        sessionManager: {} as never,
        toolRegistry: {} as never,
        skillRegistry: {} as never,
      } as never;
    },
  };

  wss.on('connection', (ws) => {
    const session = new UiWsSession(ws, `golden_${Date.now().toString(36)}`, makeBackend());
    session.initialize(factory).catch(() => {});
    ws.on('close', () => {
      session.close().catch(() => {});
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address() as { port: number };
      resolve({ httpServer, port: addr.port });
    });
  });
}

const openClients: (() => void)[] = [];
afterEach(() => {
  for (const close of openClients.splice(0)) close();
});

function connect(port: number): Promise<{
  ws: WebSocket;
  send: (obj: unknown) => void;
  messages: unknown[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tui`);
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
    ws.on('open', () => {
      openClients.push(() => ws.close());
      resolve({ ws, send: (obj) => ws.send(JSON.stringify(obj)), messages });
    });
    ws.on('error', (err) => reject(err));
  });
}

const byEvent = (type: string) => (m: unknown) =>
  (m as { kind?: string }).kind === 'event' && (m as { type?: string }).type === type;

/** 新实现重放单场景：与录制相同的输入序列 → 规范化事件流 */
async function replayScenario(
  port: number,
  scenario: GoldenScenario,
): Promise<GoldenOp[]> {
  const client = await connect(port);
  await waitFor(() => client.messages.some(byEvent('ui.connected')), 3000, 'connected');

  for (const step of scenario.steps) {
    if (step.action === 'chat') {
      client.send({
        kind: 'request',
        id: `g_chat_${step.content ?? 'x'}`,
        method: 'message.chat',
        params: { content: step.content },
      });
      if (scenario.behavior.permission) {
        // loop.run 等待权限应答
        await waitFor(
          () => client.messages.some(byEvent('permission.request')),
          3000,
          'permission request',
        );
        const reqId = extractPermRequestId(client.messages, false);
        client.send({
          kind: 'request',
          id: 'g_perm',
          method: 'permission.resolve',
          params: { id: reqId, result: step.result ?? 'yes' },
        });
      }
      // 回合结束信号：turn_info 或 error
      await waitFor(
        () =>
          client.messages.some(byEvent('message.turn_info')) ||
          client.messages.some(byEvent('message.error')),
        3000,
        'turn end',
      );
    } else if (step.action === 'stop') {
      client.send({ kind: 'request', id: 'g_stop', method: 'message.stop' });
      await sleep(80);
    } else if (step.action === 'permission') {
      const reqId = extractPermRequestId(client.messages, false);
      if (reqId) {
        client.send({
          kind: 'request',
          id: 'g_perm2',
          method: 'permission.resolve',
          params: { id: reqId, result: step.result ?? 'yes' },
        });
      }
    }
  }
  await sleep(50);
  return collectOps(client.messages, normalizeProto);
}

// ════════════════════════════════════════════════════════════
// 黄金对比用例
// ════════════════════════════════════════════════════════════

describe('黄金主测试：UiWsSession 重放 vs 旧 TuiWsSession 录制快照', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf-8')) as Record<
    string,
    GoldenOp[]
  >;

  it.each(GOLDEN_SCENARIOS)('场景 $name 的事件流与黄金快照一致', async (scenario) => {
    const { httpServer, port } = await makeServer(scenario.behavior);
    const ops = await replayScenario(port, scenario);
    const expected = golden[scenario.name];

    if (scenario.name === 'stop') {
      // 显式行为升级：旧协议 stop 是空操作（无输出），
      // 新协议 message.stop → loop.interrupt 真实中断。除 interrupt 外必须与快照一致。
      expect(ops.filter((o) => o.op !== 'interrupt')).toEqual(expected);
      expect(ops.some((o) => o.op === 'interrupt')).toBe(true);
    } else {
      expect(ops).toEqual(expected);
    }
    httpServer.close();
  });
});
