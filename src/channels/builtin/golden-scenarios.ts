// ============================================================
// 黄金主测试（Golden Master）公共模块
// ============================================================
// 重构场景的核心保障：先录制旧实现（TuiWsSession 旧协议）在
// 一组场景下的真实输出为"黄金快照"，迁移到 UiWsSession 后
// 重放同一组场景，断言规范化事件流与快照一致（除显式 allowlist
// 的行为升级外），确保重构不改变既有行为。
//
// 本文件只包含：场景定义 + 新旧协议消息的规范化函数 + 驱动
// helper，不依赖任何会话实现，录制脚本与 golden 测试共用。
// ============================================================

import type { OutputHandler } from '../../orchestrator/loop.js';
import type { UiMessage } from '../../ui-protocol/types.js';

// ── 规范化事件流（跨新旧协议的统一语义视图） ────────────────

export type GoldenOp =
  | { op: 'connected' }
  | { op: 'thinking'; content: string }
  | { op: 'text'; content: string }
  | { op: 'status'; message: string; level: string }
  | { op: 'tool_use'; name: string; inputSummary: string }
  | { op: 'tool_result'; content: string; isError: boolean }
  | { op: 'turn_info'; turnCount: number; tokensUsed: number }
  | { op: 'interrupt' }
  | { op: 'permission_req'; toolName: string; input: Record<string, unknown> }
  | { op: 'error'; message: string };

/** 旧协议（TuiWsSession / WebUIOutputHandler）消息 → 规范化 op */
export function normalizeLegacy(m: Record<string, unknown>): GoldenOp | null {
  switch (m.type) {
    case 'connected': return { op: 'connected' };
    case 'thinking': return { op: 'thinking', content: String(m.content ?? '') };
    case 'text': return { op: 'text', content: String(m.content ?? '') };
    case 'status':
      return { op: 'status', message: String(m.message ?? ''), level: String(m.level ?? 'info') };
    case 'tool_use':
      return { op: 'tool_use', name: String(m.name ?? ''), inputSummary: String(m.inputSummary ?? '') };
    case 'tool_result':
      return { op: 'tool_result', content: String(m.content ?? ''), isError: Boolean(m.isError) };
    case 'turn_info':
      return {
        op: 'turn_info',
        turnCount: Number(m.turnCount ?? 0),
        tokensUsed: Number(m.tokensUsed ?? 0),
      };
    case 'interrupt': return { op: 'interrupt' };
    case 'permission':
      return {
        op: 'permission_req',
        toolName: String(m.toolName ?? ''),
        input: (m.input ?? {}) as Record<string, unknown>,
      };
    case 'error': return { op: 'error', message: String(m.message ?? '') };
    default: return null;
  }
}

/** 新协议（ui-protocol）消息 → 规范化 op（response / state.update 等新机制忽略） */
export function normalizeProto(m: UiMessage): GoldenOp | null {
  if (m.kind !== 'event') return null;
  const p = (m.payload ?? {}) as Record<string, unknown>;
  switch (m.type) {
    case 'ui.connected': return { op: 'connected' };
    case 'message.thinking': return { op: 'thinking', content: String(p.content ?? '') };
    case 'message.text': return { op: 'text', content: String(p.content ?? '') };
    case 'message.status':
      return { op: 'status', message: String(p.message ?? ''), level: String(p.level ?? 'info') };
    case 'message.tool_use':
      return {
        op: 'tool_use',
        name: String(p.name ?? ''),
        inputSummary: String(p.inputSummary ?? ''),
      };
    case 'message.tool_result':
      return { op: 'tool_result', content: String(p.content ?? ''), isError: Boolean(p.isError) };
    case 'message.turn_info':
      return {
        op: 'turn_info',
        turnCount: Number((p as { turnCount?: unknown }).turnCount ?? 0),
        tokensUsed: Number((p as { tokensUsed?: unknown }).tokensUsed ?? 0),
      };
    case 'message.interrupt': return { op: 'interrupt' };
    case 'permission.request':
      return {
        op: 'permission_req',
        toolName: String(p.toolName ?? ''),
        input: (p.input ?? {}) as Record<string, unknown>,
      };
    case 'message.error': return { op: 'error', message: String(p.message ?? '') };
    default: return null; // state.update / 其他增强事件：不在黄金对比范围
  }
}

// ── 场景定义（新旧实现共用同一组输入） ───────────────────────

export interface GoldenScenario {
  name: string;
  /** loop 行为：permission 触发权限请求；fail 让 loop.run 抛错 */
  behavior: { permission?: boolean; fail?: boolean };
  /** 客户端动作序列 */
  steps: Array<{ action: 'chat' | 'stop' | 'permission'; content?: string; result?: string }>;
}

export const GOLDEN_SCENARIOS: GoldenScenario[] = [
  {
    name: 'chat',
    behavior: {},
    steps: [{ action: 'chat', content: 'hi' }],
  },
  {
    name: 'permission',
    behavior: { permission: true },
    steps: [{ action: 'chat', content: 'hi' }, { action: 'permission', result: 'yes' }],
  },
  {
    name: 'error',
    behavior: { fail: true },
    steps: [{ action: 'chat', content: 'x' }],
  },
  {
    name: 'stop',
    behavior: {},
    steps: [{ action: 'stop' }],
  },
];

// ── fake loop：模拟 AgentLoop 使用注入的 outputHandler 输出 ──

export interface HandlerRef {
  h: OutputHandler | null;
}

/** 创建黄金场景用 fake loop（新旧实现共用；turnNumber 对齐旧协议读取） */
export function createGoldenLoop(ref: HandlerRef, behavior: { permission?: boolean; fail?: boolean }) {
  return {
    turnNumber: 1,
    getTurnInfo: (tc: number, tu: number) => ({
      turnCount: tc,
      maxTurns: 20,
      tokensUsed: tu,
      maxContextTokens: 200000,
      sessionId: 'golden_sess',
      compressCount: 0,
    }),
    getProviderRoutingInfo: () => ({ providerLabel: 'Golden', isLocal: false, mode: 'auto' }),
    getActiveProvider: () => ({ getProviderType: () => 'test', getModel: () => 'gm' }),
    async run(content: string): Promise<void> {
      if (behavior.fail) throw new Error('boom');
      const h = ref.h;
      if (!h) return;
      h.onThinking?.('思考');
      h.onText?.(`回复: ${content}`);
      h.onStatus?.('完成', 'info');
      h.onToolUse?.('read', 'a.md', 'tool-1');
      h.onToolResult?.('file content', false, 'tool-1');
      if (behavior.permission) {
        const r = await h.onPermissionRequest?.('write', { file: '/tmp/a' });
        h.onStatus?.(`perm=${r ?? 'none'}`, 'info');
      }
    },
  };
}

// ── 驱动 helper ─────────────────────────────────────────────

/** 轮询等待条件成立 */
export async function waitFor(cond: () => boolean, timeout = 3000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 从已接收消息中提取规范化 op 列表 */
export function collectOps(
  messages: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalize: (m: any) => GoldenOp | null,
): GoldenOp[] {
  return messages.map((m) => normalize(m as never)).filter((op): op is GoldenOp => op !== null);
}

/** 从消息流中提取 permission 请求 id（新协议带 id，旧协议无） */
export function extractPermRequestId(
  messages: unknown[],
  isLegacy: boolean,
): string | undefined {
  const last = [...messages].reverse().find((m) => {
    const msg = m as { kind?: string; type?: string; payload?: { id?: string } };
    if (isLegacy) return msg.type === 'permission';
    return msg.kind === 'event' && msg.type === 'permission.request';
  });
  if (!last) return undefined;
  const payload = (last as { payload?: { id?: string } }).payload;
  return payload?.id;
}
