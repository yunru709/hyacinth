import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Provider } from '../provider/interface.js';
import type { Message, MessageContent, StreamEvent, TextContent, ThinkingContent, ToolUseContent, ToolResultContent } from '../types.js';
import { formatDate } from '../utils/misc.js';

// ============================================================================
// 类型定义
// ============================================================================

/** Session 元信息 */
export interface SessionInfo {
  sessionId: string;
  dirPath: string;
  messageCount: number;
  lastActivity: string; // YYYY-MM-DD
}

/** 一次工具调用记录 */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 一次工具调用结果记录 */
export interface ToolResultRecord {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** 一次对话交互（user -> assistant 完整回合） */
export interface ConversationTurn {
  sessionId: string;
  timestamp: string;
  userMessage: string;
  assistantReply: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  toolResults?: ToolResultRecord[];
}

/** 每日聚合数据 */
export interface DailyAggregation {
  date: string;
  turns: ConversationTurn[];
  sessions: SessionInfo[];
  totalMessages: number;
  totalToolCalls: number;
  uniqueTools: string[];
  summary: string;
}

// ============================================================================
// 工具函数
// ============================================================================

// formatDate 已迁移至 src/utils/misc.js
export { formatDate };

// ============================================================================
// 内部工具
// ============================================================================

/** 通用 JSONL 文件读取 */
async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

/** 检查 content 是否包含指定类型的 block */
function hasContentType(
  content: MessageContent | MessageContent[],
  type: string,
): boolean {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.some((b) => b.type === type);
}

/** 从 content 中提取指定类型的所有 block */
function getContentBlocks<T extends MessageContent>(
  content: MessageContent | MessageContent[],
  type: string,
): T[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.filter((b): b is T => b.type === type);
}

/** 从 content 中提取文本（合并所有 text block） */
function extractText(content: MessageContent | MessageContent[]): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** 从 content 中提取 thinking（合并所有 thinking block） */
function extractThinking(content: MessageContent | MessageContent[]): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((b): b is ThinkingContent => b.type === 'thinking')
    .map((b) => b.thinking)
    .join('\n');
}

/** 从 content 中提取所有 tool_use block */
function extractToolUses(content: MessageContent | MessageContent[]): ToolCallRecord[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((b): b is ToolUseContent => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
}

/** 从 content 中提取所有 tool_result block */
function extractToolResults(content: MessageContent | MessageContent[]): ToolResultRecord[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .filter((b): b is ToolResultContent => b.type === 'tool_result')
    .map((b) => ({ toolUseId: b.tool_use_id, content: b.content, isError: b.is_error }));
}

/** 解析 ISO 时间戳中的日期部分（YYYY-MM-DD） */
function getDateFromTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return formatDate(d);
  } catch {
    return '';
  }
}

// ============================================================================
// TrainingAggregator
// ============================================================================

export class TrainingAggregator {
  constructor(
    private sessionsDir: string,
    private onlineProvider?: Provider,
  ) {}

  /**
   * 扫描所有 session 目录，返回 SessionInfo[] 按 lastActivity 降序排列。
   */
  async scanSessions(): Promise<SessionInfo[]> {
    // 确保根目录存在
    await ensureDir(this.sessionsDir);

    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessionDirs = entries.filter((e) => e.isDirectory() && e.name !== '.' && e.name !== '..');

    const results: SessionInfo[] = [];

    for (const dir of sessionDirs) {
      const dirPath = path.join(this.sessionsDir, dir.name);

      // 读取 conversation.jsonl 获取消息数
      const messages = await readJsonlFile<Message>(
        path.join(dirPath, 'conversation.jsonl'),
      );
      const messageCount = messages.length;

      // 读取 events.jsonl 获取最后活动时间
      const events = await readJsonlFile<Record<string, unknown>>(
        path.join(dirPath, 'events.jsonl'),
      );

      let lastActivity = '';
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        const ts = String(lastEvent['timestamp'] ?? '');
        lastActivity = getDateFromTimestamp(ts);
      }

      results.push({
        sessionId: dir.name,
        dirPath,
        messageCount,
        lastActivity,
      });
    }

    // 按 lastActivity 降序排列（最新的在前）
    results.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

    return results;
  }

  /**
   * 提取当日（或指定日期）的对话数据。
   *
   * @param date - YYYY-MM-DD 格式，默认今天
   */
  async extractDailyData(date?: string): Promise<DailyAggregation> {
    const targetDate = date ?? formatDate();
    const allSessions = await this.scanSessions();

    // 筛选 events 中 timestamp 匹配目标日期的 session
    const matchedSessions: SessionInfo[] = [];
    const allTurns: ConversationTurn[] = [];

    for (const sessionInfo of allSessions) {
      const events = await readJsonlFile<Record<string, unknown>>(
        path.join(sessionInfo.dirPath, 'events.jsonl'),
      );

      // 检查该 session 是否有匹配日期的活动
      const hasMatch = events.some((evt) => {
        const ts = String(evt['timestamp'] ?? '');
        return getDateFromTimestamp(ts) === targetDate;
      });

      if (!hasMatch) continue;

      matchedSessions.push(sessionInfo);

      // 从 conversation.jsonl 中提取对话回合
      const messages = await readJsonlFile<Message>(
        path.join(sessionInfo.dirPath, 'conversation.jsonl'),
      );

      // 提取对话回合（user -> assistant 完整交互）
      const turns = extractConversationTurns(messages, sessionInfo.sessionId);
      allTurns.push(...turns);
    }

    // 统计工具使用情况
    const allToolCalls: ToolCallRecord[] = [];
    for (const turn of allTurns) {
      if (turn.toolCalls) {
        allToolCalls.push(...turn.toolCalls);
      }
    }

    const uniqueTools = [...new Set(allToolCalls.map((tc) => tc.name))];

    const summaryParts: string[] = [];
    for (const sessionInfo of matchedSessions) {
      const summaryPath = path.join(sessionInfo.dirPath, 'summary.md');
      if (existsSync(summaryPath)) {
        const content = readFileSync(summaryPath, 'utf-8');
        if (content.trim().length > 0) {
          summaryParts.push(content.trim());
        }
      }
    }

    return {
      date: targetDate,
      turns: allTurns,
      sessions: matchedSessions,
      totalMessages: matchedSessions.reduce((sum, s) => sum + s.messageCount, 0),
      totalToolCalls: allToolCalls.length,
      uniqueTools,
      summary: summaryParts.join('\n'),
    };
  }

  /**
   * 使用在线模型生成每日总结。
   * 如果 onlineProvider 未提供，返回空字符串。
   */
  async generateDailySummary(aggregation: DailyAggregation): Promise<string> {
    if (!this.onlineProvider) {
      return '';
    }

    // 构造 turns 的文本表示，限制在 ~4000 tokens 内
    const turnsText = formatTurnsForSummary(aggregation.turns);

    const prompt = [
      '请总结以下当日对话数据，包含：',
      '1. 主要任务和完成情况',
      '2. 关键决策',
      '3. 工具使用模式（哪些工具被频繁使用）',
      '4. 遇到的问题和解决方法',
      '5. 可提炼为训练样本的高质量对话',
      '',
      '对话数据：',
      turnsText,
    ].join('\n');

    // 构造 Message 调用 onlineProvider
    const message: Message = {
      role: 'user',
      content: { type: 'text', text: prompt },
    };

    // 收集流式响应
    let summary = '';
    try {
      for await (const event of this.onlineProvider.createStream([message])) {
        if (event.type === 'TEXT') {
          summary += event.content;
        }
      }
    } catch {
      // 流式调用失败时返回部分已收集的内容
    }

    return summary;
  }
}

/**
 * 从消息列表中提取对话回合。
 *
 * 遍历逻辑：
 * - 当遇到 role === 'user' 且 content 包含 text（非纯 tool_result）→ 开始新回合
 * - 下一轮 user text 之前的所有 assistant 和 user tool_result 都属于当前回合
 * - assistant 消息中提取 text、thinking、tool_use
 * - 后续 user 消息中提取 tool_result
 */
function extractConversationTurns(
  messages: Message[],
  sessionId: string,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  let currentTurn: ConversationTurn | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      // 判断是否是纯 tool_result 消息（没有 text 内容）
      const hasText = hasContentType(msg.content, 'text');
      const hasToolResult = hasContentType(msg.content, 'tool_result');

      if (hasText) {
        // 这是一个新的用户输入 → 结束当前回合，开始新回合
        if (currentTurn) {
          // 收尾当前回合
          finalizeTurn(currentTurn);
          turns.push(currentTurn);
        }

        currentTurn = {
          sessionId,
          timestamp: '',
          userMessage: extractText(msg.content),
          assistantReply: '',
        };

        // 如果同时包含 tool_result，也提取它们
        if (hasToolResult) {
          const trs = extractToolResults(msg.content);
          if (trs.length > 0) {
            currentTurn.toolResults = trs;
          }
        }
      } else if (hasToolResult && currentTurn) {
        // 仅在当前回合中跟随的 tool_result
        const trs = extractToolResults(msg.content);
        if (trs.length > 0) {
          if (!currentTurn.toolResults) {
            currentTurn.toolResults = [];
          }
          currentTurn.toolResults.push(...trs);
        }
      }
      // 纯 tool_result 且没有 currentTurn（消息序列异常），忽略
    } else if (msg.role === 'assistant' && currentTurn) {
      // assistant 消息：提取 text、thinking、tool_use
      const text = extractText(msg.content);
      if (text) {
        currentTurn.assistantReply += (currentTurn.assistantReply ? '\n' : '') + text;
      }

      const thinking = extractThinking(msg.content);
      if (thinking) {
        currentTurn.thinking = currentTurn.thinking
          ? currentTurn.thinking + '\n' + thinking
          : thinking;
      }

      const toolUses = extractToolUses(msg.content);
      if (toolUses.length > 0) {
        if (!currentTurn.toolCalls) {
          currentTurn.toolCalls = [];
        }
        currentTurn.toolCalls.push(...toolUses);
      }
    }
    // system 消息忽略
  }

  // 收尾最后一个回合
  if (currentTurn) {
    finalizeTurn(currentTurn);
    turns.push(currentTurn);
  }

  return turns;
}

/** 收尾一个 ConversationTurn：清理空字段 */
function finalizeTurn(turn: ConversationTurn): void {
  // 清理空的 toolCalls / toolResults
  if (turn.toolCalls && turn.toolCalls.length === 0) {
    delete turn.toolCalls;
  }
  if (turn.toolResults && turn.toolResults.length === 0) {
    delete turn.toolResults;
  }
  if (turn.thinking === '') {
    delete turn.thinking;
  }
}

/**
 * 将 ConversationTurn[] 格式化为适合作为 prompt 的文本表示。
 * 使用字符数近似估算 token 数（~4 chars/token），限制在 ~4000 tokens 即 ~16000 字符。
 */
function formatTurnsForSummary(turns: ConversationTurn[]): string {
  const MAX_CHARS = 16000; // ~4000 tokens
  const lines: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const header = `\n--- 对话 ${i + 1} (Session: ${turn.sessionId}) ---\n`;
    let block = header;
    totalChars += header.length;

    // 用户消息
    const userLine = `User: ${truncateStr(turn.userMessage, 500)}\n`;
    block += userLine;
    totalChars += userLine.length;

    // 助手回复
    if (turn.assistantReply) {
      const assistantLine = `Assistant: ${truncateStr(turn.assistantReply, 1000)}\n`;
      block += assistantLine;
      totalChars += assistantLine.length;
    }

    // 思考过程
    if (turn.thinking) {
      const thinkingLine = `Thinking: ${truncateStr(turn.thinking, 500)}\n`;
      block += thinkingLine;
      totalChars += thinkingLine.length;
    }

    // 工具调用
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      const toolNames = turn.toolCalls.map((tc) => tc.name).join(', ');
      const toolLine = `Tool Calls: ${toolNames}\n`;
      block += toolLine;
      totalChars += toolLine.length;
    }

    // 工具结果
    if (turn.toolResults && turn.toolResults.length > 0) {
      const resultsSummary = turn.toolResults
        .map((tr) => {
          const status = tr.isError ? '[ERROR]' : '';
          return `${status}${truncateStr(tr.content, 200)}`;
        })
        .join('; ');
      const resultLine = `Tool Results: ${resultsSummary}\n`;
      block += resultLine;
      totalChars += resultLine.length;
    }

    lines.push(block);

    // 达到上限时停止
    if (totalChars >= MAX_CHARS) {
      if (i < turns.length - 1) {
        lines.push(`\n... (共 ${turns.length} 轮对话，已截断至 ${i + 1} 轮)\n`);
      }
      break;
    }
  }

  return lines.join('');
}

/** 截断字符串到指定最大长度，超出部分用 ... 标记 */
function truncateStr(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}