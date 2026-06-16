// ============================================================
// MessageQueue — channel-agnostic message queue data structure
// ============================================================
//
// Design:
//   - Pure data structure — no processing/consumption logic.
//   - Each channel (TUI, Feishu, WebUI, etc.) owns its own consumer loop.
//   - Static helpers for insert-mode detection (!message! syntax).
//   - Insert-mode items go to the FRONT (unshift), queue-mode to the BACK (push).
//   - Max 100 items; overflow drops oldest.
//
// Reusability:
//   - `detectMode()` / `stripMarkers()` are static — any channel can use them.
//   - `enqueue()` / `dequeue()` / `pop()` — standard queue API.
// ============================================================

export enum QueueMessageMode {
  Queue = 'queue',
  Insert = 'insert',
}

export interface QueueItem {
  text: string;
  mode: QueueMessageMode;
  timestamp: number;
}

export class MessageQueue {
  private items: QueueItem[] = [];
  static readonly MAX_QUEUE_SIZE = 100;

  // ── Static helpers ──────────────────────────────────────

  /** Detect if a message uses insert-mode syntax: "!...text...!" */
  static detectMode(text: string): QueueMessageMode {
    const trimmed = text.trim();
    if (trimmed.length > 2 && trimmed.startsWith('!') && trimmed.endsWith('!')) {
      return QueueMessageMode.Insert;
    }
    return QueueMessageMode.Queue;
  }

  /** Strip "!" markers from insert-mode messages. No-op for queue-mode. */
  static stripMarkers(text: string): string {
    const trimmed = text.trim();
    if (MessageQueue.detectMode(trimmed) === QueueMessageMode.Insert) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  // ── Instance API ────────────────────────────────────────

  /**
   * Enqueue a message. Insert-mode goes to the front (unshift),
   * queue-mode goes to the back (push).
   */
  enqueue(text: string, mode: QueueMessageMode): QueueItem {
    if (this.items.length >= MessageQueue.MAX_QUEUE_SIZE) {
      this.items.shift(); // drop oldest
    }
    const item: QueueItem = { text, mode, timestamp: Date.now() };
    if (mode === QueueMessageMode.Insert) {
      this.items.unshift(item);
    } else {
      this.items.push(item);
    }
    return item;
  }

  /** Remove and return the first item. */
  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  /** Remove and return the last item (for Backspace-on-empty cancellation). */
  pop(): QueueItem | undefined {
    return this.items.pop();
  }

  /** Peek at the first item without removing. */
  peek(): QueueItem | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items.length = 0;
  }

  /** Read-only view of all items (for display/debugging). */
  getItems(): readonly QueueItem[] {
    return this.items;
  }
}
