import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

/**
 * 会话事件持久化单一入口（审计问题 1 合并：原 src/event-store.ts 全量并入）。
 *
 * 两类事件写**同一个文件** `sessionDir/events.jsonl`（JSONL 逐行）：
 * - `ConversationEvent`：流式对话事件（user_input/text/thinking/tool_call/
 *   tool_result/error/stop/usage），由执行链经 appendEvent() 写入；
 * - `SessionEvent`：结构化会话事件（session_start/cluster_assign/…），
 *   由装配/旁路/子 Agent 经 EventStore.append() 写入。
 *
 * 历史上两者分居 src/event-store.ts 与本文件（同文件双写入者、两套类型词汇），
 * 现合并为单一入口；文件格式不变，无数据迁移。
 */

// ─── 流式对话事件（原 event-store.ts） ─────────────────────────────

export interface ConversationEvent {
  type: 'user_input' | 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'stop' | 'usage';
  content?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  message?: string;
  reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  timestamp: string;
}

/**
 * Append a single event to the session's events.jsonl file.
 */
export async function appendEvent(
  sessionDir: string,
  event: ConversationEvent,
): Promise<void> {
  const filePath = path.join(sessionDir, 'events.jsonl');
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

/**
 * 合并相邻的流式片段事件（text/thinking 逐 token 各记一条 → 合并为一条）。
 * 历史读取层使用：流式写入保持事件日志语义，读取时还原为完整消息，
 * 避免 UI 历史/浮层出现逐 token 的碎片气泡。
 */
export function coalesceEvents(
  events: ConversationEvent[],
): ConversationEvent[] {
  const out: ConversationEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (
      last && (e.type === 'text' || e.type === 'thinking') && last.type === e.type &&
      String(e.timestamp).slice(0, 16) === String(last.timestamp).slice(0, 16) &&
      !e.name && !last.name
    ) {
      last.content = (last.content || '') + (e.content || '');
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

/**
 * Read the most recent N events from the session's events.jsonl.
 * Returns events sorted from oldest to newest.
 */
export async function readRecentEvents(
  sessionDir: string,
  limit: number = 50,
): Promise<ConversationEvent[]> {
  const filePath = path.join(sessionDir, 'events.jsonl');

  try {
    await fs.access(filePath);
  } catch {
    return []; // No events file yet
  }

  // Read all lines, take the last N
  const lines: string[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      lines.push(line.trim());
    }
  }

  // Take last N lines
  const recent = lines.slice(-limit);

  return recent
    .map(line => {
      try {
        return JSON.parse(line) as ConversationEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is ConversationEvent => e !== null);
}

/**
 * Get the total number of events in the session.
 */
export async function getEventCount(sessionDir: string): Promise<number> {
  const filePath = path.join(sessionDir, 'events.jsonl');
  try {
    await fs.access(filePath);
  } catch {
    return 0;
  }

  let count = 0;
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) count++;
  }

  return count;
}

// ─── 结构化会话事件（原 memory/events.ts） ─────────────────────────

export class EventStore {
  private readonly eventsFile: string;

  constructor(eventsFile: string = 'events.jsonl') {
    this.eventsFile = eventsFile;
  }

  private getFilePath(sessionDir: string): string {
    return path.join(sessionDir, this.eventsFile);
  }

  private async ensureFile(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, '', 'utf-8');
    }
  }
  /**
   * 追加事件到 events.jsonl（收紧为判别联合：SessionEvent 或流式 ConversationEvent）
   */
  async append(sessionDir: string, event: SessionEvent | ConversationEvent): Promise<void> {
    const filePath = this.getFilePath(sessionDir);
    await this.ensureFile(filePath);
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
  }

  /**
   * 读取全部事件
   */
  async readAll(sessionDir: string): Promise<Record<string, unknown>[]> {
    const filePath = this.getFilePath(sessionDir);
    return readJsonlFile<Record<string, unknown>>(filePath);
  }

  /**
   * 读取最后 n 条事件
   */
  async readLast(sessionDir: string, n: number): Promise<Record<string, unknown>[]> {
    const all = await this.readAll(sessionDir);
    return all.slice(-n);
  }
}

export interface SessionStartEvent {
  type: 'session_start';
  session_id: string;
  timestamp: string;
}

export interface UsageEvent {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
  timestamp: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  tool_name: string;
  tool_use_id: string;
  timestamp: string;
}

export interface UserInputEvent {
  type: 'user_input';
  content: string;
  timestamp: string;
}

/** 旁路 Agent 产出——意图簇归类 */
export interface ClusterAssignEvent {
  type: 'cluster_assign';
  cluster_id: string;
  capability: string;
  summary: string;
  /** conversation_full.jsonl 中的行号范围 [start, end]，两端均包含 */
  line_start: number;
  line_end: number;
  timestamp: string;
}

export interface BypassIntentEvent {
  type: 'bypass_intent';
  capability: string;
  confidence: number;
  sessionId: string;
  timestamp: string;
}

export type SessionEvent = SessionStartEvent | UsageEvent | ToolCallEvent | UserInputEvent | ClusterAssignEvent | BypassIntentEvent;

/**
 * 通用 JSONL 文件读取
 */
async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((line: string) => line.trim().length > 0);
    return lines.map((line: string) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}
