import type { Provider } from '../../provider/interface.js';
import type { Message } from '../../types.js';
import type { KeywordEntry } from './types.js';
import { loadPrompt } from '../../prompts/loader.js';

export interface TurnSummary {
  /** 这段对话做了什么（一句话） */
  summary: string;
  /** 本段对话特有的关键词 */
  keywords: string[];
  /** 对应的 turn 编号（合并后可能覆盖多个 turn） */
  indices: number[];
}

export interface AnalysisResult {
  keywords: KeywordEntry[];
  turns: TurnSummary[];
}

/**
 * 异步分析对话：提取全局关键词 + 每段对话的摘要。
 * 在 LLM 回复后调用，不阻塞主流程。
 */
export async function analyzeConversation(
  messages: Message[],
  provider: Provider,
): Promise<AnalysisResult> {
  const prompt = loadPrompt('precise/analyze');
  if (!prompt) return { keywords: [], turns: [] };

  const turnsText = formatTurns(messages);
  if (!turnsText) return { keywords: [], turns: [] };

  const systemMsg: Message = {
    role: 'system',
    content: { type: 'text', text: prompt },
  };
  const userMsg: Message = {
    role: 'user',
    content: { type: 'text', text: turnsText },
  };

  try {
    let raw = '';
    for await (const event of provider.createStream([systemMsg, userMsg])) {
      if (event.type === 'TEXT') raw += event.content;
    }
    return parseAnalysisResult(raw);
  } catch {
    return { keywords: [], turns: [] };
  }
}

function formatTurns(messages: Message[]): string {
  const parts: string[] = [];
  let turnIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = extractText(msg.content);
    if (msg.role === 'user' && text) {
      turnIndex++;
      parts.push(`[Turn ${turnIndex}] user: ${text.slice(0, 800)}`);
    } else if (msg.role === 'assistant' && text) {
      parts.push(`[Turn ${turnIndex}] assistant: ${text.slice(0, 800)}`);
    }
  }
  return parts.join('\n\n');
}

function parseAnalysisResult(raw: string): AnalysisResult {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim();
    const obj = JSON.parse(cleaned);

    const keywords: KeywordEntry[] = (obj.keywords || [])
      .filter((item: unknown) => typeof item === 'object' && item !== null)
      .map((item: Record<string, unknown>) => ({
        keyword: String(item.keyword ?? ''),
        weight: Number(item.weight ?? 1),
        source: String(item.source ?? 'assistant'),
      }))
      .filter((e: KeywordEntry) => e.keyword.length > 0);

    const turns: TurnSummary[] = (obj.turns || [])
      .filter((item: unknown) => typeof item === 'object' && item !== null)
      .map((item: Record<string, unknown>, i: number) => ({
        summary: String(item.summary ?? ''),
        keywords: Array.isArray(item.keywords)
          ? (item.keywords as string[]).filter((k: string) => k.length > 0)
          : [],
        indices: [i + 1],
      }))
      .filter((t: TurnSummary) => t.summary.length > 0);

    return { keywords, turns };
  } catch {
    // fallback: line-by-line keyword extraction
    const lines = raw.split('\n').filter(l => l.trim());
    const keywords: KeywordEntry[] = lines.map(line => ({
      keyword: line.replace(/^[-*\d.]+\s*/, '').trim(),
      weight: 1,
      source: 'assistant' as const,
    })).filter(e => e.keyword.length > 0);
    return { keywords, turns: [] };
  }
}

/** 从消息内容中提取纯文本 */
export function extractText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join(' ');
  }
  if (content && typeof content === 'object' && content.type === 'text') {
    return (content as { text: string }).text;
  }
  return '';
}

/**
 * 使用关键词 + 摘要匹配历史消息。
 * @param history 完整历史
 * @param keywords 全局关键词
 * @param summaries 各 turn 的摘要
 * @param minHits 最少命中数
 */
export function matchHistory(
  history: Message[],
  keywords: string[],
  summaries: TurnSummary[] = [],
  minHits: number = 2,
): Message[] {
  if (keywords.length === 0 && summaries.length === 0) return history.slice(-6);

  // 摘要关键词：每个 turn 提取的关键词，权重高于全局关键词
  const turnKeywords: string[] = [];
  for (const s of summaries) {
    turnKeywords.push(...s.keywords.map(k => k.toLowerCase()));
  }

  const matched: Message[] = [];
  for (const msg of history) {
    const text = extractText(msg.content).toLowerCase();
    let hits = 0;
    // 全局关键词匹配
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) hits++;
    }
    // 摘要关键词匹配（权重 ×2：摘要关键词更精准）
    for (const kw of turnKeywords) {
      if (text.includes(kw)) hits += 2;
    }
    if (hits >= minHits) matched.push(msg);
  }
  return matched;
}
