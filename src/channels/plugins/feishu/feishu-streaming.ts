// ============================================================
// Feishu 流式输出控制器
// ============================================================
//
// 参考 OpenClaw 的 streaming-card.ts，实现简化版：
//   - 先发送占位卡片
//   - 定期（或累积到一定量）更新卡片内容
//   - 完成后发送最终卡片
// ============================================================

import { sendCard, patchCard, buildMarkdownCard } from './feishu-send.js';
import type { FeishuChannelConfig } from './feishu-config.js';

// ── 默认配置 ──

const DEFAULT_UPDATE_INTERVAL_MS = 800;
const MAX_CARD_TEXT_LENGTH = 4000;

// ── 状态 ──

type StreamingState = 'idle' | 'started' | 'streaming' | 'finished' | 'aborted';

// ── 流式输出控制器 ──

export class FeishuStreamingCard {
  private config: FeishuChannelConfig;
  private state: StreamingState = 'idle';
  private messageId: string | null = null;
  private chatId: string | null = null;
  private replyToMessageId: string | undefined;
  private replyInThread: boolean;

  private buffer = '';
  private lastSentText = '';
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateIntervalMs: number;
  private pendingUpdate = false;

  private onError?: (err: Error) => void;

  constructor(
    config: FeishuChannelConfig,
    options: {
      replyToMessageId?: string;
      replyInThread?: boolean;
      updateIntervalMs?: number;
      onError?: (err: Error) => void;
    } = {},
  ) {
    this.config = config;
    this.replyToMessageId = options.replyToMessageId;
    this.replyInThread = options.replyInThread ?? false;
    this.updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
    this.onError = options.onError;
  }

  // ── 生命周期 ──

  /**
   * 启动流式输出：发送占位卡片
   */
  async start(to: string): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start streaming from state: ${this.state}`);
    }

    this.state = 'started';

    try {
      const placeholderCard = buildMarkdownCard('_思考中..._');
      const result = await sendCard(this.config, {
        to,
        card: placeholderCard,
        replyToMessageId: this.replyToMessageId,
        replyInThread: this.replyInThread,
      });

      this.messageId = result.messageId;
      this.chatId = result.chatId;
      this.state = 'streaming';
    } catch (err) {
      this.state = 'aborted';
      throw err;
    }
  }

  /**
   * 追加文本内容
   * 内部会按间隔触发卡片更新
   */
  append(text: string): void {
    if (this.state !== 'streaming') {
      return;
    }

    this.buffer += text;

    // 如果已有待更新，不重复触发
    if (this.pendingUpdate) {
      return;
    }

    this.pendingUpdate = true;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.flushUpdate();
    }, this.updateIntervalMs);
  }

  /**
   * 重置缓冲区（不清除已发送的卡片，仅清空内存中的累积文本）。
   * 在 Agent 循环的每个新 turn 开始时调用，确保只保留最后一轮输出。
   */
  resetBuffer(): void {
    // 取消待处理的定时更新
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.pendingUpdate = false;
    this.buffer = '';
    this.lastSentText = '';
  }

  /**
   * 完成流式输出：发送最终内容
   */
  async finish(finalText?: string): Promise<void> {
    if (this.state === 'finished' || this.state === 'aborted') {
      return;
    }

    // 取消待处理的更新
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    const text = finalText ?? this.buffer;
    this.state = 'finished';

    if (!this.messageId) {
      return;
    }

    try {
      const card = buildMarkdownCard(text || '_无内容_');
      await patchCard(this.config, {
        messageId: this.messageId,
        card,
      });
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 中止流式输出
   */
  async abort(reason?: string): Promise<void> {
    if (this.state === 'finished' || this.state === 'aborted') {
      return;
    }

    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }

    this.state = 'aborted';

    if (!this.messageId) {
      return;
    }

    try {
      const card = buildMarkdownCard(
        this.buffer
          ? `${this.buffer}\n\n---\n_已中止${reason ? `: ${reason}` : ''}_`
          : `_已中止${reason ? `: ${reason}` : ''}_`,
      );
      await patchCard(this.config, {
        messageId: this.messageId,
        card,
      });
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── 内部方法 ──

  private async flushUpdate(): Promise<void> {
    this.pendingUpdate = false;

    if (this.state !== 'streaming' || !this.messageId) {
      return;
    }

    // 如果内容没有变化，跳过
    if (this.buffer === this.lastSentText) {
      return;
    }

    // 截断过长内容
    const displayText =
      this.buffer.length > MAX_CARD_TEXT_LENGTH
        ? this.buffer.slice(0, MAX_CARD_TEXT_LENGTH) + '\n\n...'
        : this.buffer;

    this.lastSentText = this.buffer;

    try {
      const card = buildMarkdownCard(displayText || '_思考中..._');
      await patchCard(this.config, {
        messageId: this.messageId,
        card,
      });
    } catch (err) {
      // 更新失败不中断流，记录错误即可
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── Getter ──

  getMessageId(): string | null {
    return this.messageId;
  }

  getState(): StreamingState {
    return this.state;
  }
}