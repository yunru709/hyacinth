// ============================================================
// ClawbotMessageQueue — ClawBot 渠道 per-session 消息队列
// ============================================================
//
// 解决的问题：
//   1. 长轮询收到消息 → 入队即返回 → 不阻塞轮询循环
//   2. 并发 loop.run() → conversation.jsonl 交叉写入
//
// 设计：
//   - 长轮询循环收到消息后入队即返回，立即发起下一次长轮询
//   - 队列按 sessionId 串行消费，保证同一 session 不会并发处理
//   - 队列内去重，防止轮询重试导致重复消息
//   - 背压控制：最大 100 条/queue，超出丢弃最旧消息
//
// ClawBot 是单会话，通常只有一个 session，队列逻辑比飞书简单。
// ============================================================

import type { ChannelEvent, ChannelMessageEvent } from '../../interface.js';

/** 从 ChannelEvent 中提取 messageId（仅 message 类型有） */
function getMessageId(event: ChannelEvent): string | undefined {
  if (event.type === 'message') {
    return (event as ChannelMessageEvent).metadata?.messageId as string | undefined;
  }
  return undefined;
}

type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
  warn?: (msg: string) => void;
};

interface QueueItem {
  event: ChannelEvent;
}

type ProcessFn = (event: ChannelEvent) => Promise<void>;

export class ClawbotMessageQueue {
  private queues = new Map<string, QueueItem[]>();
  private processing = new Map<string, boolean>();
  private processFn: ProcessFn | null = null;
  private logger: Logger;
  private static MAX_QUEUE_SIZE = 100;

  constructor(logger?: Logger) {
    this.logger = logger ?? {
      info: (msg) => process.stderr.write(`[clawbot-queue] ${msg}\n`),
      error: (msg) => process.stderr.write(`[clawbot-queue] ${msg}\n`),
      warn: (msg) => process.stderr.write(`[clawbot-queue] ${msg}\n`),
    };
  }

  /** 设置消息处理函数 */
  setProcessFn(fn: ProcessFn): void {
    this.processFn = fn;
  }

  /** 入队消息（fire-and-forget，立即返回） */
  enqueue(sessionId: string, event: ChannelEvent): void {
    // 1. 队列内去重：检查是否已有相同 messageId
    const messageId = getMessageId(event);
    if (messageId) {
      const queue = this.queues.get(sessionId);
      if (queue?.some(item => getMessageId(item.event) === messageId)) {
        this.logger.info(`queue dedup: dropping duplicate message ${messageId.slice(0, 12)}...`);
        return;
      }
    }

    // 2. 获取或创建队列
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    // 3. 背压控制：超出最大长度时丢弃最旧的消息
    if (queue.length >= ClawbotMessageQueue.MAX_QUEUE_SIZE) {
      const dropped = queue.shift();
      const droppedId = getMessageId(dropped?.event ?? {} as ChannelEvent);
      (this.logger.warn ?? this.logger.error)(
        `queue overflow: dropping oldest message ${droppedId?.slice(0, 12) ?? 'unknown'}...`,
      );
    }

    // 4. 入队
    queue.push({ event });
    this.logger.info(`enqueued message for session ${sessionId.slice(0, 16)}... (queue size: ${queue.length})`);

    // 5. 触发处理（如果当前没有在处理）
    this.processNext(sessionId);
  }

  /** 串行处理下一条消息 */
  private processNext(sessionId: string): void {
    if (this.processing.get(sessionId)) {
      return; // 正在处理中，等当前处理完会自动调用 processNext
    }

    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) {
      return;
    }

    if (!this.processFn) {
      this.logger.error('no processFn set, message will stay in queue');
      return;
    }

    const item = queue.shift()!;
    this.processing.set(sessionId, true);

    // 异步处理，不阻塞入队
    this.processFn(item.event)
      .catch((err) => {
        this.logger.error(
          `process error for session ${sessionId.slice(0, 16)}...: ${String(err instanceof Error ? err.message : err)}`,
        );
      })
      .finally(() => {
        this.processing.set(sessionId, false);
        // 处理完后检查队列中是否还有消息
        const remaining = this.queues.get(sessionId);
        if (remaining && remaining.length > 0) {
          this.processNext(sessionId);
        } else {
          // 队列空了，清理
          this.queues.delete(sessionId);
          this.processing.delete(sessionId);
        }
      });
  }

  /** 获取指定 session 的队列长度 */
  getQueueSize(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** 清理所有队列 */
  clear(): void {
    this.queues.clear();
    this.processing.clear();
  }
}
