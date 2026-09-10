/**
 * 差分压缩引擎 — Agent 框架的上下文压缩模块
 *
 * Phase 1: ToolOutputTrimmer — 无 LLM 调用的轻量压缩（规则裁剪）
 * Phase 2: StructuredSummarizer — 首次结构化摘要（LLM 调用）
 * Phase 3: StructuredSummarizer — 增量摘要更新（LLM 调用）
 * Phase 4: 保护区规则裁剪 — 最终兜底（无 LLM 调用）
 *
 * 多轮迭代压缩：每轮按 token 比例动态分层，LLM 压缩最旧部分，
 * 检查收敛后决定是否继续下一轮，最多 3 轮。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  Message,
  MessageContent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  StreamEvent,
} from '../types.js';
import type { Provider } from '../provider/interface.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { GitManager } from '../evolution/git-manager.js';
import { SummaryStore } from '../memory/summary.js';
import { loadPrompt } from '../prompts/loader.js';
import { createLogger } from '../logging/logger.js';
import { compressorUserId } from '../provider/user-id.js';
import {
  safetyThreshold,
  targetRatio,
  clusterBudgetRatio,
  maxCompressRounds,
  trimWindow,
} from './context-config.js';



// ─── 工具函数 ────────────────────────────────────────────────────────

const logger = createLogger('compressor');

/** 判断 MessageContent 是否为 ToolResultContent */
function isToolResult(content: MessageContent): content is ToolResultContent {
  return content.type === 'tool_result';
}

/** 判断 MessageContent 是否为 ToolUseContent */
function isToolUse(content: MessageContent): content is ToolUseContent {
  return content.type === 'tool_use';
}

/** 判断 MessageContent 是否为 TextContent */
function isText(content: MessageContent): content is TextContent {
  return content.type === 'text';
}

/** 计算 MD5 哈希 */
function md5(input: string): string {
  return createHash('md5').update(input).digest('hex');
}

/** 将 Message.content 统一为数组形式 */
function contentToArray(content: Message['content']): MessageContent[] {
  return Array.isArray(content) ? content : [content];
}

/** 将 MessageContent 数组还原为原始形式（单元素时解包） */
function contentFromArray(items: MessageContent[]): Message['content'] {
  return items.length === 1 ? items[0] : items;
}

/** 将文本截断到指定长度，超出部分用 ... 表示 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * 从消息列表中提取涉及的文件路径。
 * 匹配模式：file_path、file、绝对路径（/ 或 \ 分隔）、.ts/.js/.py 等扩展名。
 */
function extractFilePathsFromMessages(messages: Message[]): string[] {
  const paths = new Set<string>();
  const filePathRegex = /(?:file_path|file|path)\s*[:=]\s*["']?([^\s"',;}\]]+)/gi;
  const absolutePathRegex = /(?:^|\s)([a-zA-Z]:[\\/][^\s"',;}\]]+|(?:\/[^\s"',;}\]]+)+)/gm;
  const extPathRegex = /([^\s"',;}\]]+\.(?:ts|js|py|go|rs|java|cpp|c|h|hpp|css|html|json|yaml|yml|md|txt))/gi;

  for (const msg of messages) {
    const items = contentToArray(msg.content);
    for (const item of items) {
      let text = '';
      if (isText(item)) {
        text = item.text;
      } else if (isToolResult(item)) {
        text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
      } else if (isToolUse(item)) {
        text = JSON.stringify(item.input);
      }

      for (const regex of [filePathRegex, absolutePathRegex, extPathRegex]) {
        let m: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((m = regex.exec(text)) !== null) {
          const p = (m[1] || m[0]).trim();
          if (p.length > 0) paths.add(p);
        }
      }
    }
  }

  return [...paths];
}

/**
 * 通过 git log 判断文件是否为高频修改文件（hot）。
 * 对每个文件调用 git log，如果最近 10 条 commit 中 >= 3 条涉及该文件，则视为 "hot"。
 * 失败时返回空 Set。
 */
async function getGitHotness(
  filePaths: string[],
  gitManager: GitManager,
): Promise<Set<string>> {
  const hotFiles = new Set<string>();
  for (const file of filePaths) {
    try {
      const commits = await gitManager.logFile(file, 10);
      if (commits.length >= 3) {
        hotFiles.add(file);
      }
    } catch {
      // 单个文件查询失败不影响整体，跳过
    }
  }
  return hotFiles;
}

// ─── ToolOutputTrimmer ───────────────────────────────────────────────

/**
 * Phase 1 压缩器 — 无需 LLM 调用，纯规则驱动的工具输出裁剪。
 */
export class ToolOutputTrimmer {
  /** 最近 N 条消息中的工具结果保持原样 */
  private trimWindow: number;

  constructor(trimWindow: number = 6) {
    this.trimWindow = trimWindow;
  }

  /**
   * 裁剪旧工具结果：不在最近 N 条消息中的 ToolResultContent 替换为一行摘要。
   */
  trimToolResults(messages: Message[]): Message[] {
    // 收集最近 N 条消息的索引集合
    const recentIndices = new Set<number>();
    const start = Math.max(0, messages.length - this.trimWindow);
    for (let i = start; i < messages.length; i++) {
      recentIndices.add(i);
    }

    return messages.map((msg, idx) => {
      if (msg.role !== 'user') return msg;
      if (recentIndices.has(idx)) return msg;

      const items = contentToArray(msg.content);
      let changed = false;

      const newItems = items.map((item) => {
        if (!isToolResult(item)) return item;
        changed = true;
        return this.summarizeToolResult(item);
      });

      if (!changed) return msg;
      return { ...msg, content: contentFromArray(newItems) };
    });
  }

  /**
   * 去重连续的相同工具结果（MD5 匹配），仅保留最新，旧结果替换为引用。
   */
  deduplicateToolResults(messages: Message[]): Message[] {
    // 先收集所有 ToolResultContent 及其位置，按 tool_use_id 索引
    const resultMap = new Map<string, { msgIdx: number; itemIdx: number; hash: string }>();

    // 第一遍：记录每个 tool_use_id 对应的最新结果
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (msg.role !== 'user') continue;
      const items = contentToArray(msg.content);
      for (let ci = 0; ci < items.length; ci++) {
        const item = items[ci];
        if (!isToolResult(item)) continue;
        const hash = md5(item.content);
        resultMap.set(item.tool_use_id, { msgIdx: mi, itemIdx: ci, hash });
      }
    }

    // 第二遍：查找重复内容（相同 hash 的不同 tool_use_id）
    const hashToLatestId = new Map<string, string>();
    // 按出现顺序遍历，后出现的覆盖前面的
    for (const [id, info] of resultMap) {
      hashToLatestId.set(info.hash, id);
    }

    // 第三遍：替换重复
    const result: Message[] = messages.map((msg, mi) => {
      if (msg.role !== 'user') return msg;
      const items = contentToArray(msg.content);
      let changed = false;

      const newItems = items.map((item, ci) => {
        if (!isToolResult(item)) return item;
        const hash = md5(item.content);
        const latestId = hashToLatestId.get(hash);
        // 如果当前 id 不是最新的（即存在另一个同 hash 的不同 id），则替换
        if (latestId && latestId !== item.tool_use_id) {
          changed = true;
          const replacement: ToolResultContent = {
            type: 'tool_result',
            tool_use_id: item.tool_use_id,
            content: `[Duplicate] same result as tool_use_id=${latestId}`,
          };
          return replacement;
        }
        return item;
      });

      if (!changed) return msg;
      return { ...msg, content: contentFromArray(newItems) };
    });

    return result;
  }

  /**
   * 截断过大的 tool_call JSON：当 input 序列化后超过 maxJsonLength 时，
   * 生成智能摘要（提取关键参数）而非一刀切截断字符串。
   */
  truncateLargeToolCalls(messages: Message[], maxJsonLength: number = 2000): Message[] {
    return messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;

      const items = contentToArray(msg.content);
      let changed = false;

      const newItems = items.map((item) => {
        if (!isToolUse(item)) return item;
        const json = JSON.stringify(item.input);
        if (json.length <= maxJsonLength) return item;

        changed = true;
        // 智能摘要：提取关键参数
        const summary = this.summarizeToolInput(item.name, item.input);
        const newItem: ToolUseContent = {
          type: 'tool_use',
          id: item.id,
          name: item.name,
          input: { _summarized: true, summary } as unknown as Record<string, unknown>,
        };
        return newItem;
      });

      if (!changed) return msg;
      return { ...msg, content: contentFromArray(newItems) };
    });
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────

  // 工具结果缓存目录
  private static getCacheDir(): string {
    return path.join(os.homedir(), '.agent', 'cache', 'tool-results');
  }

  /** 将工具结果内容保存到缓存，返回引用 ID */
  private saveToCache(label: string, content: string): string {
    const hash = createHash('md5').update(content).digest('hex').slice(0, 10);
    const cacheDir = ToolOutputTrimmer.getCacheDir();
    const cacheFile = path.join(cacheDir, `${hash}.txt`);
    fs.mkdir(path.dirname(cacheFile), { recursive: true })
      .then(() => fs.writeFile(cacheFile, content, 'utf-8'))
      .catch(() => {}); // 写入失败不阻塞
    return `📦 ${label} → ${hash} (${content.length} chars, 用 read 找回: ${cacheFile})`;
  }

  /** 为 ToolResultContent 生成一行摘要并缓存原始内容 */
  private summarizeToolResult(item: ToolResultContent): ToolResultContent {
    const summary = this.generateSummary(item);
    return {
      type: 'tool_result',
      tool_use_id: item.tool_use_id,
      content: summary,
      is_error: item.is_error,
    };
  }

  /** 根据工具结果内容推断工具名并生成摘要 + 缓存 */
  private generateSummary(item: ToolResultContent): string {
    const content = item.content;

    // Read 工具：输出通常包含行号格式 "  1→content"
    const lineMatch = content.match(/^\s*\d+[→|]/m);
    if (lineMatch) {
      const lineCount = (content.match(/^\s*\d+[→|]/gm) || []).length;
      const filePathMatch = content.match(/(?:^|\n)([^\s\n]+\.\w+)/);
      const filePath = filePathMatch ? filePathMatch[1] : 'unknown';
      return this.saveToCache(`[Read] ${filePath} (${lineCount} lines)`, content);
    }

    // Bash 工具：包含 exit code
    const exitMatch = content.match(/exit\s+code[:\s]+(\d+)/i);
    if (exitMatch) {
      const cmdMatch = content.match(/(?:^|\n)([$>]\s*)([^\n]+)/);
      const cmd = cmdMatch ? cmdMatch[2].substring(0, 50) : 'command';
      return this.saveToCache(`[Bash] ${cmd} → exit ${exitMatch[1]}`, content);
    }

    // Glob 工具：输出是文件路径列表
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0 && lines.every((l) => l.trim().includes('/') || l.trim().includes('\\') || l.trim().includes('.'))) {
      return this.saveToCache(`[Glob] (${lines.length} matches)`, content);
    }

    // 通用：内容超过 200 字符才缓存，短文直接保留
    if (content.length > 200) {
      return this.saveToCache(`[ToolResult]`, content);
    }
    return `[ToolResult] ${content.slice(0, 200)}`;
  }

  /** 为大型 ToolUse input 生成智能摘要，提取关键参数。
   *
   * Write 工具特殊处理：提取函数/类签名、import、行数
   * Edit 工具特殊处理：提取 old/new_string 首尾行、行数变化
   * 其他工具：提取关键参数名
   */
  private summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
    // ── Write 工具语义压缩 ──
    if (toolName === 'write') {
      return this.summarizeWriteInput(input);
    }

    // ── Edit 工具语义压缩 ──
    if (toolName === 'edit') {
      return this.summarizeEditInput(input);
    }

    // ── 其他工具：通用参数提取 ──
    const keys = Object.keys(input).filter((k) => !k.startsWith('_'));
    const parts = keys.map((key) => {
      const val = input[key];
      if (typeof val === 'string') {
        if (val.includes('/') || val.includes('\\')) {
          const segments = val.replace(/\\/g, '/').split('/');
          return `${key}=${segments[segments.length - 1]}`;
        }
        return `${key}="${val.length > 60 ? val.slice(0, 57) + '...' : val}"`;
      }
      if (typeof val === 'object') {
        return `${key}={...}`;
      }
      return `${key}=${val}`;
    });
    return `[${toolName}] ${parts.join(', ')}`;
  }

  /** Write 工具：提取函数/类签名、import、行数 */
  private summarizeWriteInput(input: Record<string, unknown>): string {
    const filePath = String(input.file_path ?? 'unknown');
    const content = String(input.content ?? '');
    const lines = content.split('\n');
    const lineCount = lines.length;

    // 提取函数签名
    const signatures: string[] = [];
    const sigRegex = /export\s+(async\s+)?(function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = sigRegex.exec(content)) !== null) {
      signatures.push(`${m[3]}(${m[2]})`);
    }
    if (signatures.length === 0) {
      // 回退：查找任何顶层的 function/class 声明
      const fallbackRegex = /^(?:export\s+)?(async\s+)?(function|class)\s+(\w+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fallbackRegex.exec(content)) !== null) {
        signatures.push(fm[3]);
      }
    }

    // 提取 import 来源
    const imports: string[] = [];
    const importRegex = /import\s+.*?\bfrom\s+['"](.+?)['"]/g;
    let im: RegExpExecArray | null;
    while ((im = importRegex.exec(content)) !== null) {
      const p = im[1].split('/');
      imports.push(p[p.length - 1]);
    }

    // 提取文件名
    const p = filePath.replace(/\\/g, '/').split('/');
    const fileName = p[p.length - 1];

    const sigStr = signatures.length > 0 ? signatures.join(', ') : '';
    const impStr = imports.length > 0 ? `; imports: ${imports.join(', ')}` : '';

    return `[Write] ${fileName} (+${lineCount} lines)${sigStr ? ': ' + sigStr : ''}${impStr}`;
  }

  /** Edit 工具：提取 old/new_string 首尾行、行数变化 */
  private summarizeEditInput(input: Record<string, unknown>): string {
    const filePath = String(input.file_path ?? 'unknown');
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    const oldFirst = oldLines[0] ? truncateText(oldLines[0], 40) : '';
    const oldLast = oldLines.length > 1 && oldLines[oldLines.length - 1]
      ? truncateText(oldLines[oldLines.length - 1], 40) : '';
    const newFirst = newLines[0] ? truncateText(newLines[0], 40) : '';
    const newLast = newLines.length > 1 && newLines[newLines.length - 1]
      ? truncateText(newLines[newLines.length - 1], 40) : '';

    const p = filePath.replace(/\\/g, '/').split('/');
    const fileName = p[p.length - 1];

    const oldDesc = oldFirst + (oldLines.length > 1 ? `...${oldLast}` : '');
    const newDesc = newFirst + (newLines.length > 1 ? `...${newLast}` : '');

    return `[Edit] ${fileName}: ${oldDesc} → ${newDesc} (${oldLines.length}→${newLines.length} lines)`;
  }
}

// ─── StructuredSummarizer ────────────────────────────────────────────

/**
 * Phase 2-3 压缩器 — 使用 LLM 生成结构化摘要。
 */
export class StructuredSummarizer {
  private modelRouter: ModelRouter;
  private compressDepth: number;

  constructor(modelRouter: ModelRouter, options?: { compressDepth?: number }) {
    this.modelRouter = modelRouter;
    this.compressDepth = options?.compressDepth ?? 0.5;
  }

  /** 运行时更新压缩深度 */
  setCompressDepth(depth: number): void {
    this.compressDepth = Math.max(0, Math.min(1, depth));
  }

  /** 根据 compressDepth 生成压缩策略提示词 */
  private getDepthInstruction(): string {
    if (this.compressDepth <= 0.3) {
      return '激进压缩。仅保留任务完成状态和关键决策，丢弃所有实现细节、工具输出和过程描述。';
    }
    if (this.compressDepth <= 0.7) {
      return '平衡压缩。优先保留相关信息和关键步骤，无关内容可适度压缩。';
    }
    return '保守压缩。尽可能保留完整上下文，保留决策过程和重要细节，只去除明显冗余和重复。';
  }

  /**
   * 生成结构化摘要。
   *
   * - 无 existingSummary → Phase 2（首次摘要），使用完整模板
   * - 有 existingSummary → Phase 3（增量更新），基于前次摘要增量更新
   *
   * @param messages - 待压缩的历史消息
   * @param existingSummary - 已有的摘要（增量压缩时传入）
   * @param recentContext - 近期对话（不压缩，仅供 LLM 判断相关性，优先保留相关信息）
   */
  async summarize(
    messages: Message[],
    existingSummary?: string,
    recentContext?: Message[],
    /** KVCache 隔离 ID（session 粒度）；缺省用通道默认 compressorUserId() */
    userId?: string,
  ): Promise<string> {
    let prompt: string;

    const depthInstruction = this.getDepthInstruction();

    // 近期对话作为 LLM 判断相关性的"锚"
    const taskFocus = recentContext && recentContext.length > 0
      ? `## 近期对话（仅供参考，不需压缩）\n${this.serializeMessages(recentContext)}\n\n` +
        `---\n\n` +
        `## 需压缩的历史对话\n` +
        `${depthInstruction}\n` +
        `已完成的任务记入"✅ 已完成"，实现细节可压缩，但完成状态不能丢。\n\n`
      : '';

    if (existingSummary) {
      // Phase 3: 增量更新 — 已完成的移到 ✅，新内容补充到对应章节
      prompt =
        `前一次摘要:\n${existingSummary}\n\n` +
        taskFocus +
        `增量更新前一次摘要：已完成的任务移到"✅ 已完成"，新内容补到对应章节，不要重复已完成的项。\n\n` +
        `对话历史:\n${this.serializeMessages(messages)}\n\n` +
        loadPrompt('summary', { skipCache: true });
    } else {
      // Phase 2: 首次摘要
      prompt =
        taskFocus +
        `对话历史:\n${this.serializeMessages(messages)}\n\n` +
        loadPrompt('summary', { skipCache: true });
    }

    const summaryMessages: Message[] = [
      {
        role: 'user',
        content: { type: 'text', text: prompt },
      },
    ];

    let summaryText = '';
    // 按次现建 scoped 实例（session 粒度 user_id 隔离）；通道无配置时降级 null → 用共享实例
    const provider = this.modelRouter.createScopedProvider('compression', userId ?? compressorUserId())
      ?? this.modelRouter.getProvider('compression');
    const stream = provider.createStream(summaryMessages);
    for await (const event of stream) {
      if (event.type === 'TEXT') {
        summaryText += event.content;
      }
    }

    return summaryText;
  }

  /** 将消息序列化为可读文本 */
  private serializeMessages(messages: Message[]): string {
    return messages
      .map((msg) => {
        const items = contentToArray(msg.content);
        const body = items
          .map((item) => {
            if (isText(item)) return item.text;
            if (isToolUse(item)) return `[ToolUse: ${item.name}] ${JSON.stringify(item.input)}`;
            if (isToolResult(item)) return `[ToolResult: ${item.tool_use_id}] ${item.content}`;
            if (item.type === 'image') {
              const img = item as import('../types.js').ImageContent;
              return `[Image: ${img.source.type === 'base64' ? img.source.media_type : img.source.url}]`;
            }
            if (item.type === 'thinking') return `[Thinking: ${(item as any).thinking?.slice(0, 200) ?? ''}]`;
            return '';
          })
          .join('\n');
        return `[${msg.role}]: ${body}`;
      })
      .join('\n\n');
  }
}

// ─── CompressorOrchestrator ──────────────────────────────────────────

/** 压缩结果 */
export interface CompressionResult {
  messages: Message[];
  summary?: string;
  phasesUsed: number[];
  /** 本轮压缩覆盖的原始消息数量（输入消息数 - 返回消息数） */
  compressedCount?: number;
  /** 被压缩的原始消息（已标记 _compressed），供调用方写回全量存档追溯（方案 3.5/决策C） */
  compressedMessages?: Message[];
}

/** 压缩统计 */
export interface CompressionStats {
  totalTokens: number;
  maxTokens: number;
  usageRatio: number;
}

/**
 * 压缩编排器 — 协调所有压缩阶段。
 */
export class CompressorOrchestrator {
  private tokenizer: { countMessagesTokens(messages: Message[]): number };
  private summarizer: StructuredSummarizer;
  private maxContextTokens: number;
  /** ToolOutputTrimmer 的窗口大小（规则裁剪时最近 N 条不处理） */
  private trimWindow: number;
  private safetyThreshold: number;
  private targetRatio: number;
  private compressThreshold: number;
  /** 最大迭代轮数 */
  private maxRounds: number;
  /** 压缩激进程度 0.0~1.0 */
  private compressDepth: number;
  /** 压缩预算基准：当调用方传入 historyBudget 时使用该值，否则回退到 maxContextTokens */
  #historyBudget: number | null = null;
  /** 当前压缩摘要内容（全局模式） */
  private _currentSummary: string | undefined;
  /** 各意图簇的压缩摘要（key = clusterKey/capability，方案 3.5：替代单一 _currentSummary 的分桶存储） */
  private clusterSummaries: Map<string, string> = new Map();

  constructor(
    tokenizer: { countMessagesTokens(messages: Message[]): number },
    summarizer: StructuredSummarizer,
    maxContextTokens: number,
    options?: {
      trimWindow?: number;
      safetyThreshold?: number;
      targetRatio?: number;
      compressThreshold?: number;
      maxRounds?: number;
      compressDepth?: number;
    },
  ) {
    this.tokenizer = tokenizer;
    this.summarizer = summarizer;
    this.maxContextTokens = maxContextTokens;
    this.trimWindow = options?.trimWindow ?? trimWindow();
    this.safetyThreshold = options?.safetyThreshold ?? safetyThreshold();
    this.targetRatio = options?.targetRatio ?? targetRatio();
    this.compressThreshold = options?.compressThreshold ?? 0.75;
    this.maxRounds = options?.maxRounds ?? maxCompressRounds();
    this.compressDepth = options?.compressDepth ?? 0.5;
  }

  /**
   * 执行多轮迭代压缩。
   *
   * 每轮按 token 比例动态分层，LLM 压缩最旧部分（Layer 3），
   * 规则裁剪中间部分（Layer 2，仅第 1 轮），保留最新部分（Layer 1）。
   * 每轮后检查是否收敛，未收敛则缩小保护区继续下一轮，最多 maxRounds 轮。
   *
   * @param protectLast - 保护最后 N 条消息不被压缩（用于 Zone 5 live tail），默认 0
   * @param historyBudget - 压缩预算基准（token 数）。调用方应传入 maxContextTokens
   *   或计算后的 history 可用空间。未传入时回退到 maxContextTokens。
   */
  async compress(
    messages: Message[],
    currentSummary: string | undefined,
    protectLast: number = 0,
    historyBudget: number,
    options?: {
      /** Git 管理器（热文件检测用） */
      gitManager?: GitManager;
      /** 意图簇 key（capability）。提供时：仅压缩该簇，摘要存 clusterSummaries；不提供时全局压缩（方案 3.5） */
      clusterKey?: string;
      /** KVCache 隔离 ID（session 粒度），透传给摘要 LLM 调用 */
      userId?: string;
    },
  ): Promise<CompressionResult> {
    // 方案 3.5/决策H：分簇预算 = totalBudget * 0.7（留 30% 给其他 zone）
    const clusterKey = options?.clusterKey;
    this.#historyBudget = clusterKey
      ? Math.floor(historyBudget * clusterBudgetRatio())
      : historyBudget;

    try {
    const phasesUsed: number[] = [];
    const inputMsgsLength = messages.length;
    let summary = currentSummary;
    let currentProtectCount = protectLast;
    let liveMessages = [...messages];
    // 决策 C：被压缩消息标记 _compressed（不丢弃，仅保留最近一次压缩记录）
    const compressedMessages: Message[] = [];

    let round = 0;
    while (round < this.maxRounds && liveMessages.length > 0) {
      round++;

      // ── 分离保护区 ──
      let protectedMessages: Message[] = [];
      let workingSet = liveMessages;
      if (currentProtectCount > 0 && currentProtectCount < workingSet.length) {
        protectedMessages = workingSet.slice(-currentProtectCount);
        workingSet = workingSet.slice(0, -currentProtectCount);
      }

      if (workingSet.length === 0) break;

      // ── 动态分层 ──
      // Round 1: 激进策略 — 70% LLM压缩, 20% 规则裁剪, 10% 保留
      // Round 2+: 对半策略 — 剩余内容 50% LLM压缩, 50% 保留（规则层已用完）
      const ratios = round === 1
        ? { layer1: 0.10, layer2: 0.20, layer3: 0.70 }
        : { layer1: 0.50, layer2: 0, layer3: 0.50 };

      let { layer3, layer2, layer1 } = this.splitByTokenRatio(workingSet, ratios);

      ({ layer3, layer2, layer1 } = this.fixOrphanedToolResults(layer3, layer2, layer1));

      // ── Phase 1: 规则裁剪（仅第 1 轮）──
      if (round === 1 && layer2.length > 0) {
        const trimmer = new ToolOutputTrimmer(this.trimWindow);
        layer2 = trimmer.trimToolResults(layer2);
        layer2 = trimmer.deduplicateToolResults(layer2);
        layer2 = trimmer.truncateLargeToolCalls(layer2);
        phasesUsed.push(1);
      }

      // ── Phase 2/3: LLM 结构化摘要（作用于 Layer 3）──
      // summaryOk 标记摘要是否成功。失败时**绝不能丢弃 layer3** —— 否则这批
      // 最旧、最不可重建的历史会静默消失，表现为"模型莫名失忆"且无法归因。
      // 降级路径：改用规则裁剪（ToolOutputTrimmer）压缩 layer3 后保留。
      let summaryOk = true;
      if (layer3.length > 0) {
        try {
          const hadSummary = !!summary;
          const recentContext = [...layer2, ...layer1];
          summary = await this.summarizer.summarize(layer3, summary, recentContext, options?.userId);
          // 决策 C：被压缩消息不丢弃，标记 _compressed（仅保留最近一次压缩记录，覆盖而非追加）
          const compressedAt = new Date().toISOString();
          const intentTag = clusterKey ?? 'general';
          for (const msg of layer3) {
            compressedMessages.push({
              ...msg,
              _compressed: {
                intent: intentTag,
                summary_hash: md5(summary),
                compressed_at: compressedAt,
              },
            });
          }
          // 方案 3.5：簇压缩存分桶，全局压缩存 _currentSummary
          if (clusterKey) {
            this.clusterSummaries.set(clusterKey, summary);
          } else {
            this._currentSummary = summary;
          }
          if (!phasesUsed.includes(2) && !phasesUsed.includes(3)) {
            phasesUsed.push(hadSummary ? 3 : 2);
          }
        } catch (err) {
          summaryOk = false;
          logger.warn('compress.round.summary_failed', {
            round,
            layer3Messages: layer3.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── 重组 ──
      // 摘要成功：Layer 3 已被摘要替代，Layer 2 + Layer 1 + 保护区保留。
      // 摘要失败：Layer 3 保留，但降级为规则裁剪（仍然压缩，只是不依赖 LLM）。
      if (summaryOk) {
        liveMessages = [...layer2, ...layer1, ...protectedMessages];
      } else {
        const trimmer = new ToolOutputTrimmer(Math.max(2, Math.floor(this.trimWindow / 2)));
        liveMessages = [
          ...trimmer.trimToolResults(layer3),
          ...layer2,
          ...layer1,
          ...protectedMessages,
        ];
      }
      liveMessages = this.ensureNoConsecutiveUserMessages(liveMessages);

      // ── 收敛检查 ──
      // 0.5 是"够用就停"阈值：不必压到理想目标，只要低于 50% 即可接受。
      // 摘要失败的降级轮原则上不再依赖 targetRatio（目标未达成是已知的）。
      if (summaryOk && this.getUsageRatio(liveMessages) <= this.targetRatio) break;
      if (this.getUsageRatio(liveMessages) <= 0.5) break;

      // 未收敛 → 缩小保护区，下一轮压缩更多
      currentProtectCount = Math.max(2, Math.floor(currentProtectCount / 2));
    }

    // ── Phase 4: 保护区规则裁剪兜底 ──
    if (this.getUsageRatio(liveMessages) > this.safetyThreshold) {
      const trimmer = new ToolOutputTrimmer(2);
      liveMessages = trimmer.trimToolResults(liveMessages);
      liveMessages = trimmer.deduplicateToolResults(liveMessages);
      liveMessages = trimmer.truncateLargeToolCalls(liveMessages);
      liveMessages = this.ensureNoConsecutiveUserMessages(liveMessages);
      phasesUsed.push(4);
    }

    // ── Phase 5: 全局 tool 消息完整性校验 ──
    // 5a: 孤立 tool_result（tool_result 没有配对的 tool_use）→ 降级为文本
    // 5b: 孤立 tool_calls（assistant 有 tool_calls 但没有对应的 tool_result）→ 移除 tool_calls
    liveMessages = this.fixGlobalOrphanedToolResults(liveMessages);
    liveMessages = this.fixGlobalOrphanedToolCalls(liveMessages);

    const compressedCount = inputMsgsLength - liveMessages.length;
    return {
      messages: liveMessages,
      summary,
      phasesUsed,
      compressedCount,
      // 决策 C：仅在有被压缩消息时返回（调用方写回全量存档标记）
      compressedMessages: compressedMessages.length > 0 ? compressedMessages : undefined,
    };
    } finally {
      this.#historyBudget = null;
    }
  }

  /** 检查消息是否超过压缩阈值的最大上下文 token */
  needsCompression(messages: Message[]): boolean {
    return this.getUsageRatio(messages) > this.compressThreshold;
  }

  /** 获取压缩统计信息 */
  getCompressionStats(messages: Message[]): CompressionStats {
    const totalTokens = this.tokenizer.countMessagesTokens(messages);
    const budget = Math.max(1, this.#historyBudget ?? this.maxContextTokens);
    return {
      totalTokens,
      maxTokens: budget,
      usageRatio: totalTokens / budget,
    };
  }

  /**
   * Update the compression threshold at runtime.
   * This allows config changes to take effect without reconstruction.
   */
  setCompressThreshold(threshold: number): void {
    this.compressThreshold = threshold;
  }

  /**
   * Update the compression depth at runtime.
   * Delegates to StructuredSummarizer for prompt modulation.
   */
  setCompressDepth(depth: number): void {
    this.compressDepth = depth;
    this.summarizer.setCompressDepth(depth);
  }

  /**
   * Get current compressDepth.
   */
  getCompressDepth(): number {
    return this.compressDepth;
  }

  /** 获取当前压缩摘要（全局模式） */
  get currentSummary(): string | undefined {
    return this._currentSummary;
  }

  /** 获取某意图簇的压缩摘要（方案 3.5） */
  getClusterSummary(clusterKey: string): string | undefined {
    return this.clusterSummaries.get(clusterKey);
  }

  /** 持久化某意图簇摘要到 sessionDir/summary.{cluster}.md（方案 3.5/G） */
  async saveClusterSummary(sessionDir: string, clusterKey: string): Promise<void> {
    const text = this.clusterSummaries.get(clusterKey);
    if (!text) return;
    await new SummaryStore().saveClusterSummary(sessionDir, clusterKey, text);
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────

  /** 获取当前使用比例 */
  private getUsageRatio(messages: Message[]): number {
    const tokens = this.tokenizer.countMessagesTokens(messages);
    const budget = Math.max(1, this.#historyBudget ?? this.maxContextTokens);
    return tokens / budget;
  }

  /**
   * 按 token 比例动态分层：从消息末尾向前累加 token 数，切分为三层。
   *
   * @param ratios - 分层比例 { layer1: 最新保留比例, layer2: 中间规则层比例, layer3: 最旧 LLM 层比例 }
   *                 三者之和应为 1.0。layer2 为 0 表示跳过规则裁剪层。
   * @returns { layer3, layer2, layer1 } 从最旧到最新排列
   */
  private splitByTokenRatio(
    messages: Message[],
    ratios: { layer1: number; layer2: number; layer3: number },
  ): { layer3: Message[]; layer2: Message[]; layer1: Message[] } {
    if (messages.length === 0) return { layer3: [], layer2: [], layer1: [] };

    const totalTokens = this.tokenizer.countMessagesTokens(messages);

    // 从末尾向前累加
    let accumulatedTokens = 0;
    let l1Idx = messages.length;
    let l2Idx = messages.length;

    // Layer 1: 最新保留部分
    const l1TargetTokens = totalTokens * ratios.layer1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.tokenizer.countMessagesTokens([messages[i]]);
      accumulatedTokens += msgTokens;
      l1Idx = i;
      if (accumulatedTokens >= l1TargetTokens) break;
    }

    // Layer 2: 中间规则裁剪层（仅当 ratios.layer2 > 0）
    if (ratios.layer2 > 0) {
      const l2TargetTokens = totalTokens * (ratios.layer1 + ratios.layer2);
      for (let i = l1Idx - 1; i >= 0; i--) {
        const msgTokens = this.tokenizer.countMessagesTokens([messages[i]]);
        accumulatedTokens += msgTokens;
        l2Idx = i;
        if (accumulatedTokens >= l2TargetTokens) break;
      }
    } else {
      l2Idx = l1Idx;
    }

    const layer1 = messages.slice(l1Idx);
    const layer2 = ratios.layer2 > 0 ? messages.slice(l2Idx, l1Idx) : [];
    let layer3 = messages.slice(0, l2Idx);

    // 确保 layer3 至少保留 1 条（若有消息可压缩）
    // 当消息很少但每条很长时，单条消息就可能超过 l1TargetTokens，
    // 导致 l1Idx/l2Idx 跳到 0，layer3 为空，LLM 压缩无法触发。
    // 放宽条件：只要有多于 1 条消息，就应确保至少 1 条进入 layer3。
    if (layer3.length === 0 && messages.length > 1) {
      // 所有消息都太长，无法按比例分层
      // 策略：将最旧的 1 条放入 layer3（LLM 压缩），其余放入 layer1（保留）
      return {
        layer3: messages.slice(0, 1),
        layer2: [],
        layer1: messages.slice(1),
      };
    }

    return { layer3, layer2, layer1 };
  }

  /**
   * 确保消息数组中不存在连续的 user 角色消息。
   *
   * 策略：如果连续两条 user 消息中，后一条含 tool_result，
   * 则将后一条的 tool_result 合并到前一条 user 消息中（保持与 assistant(tool_calls) 的配对），
   * 否则插入空 assistant 消息分隔。
   */
  private ensureNoConsecutiveUserMessages(messages: Message[]): Message[] {
    const result: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // 检查是否与前一条都是 user 且需要合并
      if (
        msg.role === 'user' &&
        result.length > 0 &&
        result[result.length - 1].role === 'user'
      ) {
        const prevMsg = result[result.length - 1];
        const curContents = contentToArray(msg.content);
        const hasToolResult = curContents.some(isToolResult);

        if (hasToolResult) {
          // 后一条含 tool_result → 合并到前一条 user 消息中
          // 这样 tool_result 仍紧跟在 assistant(tool_calls) 之后
          const prevContents = contentToArray(prevMsg.content);
          const merged = [...prevContents, ...curContents];
          result[result.length - 1] = { ...prevMsg, content: contentFromArray(merged) };
          continue;
        }

        // 后一条不含 tool_result → 插入空 assistant 分隔
        result.push({
          role: 'assistant',
          content: { type: 'text', text: '' },
        });
      }
      result.push(msg);
    }
    return result;
  }

  /**
   * 修复分层后 tool 消息的配对完整性。
   * 如果 assistant 消息含 tool_use 被分到 layer3（将被摘要替代），
   * 而对应的 tool_result 消息被分到 layer2/layer1，则会产生孤立 tool_result，
   * 导致 API 报错 "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"。
   *
   * 修复策略：将孤立的 tool_result 消息降级为普通 user 文本消息，
   * 保留其内容但移除 tool_result 结构。
   */
  private fixOrphanedToolResults(
    layer3: Message[], layer2: Message[], layer1: Message[],
  ): { layer3: Message[]; layer2: Message[]; layer1: Message[] } {

    const collectToolUseIds = (msgs: Message[]): Set<string> => {
      const ids = new Set<string>();
      for (const msg of msgs) {
        const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const c of contents) {
          if (isToolUse(c)) ids.add(c.id);
        }
      }
      return ids;
    };

    const l3ToolUseIds = collectToolUseIds(layer3);
    const l2ToolUseIds = collectToolUseIds(layer2);

    const fixLayer = (msgs: Message[], higherLayerToolUseIds: Set<string>): Message[] => {
      return msgs.map((msg) => {
        if (msg.role !== 'user') return msg;
        const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
        const hasOrphanResult = contents.some(
          (c) => isToolResult(c) && higherLayerToolUseIds.has(c.tool_use_id),
        );
        if (!hasOrphanResult) return msg;

        const fixedContents: MessageContent[] = [];
        for (const c of contents) {
          if (isToolResult(c) && higherLayerToolUseIds.has(c.tool_use_id)) {
            fixedContents.push({
              type: 'text',
              text: `[ToolResult: ${c.tool_use_id}] ${c.content}`,
            });
          } else {
            fixedContents.push(c);
          }
        }
        return { ...msg, content: fixedContents };
      });
    };

    return {
      layer3,
      layer2: fixLayer(layer2, l3ToolUseIds),
      layer1: fixLayer(layer1, new Set([...l3ToolUseIds, ...l2ToolUseIds])),
    };
  }

  /**
   * 全局 tool_result 完整性校验：确保最终输出中所有 tool_result
   * 都有对应的 tool_use（assistant 消息中的 tool_calls）。
   *
   * 压缩后可能出现以下孤立场景：
   * - layer3 整体被 LLM 摘要替代后，layer2/layer1 中残留的 tool_result
   *   其对应的 tool_use 已随 layer3 一起消失
   * - ensureNoConsecutiveUserMessages 插入空 assistant 后，
   *   tool_result 与 tool_use 之间可能被隔开
   * - 多轮压缩迭代中，早期修复可能引入新的孤立
   *
   * 修复策略：将孤立 tool_result 降级为普通 user 文本消息
   */
  private fixGlobalOrphanedToolResults(messages: Message[]): Message[] {
    // 收集所有 tool_use 的 id
    const allToolUseIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const c of contents) {
        if (isToolUse(c)) allToolUseIds.add(c.id);
      }
    }

    // 检查每条 user 消息中的 tool_result 是否有配对
    let hasOrphan = false;
    const result = messages.map((msg) => {
      if (msg.role !== 'user') return msg;
      const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
      const hasOrphanResult = contents.some(
        (c) => isToolResult(c) && !allToolUseIds.has(c.tool_use_id),
      );
      if (!hasOrphanResult) return msg;

      hasOrphan = true;
      const fixedContents: MessageContent[] = [];
      for (const c of contents) {
        if (isToolResult(c) && !allToolUseIds.has(c.tool_use_id)) {
          fixedContents.push({
            type: 'text',
            text: `[OrphanedToolResult: ${c.tool_use_id}] ${c.content}`,
          });
        } else {
          fixedContents.push(c);
        }
      }
      return { ...msg, content: fixedContents };
    });

    if (hasOrphan) {
      // 降级后可能产生连续 user 消息，需要重新修复
      return this.ensureNoConsecutiveUserMessages(result);
    }
    return result;
  }

  /**
   * 全局 tool_calls 完整性校验：确保每个 assistant 消息中的 tool_call
   * 都有对应的 tool_result 消息紧跟其后。
   *
   * 压缩后可能出现的孤立场景：
   * - assistant(tool_calls) 消息保留，但对应的 user(tool_result) 被压缩删掉
   * - ensureNoConsecutiveUserMessages 合并消息时，tool_result 被移到其他位置
   *
   * 修复策略：从 assistant 消息中移除没有配对 tool_result 的 tool_calls。
   * 如果移除后 assistant 消息只剩 tool_calls（无文本），则整体转为文本消息。
   */
  private fixGlobalOrphanedToolCalls(messages: Message[]): Message[] {
    // 收集所有 tool_result 的 tool_use_id
    const allToolResultIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== 'user') continue;
      const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
      for (const c of contents) {
        if (isToolResult(c)) allToolResultIds.add(c.tool_use_id);
      }
    }

    let hasOrphan = false;
    const result = messages.map((msg) => {
      if (msg.role !== 'assistant') return msg;
      const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
      const toolUseBlocks = contents.filter(isToolUse);
      if (toolUseBlocks.length === 0) return msg;

      // 找出没有配对 tool_result 的 tool_calls
      const orphanToolUseIds = toolUseBlocks
        .filter((b) => !allToolResultIds.has(b.id))
        .map((b) => b.id);
      if (orphanToolUseIds.length === 0) return msg;

      hasOrphan = true;
      const orphanSet = new Set(orphanToolUseIds);
      const remaining = contents.filter((c) => !(isToolUse(c) && orphanSet.has(c.id)));

      if (remaining.length === 0) {
        // assistant 消息只剩孤立的 tool_calls，无文本 → 转为文本消息
        return {
          ...msg,
          content: [{
            type: 'text' as const,
            text: `[Assistant called tools: ${orphanToolUseIds.join(', ')} — results removed during compression]`,
          }],
        };
      }

      // 移除孤立的 tool_calls，保留其他内容
      return { ...msg, content: remaining };
    });

    return result;
  }
}
