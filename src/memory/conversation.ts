import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '../types.js';

export class ConversationStore {
  private readonly maxMessages: number;
  private readonly conversationFile: string;

  /**
   * 追加热路径专用的消息计数缓存。
   *
   * count()/countFull() 都是「读整个文件再数行数」，而 append() 每条消息都会
   * 调用一次（还叠加 appendFull 的第二次），会话长度 n 时总开销是 O(n²) ——
   * 长会话会明显变卡。这里缓存计数，只在裁剪后失效重建。
   *
   * 仅供 append() 内部使用；对外暴露的 count()/countFull() 始终返回精确值。
   */
  private readonly countCache = new Map<string, number>();

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

    // 检查是否需要截断旧消息（走缓存计数，避免每次 append 整文件读取）
    const count = await this.appendCount(sessionDir);
    if (count > this.maxMessages) {
      const removeCount = count - this.maxMessages;
      await this.truncate(sessionDir, removeCount);
      // 裁剪后缓存失效：精确值 = maxMessages
      this.countCache.set(sessionDir, this.maxMessages);
    }

    // 同步写入全量存档（不受压缩器影响，行号稳定）
    await this.appendFull(sessionDir, message);
  }

  /**
   * 追加热路径专用计数：缓存命中 O(1)，未命中时精确读一次并缓存。
   * 调用方须在 append 文件之后调用，返回值为追加后的总条数。
   */
  private async appendCount(sessionDir: string): Promise<number> {
    const cached = this.countCache.get(sessionDir);
    if (cached !== undefined) {
      const next = cached + 1;
      this.countCache.set(sessionDir, next);
      return next;
    }
    const exact = await this.count(sessionDir);
    this.countCache.set(sessionDir, exact);
    return exact;
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
    // 压缩写回会改变消息总数，必须让 append() 的计数缓存失效，
    // 否则后续 append 会基于过期的大计数触发 truncate，切掉真实近况对话。
    this.countCache.delete(sessionDir);
  }

  // ── 全量存档（conversation_full.jsonl）──

  /**
   * 追加消息到全量存档 conversation_full.jsonl。
   *
   * **只追加，绝不删除或重写任何行。**
   *
   * 这是意图簇压缩赖以成立的地基：簇索引持久化的是相对本文件的绝对行号
   * （`orchestrator/loop-cluster.ts` 的 line_start/line_end，
   * 回放时 `fullMsgs.slice(lineStart - 1, lineEnd)`）。一旦从头部删行，所有
   * 历史簇的行号就整体偏移 K 位 —— 压缩会摘要到隔壁意图簇的内容，静默且无法归因。
   *
   * 因此本文件不受 maxMessages 约束。磁盘增长交给会话级清理
   * （SessionManager.cleanup 的 maxAgeDays）处理，而不是在这里截断。
   */
  async appendFull(sessionDir: string, message: Message): Promise<void> {
    const filePath = this.getFullFilePath(sessionDir);
    await ensureDir(sessionDir);
    const line = JSON.stringify(message) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
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
