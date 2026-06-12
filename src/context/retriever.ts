/**
 * 池检索模块 — 从全量对话历史中按关键词相关性检索补充上下文。
 *
 * 算法：关键词交集得分 + 文件路径加分 + 位置衰减。
 * 不需要向量/embedding，纯规则驱动。
 */

import type { Message, TextContent } from '../types.js';
import type { TokenCounter } from './tokenizer.js';
import type { GitManager, GitContextEntry } from '../evolution/git-manager.js';
import { createHash } from 'node:crypto';

// ─── 停用词列表 ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'been', 'be',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'now', 'it', 'its', 'and', 'but', 'or', 'if', 'this',
  'that', 'these', 'those', 'which', 'who', 'whom', 'what',
  '嗯', '的', '了', '是', '在', '我', '有', '和', '就', '不',
  '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要',
  '去', '你', '会', '着', '没有', '看', '好', '自己', '这',
  '他', '她', '它', '们', '那', '什么', '怎么', '哪', '吗',
  '吧', '呢', '啊', '哦', '哈',
]);

// ─── 类型 ──────────────────────────────────────────────────────────────

export interface RetrieveOptions {
  /** conversation.jsonl 全量消息池 */
  pool: Message[];
  /** 排除最近 N 条（Zone 5 已覆盖） */
  excludeLast: number;
  /** 当前用户输入 */
  userInput: string;
  /** Zone 4 token 预算上限 */
  maxTokens: number;
  /** Token 计数器 */
  tokenCounter: TokenCounter;
  /** 近期涉及的文件路径（用于加分） */
  recentFilePaths?: string[];
  /** Zone 3 已有消息的 MD5 hash 集合（用于去重） */
  excludeHashes?: Set<string>;
  /** 当前工作目录 */
  cwd?: string;
  /** Git 管理器实例 */
  gitManager?: GitManager;
}

export interface RetrieveResult {
  /** 得分 top-N 消息，按原始顺序排列 */
  messages: Message[];
  /** 总 token 数 */
  totalTokens: number;
  /** git 检索结果 */
  gitContext?: GitContextEntry[];
}

// ─── Retriever ──────────────────────────────────────────────────────────

export class Retriever {
  /**
   * 从全量消息池中检索与用户输入相关的历史消息。
   */
  async retrieve(options: RetrieveOptions): Promise<RetrieveResult> {
    const { pool, excludeLast, userInput, maxTokens, tokenCounter, recentFilePaths } = options;

    // ── git 检索通道 ──────────────────────────────────────────────
    let gitContext: GitContextEntry[] | undefined;

    if (options.gitManager) {
      try {
        const repoOk = await options.gitManager.isRepo();
        if (repoOk) {
          const chineseKw = extractChineseKeywords(userInput);
          if (chineseKw.length > 0) {
            const currentBranch = await options.gitManager.getCurrentBranch();
            gitContext = await options.gitManager.searchContext(chineseKw, currentBranch);
          }
        }
      } catch {
        // git 检索失败时静默降级
      }
    }

    // 空池或全被排除 → 返回空
    const searchPool = pool.slice(0, Math.max(0, pool.length - excludeLast));
    if (searchPool.length === 0) {
      return { messages: [], totalTokens: 0, gitContext };
    }

    // 提取用户输入关键词
    const userKeywords = extractKeywords(userInput);
    if (userKeywords.length === 0) {
      return { messages: [], totalTokens: 0, gitContext };
    }

    // 提取文件路径集合（用于加分）
    const filePathSet = new Set(recentFilePaths ?? []);

    // 计算每条消息的得分
    interface ScoredMessage {
      message: Message;
      score: number;
      tokens: number;
    }

    const scored: ScoredMessage[] = [];
    for (let i = 0; i < searchPool.length; i++) {
      const msg = searchPool[i];

      // 去重：排除 Zone 3 已有消息
      if (options.excludeHashes && options.excludeHashes.size > 0) {
        const contentStr = JSON.stringify(msg.content);
        const msgHash = createHash('md5').update(contentStr).digest('hex');
        if (options.excludeHashes.has(msgHash)) {
          continue;
        }
      }

      const text = extractMessageText(msg);
      if (!text) continue;

      const msgKeywords = extractKeywords(text);
      if (msgKeywords.length === 0) continue;

      // 核心得分：交集比例
      const intersection = msgKeywords.filter((k) => userKeywords.includes(k)).length;
      let score = intersection / userKeywords.length;

      // 文件路径加分：消息中涉及近期文件路径 → ×1.5
      if (filePathSet.size > 0) {
        for (const fp of filePathSet) {
          if (text.includes(fp)) {
            score *= 1.5;
            break;
          }
        }
      }

      // 时间权重：最旧=×0.3，最新=×1.0
      score *= (0.3 + 0.7 * (i / pool.length));

      if (score > 0) {
        const tokens = tokenCounter.countMessageTokens(msg);
        scored.push({ message: msg, score, tokens });
      }
    }

    // 按得分降序
    scored.sort((a, b) => b.score - a.score);

    // 取 top-N，总 token 不超过预算
    const selected: Message[] = [];
    let totalTokens = 0;
    for (const item of scored) {
      if (totalTokens + item.tokens > maxTokens) {
        const remaining = maxTokens - totalTokens;
        if (remaining > 200) {
          // 截断消息内容以适配剩余预算
          const truncated = truncateMessageContent(item.message, remaining);
          selected.push(truncated);
          totalTokens = maxTokens;
        }
        // remaining ≤ 200 → 跳过（内容太短无意义）
        break; // 预算耗尽
      }
      selected.push(item.message);
      totalTokens += item.tokens;
    }

    // 按原始顺序排列（保持时间顺序）
    const selectedSet = new Set(selected);
    const ordered = searchPool.filter((m) => selectedSet.has(m));

    return { messages: ordered, totalTokens, gitContext };
  }
}

// ─── 关键词提取 ────────────────────────────────────────────────────────

/**
 * 提取中文多字词（2字及以上连续中文字符），用于 git grep。
 */
function extractChineseKeywords(text: string): string[] {
  const chineseRuns = text.match(/[\u4e00-\u9fff]{2,}/g);
  if (!chineseRuns) return [];
  const result: string[] = [];
  for (const run of chineseRuns) {
    if (!STOP_WORDS.has(run)) {
      result.push(run);
    }
  }
  return [...new Set(result)];
}

/**
 * 从文本中提取关键词。
 * - 英文：按空格/标点分词，去停用词，保留 ≥ 3 字符的词
 * - 中文：按字符级 2-gram 提取，去停用词
 */
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];

  // 英文关键词：匹配 ≥ 3 字符的单词
  const wordRegex = /[a-zA-Z]{3,}/g;
  let match: RegExpExecArray | null;
  while ((match = wordRegex.exec(text)) !== null) {
    const word = match[0].toLowerCase();
    if (!STOP_WORDS.has(word)) {
      keywords.push(word);
    }
  }

  // 中文字符 2-gram
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).join('');
  for (let i = 0; i < chineseChars.length - 1; i++) {
    const bigram = chineseChars.slice(i, i + 2);
    if (!STOP_WORDS.has(bigram)) {
      keywords.push(bigram);
    }
  }

  // 去重
  return [...new Set(keywords)];
}

// ─── 辅助 ──────────────────────────────────────────────────────────────

/**
 * 提取消息中的纯文本内容。
 */
function extractMessageText(message: Message): string {
  const contents = Array.isArray(message.content)
    ? message.content
    : [message.content];

  const parts: string[] = [];
  for (const c of contents) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') {
      const img = c as import('../types.js').ImageContent;
      parts.push(`[Image: ${img.source.type === 'base64' ? img.source.media_type : 'url'}]`);
    } else if (c.type === 'tool_use') parts.push(`[ToolUse: ${(c as any).name}]`);
  }
  return parts.join(' ');
}

/**
 * 截断消息内容以适配剩余 token 预算（约 1 token ≈ 3 字符估算）。
 */
function truncateMessageContent(msg: any, maxTokens: number): any {
  const text = typeof msg.content === 'string' ? msg.content : msg.content?.text ?? '';
  if (typeof text !== 'string' || text.length <= maxTokens * 3) {
    return msg; // 短消息不截断
  }
  const truncated = text.substring(0, maxTokens * 3) + '...';
  return {
    ...msg,
    content: typeof msg.content === 'string' ? truncated : { ...msg.content, text: truncated },
  };
}