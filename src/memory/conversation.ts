import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../types.js';

export class ConversationStore {
  private readonly maxMessages: number;
  private readonly conversationFile: string;

  constructor(maxMessages: number = 10000, conversationFile: string = 'conversation.jsonl') {
    this.maxMessages = maxMessages;
    this.conversationFile = conversationFile;
  }

  private getFilePath(sessionDir: string): string {
    return path.join(sessionDir, this.conversationFile);
  }

  async ensureFile(filePath: string): Promise<void> {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, '', 'utf-8');
    }
  }

  /**
   * 追加消息到 conversation.jsonl
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
