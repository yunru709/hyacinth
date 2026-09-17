// ============================================================
// UI 协议层 — 消息域（message.*）
// ============================================================
// 覆盖 UI 对对话消息的全部操作：
//   message.chat   发送用户消息 → 转发 loop.run
//   message.stop   中断当前回合 → 转发 loop.interrupt
//   message.askUserResolve  应答 ask_user 表单（JSON 答案）
//
// ProtocolOutputHandler：实现后端 OutputHandler 接口，把
// AgentLoop 的每个回调转换成 message.* 事件广播给所有 UI：
//   onText      → message.text
//   onThinking  → message.thinking
//   onToolUse   → message.tool_use
//   onToolResult→ message.tool_result
//   onDiff      → message.diff
//   onStatus    → message.status
//   onTurnStart → message.turn_start
//   onFlush     → message.flush
//   onInterrupt → message.interrupt
//   onPermissionRequest → permission.request（带 id，异步应答）
//   onAskUser   → message.ask_user（带 id，异步应答）
//
// 依赖结构化 LoopLike（真实 AgentLoop 兼容）+ PendingRequestRegistry。
// ============================================================

import type { OutputHandler, AskUserQuestion } from '../../orchestrator/loop.js';
import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';
import type { PermissionResult, StateSnapshot, HistoryMessage } from '../types.js';
import type { LoopLike } from './state.js';
import { buildStateSnapshot } from './state.js';
import { PendingRequestRegistry } from './permission.js';

// ────────────────────────────────────────────────────────────
// 消息域选项
// ────────────────────────────────────────────────────────────

export interface MessageDomainOptions {
  /** AgentLoop 最小接口（chat/stop/turnInfo/state 组装） */
  loop: LoopLike;
  /** 事件推送（绑定到 server.broadcast） */
  emit: (type: string, payload?: unknown) => void;
  /** 请求-应答关联表（permission + ask_user 共用） */
  pending: PendingRequestRegistry;
  /** 当前回合计数提供者（缺省 0） */
  turnCount?: () => number;
  /** 当前 token 使用提供者（缺省 0） */
  tokensUsed?: () => number;
  /** 历史消息提供者（message.history 用；由桥接层注入 event-store 读取） */
  historyProvider?: (sessionId: string, limit?: number) => Promise<HistoryMessage[]>;
}

// ────────────────────────────────────────────────────────────
// ProtocolOutputHandler — OutputHandler → message.* 事件广播
// ────────────────────────────────────────────────────────────

export class ProtocolOutputHandler implements OutputHandler {
  constructor(
    private emit: (type: string, payload?: unknown) => void,
    private pending: PendingRequestRegistry,
  ) {}

  onText(content: string): void {
    this.emit(UI_EVENT.MESSAGE_TEXT, { content });
  }

  /** say 交付（模型的"嘴"）：独立事件，UI 据此用不同样式渲染 */
  onSay(content: string): void {
    this.emit(UI_EVENT.MESSAGE_SAY, { content });
  }

  onThinking(content: string): void {
    this.emit(UI_EVENT.MESSAGE_THINKING, { content });
  }

  onToolUse(name: string, inputSummary: string, toolId?: string): void {
    this.emit(UI_EVENT.MESSAGE_TOOL_USE, {
      id: toolId ?? `tool_${Date.now()}`,
      name,
      inputSummary,
    });
  }

  onToolResult(content: string, isError: boolean, toolId?: string): void {
    this.emit(UI_EVENT.MESSAGE_TOOL_RESULT, {
      id: toolId ?? '',
      content,
      isError,
    });
  }

  onDiff(
    toolId: string,
    filePath: string,
    diffLines: Array<{ kind: string; text: string }>,
  ): void {
    this.emit(UI_EVENT.MESSAGE_DIFF, { id: toolId, filePath, diffLines });
  }

  onStatus(message: string, level: 'info' | 'warn' | 'error'): void {
    this.emit(UI_EVENT.MESSAGE_STATUS, { message, level });
  }

  /** 通用事件通道：非 message 正文的后端推送（陪伴语音等）原样转发 */
  onEvent(type: string, payload?: unknown): void {
    this.emit(type, payload);
  }

  onTurnStart(): void {
    this.emit(UI_EVENT.MESSAGE_TURN_START);
  }

  onFlush(): void {
    this.emit(UI_EVENT.MESSAGE_FLUSH);
  }

  onInterrupt(): void {
    this.emit(UI_EVENT.MESSAGE_INTERRUPT);
  }

  // ⚠ 以下两个必须写成箭头函数字段，不能写成普通方法（2026-09-18 实修）：
  // AgentLoop 构造 / setOutputHandler 会把 outputHandler.onAskUser「摘」下来
  // 存进 this.askUserHandler（loop.ts:519 / :891），工具侧裸调用
  // handler(questions)（tools/ask-user.ts）时接收者已丢失。
  // 普通方法的 this 依赖调用接收者 → this===undefined →
  // "Cannot read properties of undefined (reading 'pending')"。
  // 箭头字段把 this 词法绑定在实例上，怎么传递/摘取都安全。

  onPermissionRequest = (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const id = this.pending.create();
    this.emit(UI_EVENT.PERMISSION_REQUEST, { id, toolName, input });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.register(id, resolve);
    });
  };

  onAskUser = (questions: AskUserQuestion[]): Promise<string> => {
    const id = this.pending.create();
    this.emit(UI_EVENT.MESSAGE_ASK_USER, { id, questions });
    return new Promise<string>((resolve) => {
      this.pending.register(id, resolve);
    });
  };
}

// ────────────────────────────────────────────────────────────
// 消息域工厂
// ────────────────────────────────────────────────────────────

export function createMessageDomain(options: MessageDomainOptions): DomainHandler {
  const {
    loop,
    emit,
    pending,
    turnCount = () => 0,
    tokensUsed = () => 0,
    historyProvider,
  } = options;

  /** 广播当前状态快照（turn_info 之后推送 state.update） */
  function broadcastStateUpdate(): StateSnapshot {
    const snapshot = buildStateSnapshot(loop, turnCount(), tokensUsed());
    emit(UI_EVENT.STATE_UPDATE, snapshot);
    return snapshot;
  }

  return {
    // ── message.chat ───────────────────────────────────────
    async chat(params: unknown): Promise<{ ok: true }> {
      const { content } = (params ?? {}) as { content?: string };
      if (!content || typeof content !== 'string') {
        throw new Error('message.chat requires string "content"');
      }
      if (!loop.run) {
        throw new Error('loop does not support chat (run not implemented)');
      }
      try {
        await loop.run(content);
      } catch (err) {
        // 回合执行出错 → 广播 message.error（前端停止 thinking 并展示错误），再上抛给协议层返回错误响应
        emit(UI_EVENT.MESSAGE_ERROR, { message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      // 回合结束后广播 turn_info + state.update（客户端刷新状态栏）
      emit(UI_EVENT.MESSAGE_TURN_INFO, loop.getTurnInfo(turnCount(), tokensUsed()));
      broadcastStateUpdate();
      return { ok: true };
    },

    // ── message.stop ───────────────────────────────────────
    stop(): { ok: true } {
      // 通过 interrupt 中断当前回合（AgentLoop.interrupt 幂等）
      loop.interrupt?.();
      emit(UI_EVENT.MESSAGE_INTERRUPT);
      return { ok: true };
    },

    // ── message.history ────────────────────────────────────
    async history(params: unknown): Promise<{ messages: HistoryMessage[] }> {
      const { sessionId, limit } = (params ?? {}) as { sessionId?: string; limit?: number };
      if (!sessionId) throw new Error('message.history requires "sessionId"');
      if (!historyProvider) {
        throw new Error('message.history not supported (historyProvider not wired)');
      }
      const messages = await historyProvider(sessionId, limit ?? 50);
      return { messages };
    },

    // ── message.askUserResolve ─────────────────────────────
    askUserResolve(params: unknown): { ok: true } {
      const { id, answer } = (params ?? {}) as { id?: string; answer?: string };
      if (!id) throw new Error('message.askUserResolve requires "id"');
      const ok = pending.resolve(id, answer ?? '');
      if (!ok) {
        throw new Error(`ask_user request "${id}" not found or already resolved`);
      }
      return { ok: true };
    },
  };
}
