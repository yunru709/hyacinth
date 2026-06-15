import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export interface ResultBufferConfig {
  /** Session directory for storing buffered files (auto-creates `buffered-results/` subdir). */
  sessionDir: string;
  /** Whether buffering is enabled. Default true. */
  enabled?: boolean;
  /** Size threshold in bytes. Results larger than this are buffered. Default 16384 (16 KB). */
  threshold?: number;
  /** Include a preview of the first N characters in the pointer message. Default true. */
  includePreview?: boolean;
  /** Number of characters to include in preview. Default 500. */
  previewChars?: number;
}

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 16384; // 16 KB
const DEFAULT_PREVIEW_CHARS = 500;
const BUFFER_SUBDIR = 'buffered-results';

// ── ToolResultBuffer ────────────────────────────────────────────────

/**
 * ToolResultBuffer — 通用工具结果中间层
 *
 * 所有工具（内置 / MCP / 插件 / Skill）的执行结果在注入对话历史前经过此类。
 * 当结果字节数超过阈值时，将完整结果写入磁盘缓冲文件，对话中仅注入一条短的
 * "指针消息"。LLM 通过已有的 `read` 工具（含 offset/limit 分页）按需读取。
 *
 * 对标 StormBreaker 模式：AgentLoop 构造函数内自初始化，不需要 factory.ts 注入。
 *
 * 七条原则自检（§0.5）：
 *   ① 单一职责 — 只做"大结果→文件，小结果→透传"
 *   ② 零侵入   — 删除此文件 + 移除 loop.ts 调用→系统正常运行
 *   ③ 外部配置 — 阈值通过 configCenter 控制
 *   ④ 数据分离 — 数据（缓冲文件）/ 配置（阈值）/ 代码（buffer 逻辑）
 *   ⑤ 接口稳定 — 唯一入口 maybeBuffer(result, toolName): string
 *   ⑥ 可独立测试 — 构造字符串→调 maybeBuffer→验证文件和指针格式
 *   ⑦ 跨项目可移植 — 复制到任何 Agent 项目即可用
 */
export class ToolResultBuffer {
  private sessionDir: string;
  private enabled: boolean;
  private threshold: number;
  private includePreview: boolean;
  private previewChars: number;
  private bufferDir: string;
  private initialized = false;

  constructor(config: ResultBufferConfig) {
    this.sessionDir = config.sessionDir;
    this.enabled = config.enabled ?? true;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.includePreview = config.includePreview ?? true;
    this.previewChars = config.previewChars ?? DEFAULT_PREVIEW_CHARS;
    this.bufferDir = join(this.sessionDir, BUFFER_SUBDIR);
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * 如果 `result` 超过阈值，写入磁盘并返回指针消息；否则原样返回。
   * 先折叠连续重复行（日志/错误输出优化），再判断是否需要缓冲。
   *
   * @param result  工具执行返回的原始文本
   * @param toolName  工具名（用于指针消息和文件名，如 `mcp__chrome-devtools__take_snapshot`）
   * @returns 原始结果（≤阈值）或指针消息（>阈值）
   */
  maybeBuffer(result: string, toolName: string): string {
    if (!this.enabled) return result;

    // 折叠连续重复行 — 典型场景：日志中同一错误重复成百上千行
    const folded = this.foldRepeatedLines(result);

    if (folded.length <= this.threshold) return folded;
    return this.bufferToDisk(folded, toolName);
  }

  // ── Internal ────────────────────────────────────────────────────

  /** 写入缓冲文件并生成指针消息。首次调用时懒创建缓冲目录。 */
  private bufferToDisk(result: string, toolName: string): string {
    this.ensureDir();

    const filename = this.buildFilename(toolName, result);
    const filePath = join(this.bufferDir, filename);

    writeFileSync(filePath, result, 'utf-8');

    return this.buildPointerMessage(result, toolName, filePath);
  }

  private ensureDir(): void {
    if (!this.initialized) {
      mkdirSync(this.bufferDir, { recursive: true });
      this.initialized = true;
    }
  }

  /** 生成唯一文件名：`工具名-时间戳-短哈希.txt` */
  private buildFilename(toolName: string, content: string): string {
    const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
    const timestamp = Date.now().toString(36);
    const hash = this.fnv32a(content.slice(0, 512) + content.slice(-256));
    return `${safeName}-${timestamp}-${hash}.txt`;
  }

  /** FNV-1a 32-bit hash — 轻量、确定性、零依赖 */
  private fnv32a(s: string): string {
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * 折叠连续重复行。当同一行连续出现 ≥5 次时，压缩为 "[×N] content"。
   * 针对日志、错误输出等包含大量重复内容的场景，大幅减少 token 消耗。
   */
  private foldRepeatedLines(result: string): string {
    const MIN_REPEAT = 5;
    const lines = result.split('\n');
    if (lines.length < MIN_REPEAT * 2) return result; // 太短不值得扫描

    const folded: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      let count = 1;
      while (i + count < lines.length && lines[i + count] === line) {
        count++;
      }
      if (count >= MIN_REPEAT) {
        folded.push(`[×${count}] ${line}`);
      } else {
        for (let j = 0; j < count; j++) folded.push(lines[i + j]!);
      }
      i += count;
    }
    return folded.join('\n');
  }

  /** 获取缓冲目录路径（用于外部判断文件是否已缓冲）。 */
  getBufferDir(): string {
    return this.bufferDir;
  }

  /** 生成 LLM 可读的指针消息，引导其使用 `read` 工具按需读取。 */
  private buildPointerMessage(
    result: string,
    toolName: string,
    filePath: string,
  ): string {
    const sizeKB = (result.length / 1024).toFixed(1);
    const lineCount = result.split('\n').length;
    const thresholdKB = (this.threshold / 1024).toFixed(0);

    const parts: string[] = [
      `[Result Buffered — exceeds ${thresholdKB} KB limit]`,
      `Tool:  ${toolName}`,
      `Size:  ${result.length.toLocaleString()} bytes (${sizeKB} KB, ${lineCount.toLocaleString()} lines)`,
      `File:  ${filePath}`,
    ];

    if (this.includePreview && this.previewChars > 0) {
      const preview =
        result.length > this.previewChars
          ? result.slice(0, this.previewChars) + '…'
          : result;
      parts.push(
        '',
        `── Preview (first ${this.previewChars} chars) ──`,
        preview,
        '──',
      );
    }

    // Suggest a safe limit that keeps each chunk under the buffer threshold
    const safeLimit = Math.max(50, Math.floor(this.threshold / 120));
    parts.push(
      '',
      `Use read(file_path="${filePath}", offset=1, limit=${safeLimit}) to view in segments.`,
    );

    return parts.join('\n');
  }
}
