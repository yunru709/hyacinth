import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../types.js';

export class ConversationStore {
  private readonly maxMessages: number;
  private readonly conversationFile: string;

  /** 全量存档文件名（永远追加，永不压缩，行号稳定） */
  static readonly FULL_FILE = 'conversation_full.jsonl';

  constructor(maxMessages: number = 10000, conversationFile: string = 'conversation.jsonl') {
    this.maxMessages = maxMessages;
    this.conversationFile = conversationFile;
  }

  private getFilePath(sessionDir: string): string {
    return path.join(sessionDir, this.conversationFile);
  }

  private getFullFilePath(sessionDir: string): string {
    return path.join(sessionDir, ConversationStore.FULL_FILE);
  }

  async ensureFile(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, '', 'utf-8');
    }
  }

  /**
   * 追加消息到 conversation.jsonl，同时同步写入全量存档。
   */
  async append(sessionDir: string, message: Message): Promise<void> {
    const filePath = this.getFilePath(sessionDir);
    await ensureDir(sessionDir);
    const line = JSON.stringify(message) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');

    // 检查是否需要截断旧消息
    const count = await this.count(sessionDir);
    if (count > this.maxMessages) {
      await this.truncate(sessionDir, count - this.maxMessages);
    }

    // 同步写入全量存档（不受压缩器影响，行号稳定）
    await this.appendFull(sessionDir, message);
  }

  /**
   * 读取全部消息
   */
  async readAll(sessionDir: string): Promise<Message[]> {
    const filePath = this.getFilePath(sessionDir);
    return readJsonlFile<Message>(filePath);
  }

  /**
   * 读取最后 n 条消息
   */
  async readLast(sessionDir: string, n: number): Promise<Message[]> {
    const all = await this.readAll(sessionDir);
    return all.slice(-n);
  }

  /**
   * 统计消息数量
   */
  async count(sessionDir: string): Promise<number> {
    const all = await this.readAll(sessionDir);
    return all.length;
  }

  /**
   * 截断旧消息，保留最新的消息
   */
  private async truncate(sessionDir: string, removeCount: number): Promise<void> {
    const filePath = this.getFilePath(sessionDir);
    const lines = await this.readAll(sessionDir);

    // 保留最新的消息，移除最旧的
    const kept = lines.slice(removeCount);
    const content = kept.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * 替换全部消息（用于压缩后写回）
   * 使用 write-to-temp + rename 原子写入模式，防止写入过程中崩溃导致文件损坏
   */
  async replace(sessionDir: string, messages: Message[]): Promise<void> {
    const filePath = this.getFilePath(sessionDir);
    await ensureDir(sessionDir);
    const content = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    // 原子替换：先写临时文件，再 rename
    // Windows 上 rename 在目标文件存在时会失败，需先 unlink
    try {
      await fs.unlink(filePath);
    } catch {
      // 原文件不存在，忽略
    }
    await fs.rename(tmpPath, filePath);
  }

  // ── 全量存档（conversation_full.jsonl）──

  /**
   * 追加消息到全量存档 conversation_full.jsonl。
   * 永远追加，不受压缩器影响。行号稳定（仅追加，不删中间行）。
   */
  async appendFull(sessionDir: string, message: Message): Promise<void> {
    const filePath = this.getFullFilePath(sessionDir);
    await ensureDir(sessionDir);
    const line = JSON.stringify(message) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');

    const count = await this.countFull(sessionDir);
    if (count > this.maxMessages) {
      await this.truncateFull(sessionDir, count - this.maxMessages);
    }
  }

  /** 读取全量存档全部消息 */
  async readFull(sessionDir: string): Promise<Message[]> {
    return readJsonlFile<Message>(this.getFullFilePath(sessionDir));
  }

  /** 统计全量存档消息数量 */
  async countFull(sessionDir: string): Promise<number> {
    const all = await this.readFull(sessionDir);
    return all.length;
  }

  /** 截断全量存档旧消息 */
  private async truncateFull(sessionDir: string, removeCount: number): Promise<void> {
    const filePath = this.getFullFilePath(sessionDir);
    const lines = await this.readFull(sessionDir);
    const kept = lines.slice(removeCount);
    const content = kept.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * 给全量存档中 [lineStart, lineEnd]（两端包含，行号从 1 开始）范围内的消息写入簇标记。
   * 使用 write-to-temp + rename 原子写入，防止中途崩溃损坏归档。
   */
  async markCluster(
    sessionDir: string,
    lineStart: number,
    lineEnd: number,
    clusterId: string,
  ): Promise<void> {
    const filePath = this.getFullFilePath(sessionDir);
    const msgs = await this.readFull(sessionDir);
    let changed = false;
    for (let i = Math.max(0, lineStart - 1); i <= lineEnd - 1 && i < msgs.length; i++) {
      if (msgs[i]._cluster_id !== clusterId) {
        msgs[i]._cluster_id = clusterId;
        changed = true;
      }
    }
    if (!changed) return;
    const content = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.unlink(filePath);
    } catch {
      // 原文件不存在，忽略
    }
    await fs.rename(tmpPath, filePath);
  }

  /**
   * 给全量存档中 [lineStart, lineStart+count)（行号从 1 开始）的消息写入 _compressed 标记
   * （决策 C：被压缩消息不丢弃，追加标记，仅保留最近一次压缩记录，覆盖而非追加）。
   * 使用 write-to-temp + rename 原子写入，防止中途崩溃损坏归档。
   */
  async markCompressed(
    sessionDir: string,
    lineStart: number,
    count: number,
    marker: NonNullable<Message['_compressed']>,
  ): Promise<void> {
    if (count <= 0) return;
    const filePath = this.getFullFilePath(sessionDir);
    const msgs = await this.readFull(sessionDir);
    let changed = false;
    const end = Math.min(lineStart - 1 + count, msgs.length);
    for (let i = Math.max(0, lineStart - 1); i < end; i++) {
      if (msgs[i]._compressed) continue; // 仅保留最近一次压缩记录（覆盖而非追加）
      msgs[i]._compressed = marker;
      changed = true;
    }
    if (!changed) return;
    const content = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.unlink(filePath);
    } catch {
      // 原文件不存在，忽略
    }
    await fs.rename(tmpPath, filePath);
  }
}

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

/**
 * 确保目录存在
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
