import fs from 'node:fs/promises';
import path from 'node:path';

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
   * 追加事件到 events.jsonl
   */
  async append(sessionDir: string, event: Record<string, unknown>): Promise<void> {
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

export type SessionEvent = SessionStartEvent | UsageEvent | ToolCallEvent | UserInputEvent | ClusterAssignEvent;

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
