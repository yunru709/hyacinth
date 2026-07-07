// ============================================================
// WsOutputHandler — OutputHandler → WebSocket 适配器
// ============================================================
//
// 将 AgentLoop 的 OutputHandler 回调转换为 WebSocket JSON 消息。
// 供 TUI-over-WS 等渠道使用。
// ============================================================

import type { OutputHandler, TurnInfo } from '../../orchestrator/loop.js';

/** WebSocket 最小接口（避免静态依赖 ws 库） */
export interface WsLike {
  send(data: string): void;
  readyState: number;
}

// ws 库的 OPEN 常量
const WS_OPEN = 1;

/** WS 消息（JSON 对象，至少包含 type 字段） */
type WsMessage = Record<string, unknown> & { type: string };

export class WebUIOutputHandler implements OutputHandler {
  private permissionResolve:
    | ((result: 'yes' | 'no' | 'always') => void)
    | null = null;

  constructor(private ws: WsLike) {}

  // ── OutputHandler 实现 ─────────────────────────────────────

  onText(content: string): void {
    this.send({ type: 'text', content });
  }

  onThinking(content: string): void {
    this.send({ type: 'thinking', content });
  }

  onToolUse(name: string, inputSummary: string, toolId?: string): void {
    this.send({
      type: 'tool_use',
      id: toolId ?? `tool_${Date.now()}`,
      name,
      inputSummary,
    });
  }

  onToolResult(content: string, isError: boolean, toolId?: string): void {
    this.send({
      type: 'tool_result',
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
    this.send({ type: 'diff', id: toolId, filePath, diffLines });
  }

  onStatus(message: string, level: 'info' | 'warn' | 'error'): void {
    this.send({ type: 'status', message, level });
  }

  onTurnStart(): void {
    this.send({ type: 'turn_start' });
  }

  onFlush(): void {
    this.send({ type: 'flush' });
  }

  onInterrupt(): void {
    this.send({ type: 'interrupt' });
  }

  onPermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<'yes' | 'no' | 'always'> {
    this.send({ type: 'permission', toolName, input });
    return new Promise<'yes' | 'no' | 'always'>((resolve) => {
      this.permissionResolve = resolve;
    });
  }

  // ── 扩展方法 ───────────────────────────────────────────────

  /** 发送回合状态更新 */
  sendTurnInfo(info: TurnInfo): void {
    this.send({
      type: 'turn_info',
      turnCount: info.turnCount,
      maxTurns: info.maxTurns,
      tokensUsed: info.tokensUsed,
      maxTokens: info.maxContextTokens ?? 200000,
      cacheHitRate: info.cacheHitRate ?? null,
      compressCount: 0,
    });
  }

  /** 响应权限请求（来自 WebSocket 消息） */
  resolvePermission(result: 'yes' | 'no' | 'always'): void {
    if (this.permissionResolve) {
      const resolve = this.permissionResolve;
      this.permissionResolve = null;
      resolve(result);
    }
  }

  // ── 内部方法 ──────────────────────────────────────────────

  private send(msg: WsMessage): void {
    if (this.ws.readyState === WS_OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        // 连接已断开，忽略发送错误
      }
    }
  }
}
