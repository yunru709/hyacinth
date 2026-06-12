import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConversationTurn } from './aggregator.js';
import type { RefinedSample } from './refined-store.js';
import { RefinedDataStore } from './refined-store.js';

// ============================================================================
// 类型定义
// ============================================================================

/** 支持的训练数据格式 */
export type DatasetFormat = 'chatml' | 'sharegpt' | 'alpaca';

/** 数据集构建结果 */
export interface DatasetResult {
  /** 输出文件路径 */
  filePath: string;
  /** 数据格式 */
  format: DatasetFormat;
  /** 样本数量 */
  sampleCount: number;
  /** 来源 session ID 列表（去重） */
  sourceSessions: string[];
  /** 数据日期 */
  date: string;
}

/** ChatML 格式样本 */
export interface ChatMLSample {
  messages: Array<{ role: string; content: string | null; [key: string]: unknown }>;
}

/** ShareGPT 格式样本 */
export interface ShareGPTSample {
  conversations: Array<{ from: 'human' | 'gpt'; value: string }>;
}

/** Alpaca 格式样本 */
export interface AlpacaSample {
  instruction: string;
  input: string;
  output: string;
}

/** 数据集元信息 */
export interface DatasetMeta {
  sampleCount: number;
  sourceSessions: string[];
  date: string;
  format: DatasetFormat;
  generatedAt: string;
}

// ============================================================================
// 工具函数
// ============================================================================

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 将 ChatML 样本转为 ShareGPT 格式 */
function chatmlToShareGpt(sample: ChatMLSample): ShareGPTSample {
  const conversations: ShareGPTSample['conversations'] = [];

  for (const msg of sample.messages) {
    if (msg.role === 'system') {
      // ShareGPT 中 system 消息放在第一条 human 消息前
      if (typeof msg.content === 'string' && msg.content) {
        conversations.push({ from: 'human', value: msg.content });
        conversations.push({ from: 'gpt', value: 'OK.' });
      }
    } else if (msg.role === 'user') {
      conversations.push({ from: 'human', value: typeof msg.content === 'string' ? msg.content : '' });
    } else if (msg.role === 'assistant') {
      // 跳过纯 tool_calls 的 assistant 消息（无文本）
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) {
        conversations.push({ from: 'gpt', value: text });
      }
    }
    // tool 角色消息在 ShareGPT 中忽略
  }

  return { conversations };
}

/** 将 ChatML 样本转为 Alpaca 格式 */
function chatmlToAlpaca(sample: ChatMLSample): AlpacaSample {
  // 第一个 user 消息作为 instruction
  let instruction = '';
  let output = '';

  for (const msg of sample.messages) {
    if (msg.role === 'user' && !instruction) {
      instruction = typeof msg.content === 'string' ? msg.content : '';
    } else if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) {
        output = output ? output + '\n' + text : text;
      }
    }
  }

  return { instruction, input: '', output };
}

/** 生成数据集元信息 */
function buildMeta(
  sampleCount: number,
  sessions: string[],
  date: string,
  format: DatasetFormat,
): DatasetMeta {
  return {
    sampleCount,
    sourceSessions: sessions,
    date,
    format,
    generatedAt: new Date().toISOString(),
  };
}

/** 去重 + 过滤：返回干净的 turn 列表和来源 session 列表 */
function filterAndDedup(
  turns: ConversationTurn[],
  predicate: (turn: ConversationTurn) => boolean,
): { filtered: ConversationTurn[]; sessions: string[] } {
  const seen = new Set<string>();
  const filtered: ConversationTurn[] = [];
  const sessionSet = new Set<string>();

  for (const turn of turns) {
    // 跳过空内容
    if (!turn.userMessage || !turn.assistantReply) continue;

    // 应用筛选条件
    if (!predicate(turn)) continue;

    // 去重：同一 session 内相同 userMessage 只保留一次
    const dedupKey = `${turn.sessionId}::${turn.userMessage}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    filtered.push(turn);
    sessionSet.add(turn.sessionId);
  }

  return {
    filtered,
    sessions: [...sessionSet].sort(),
  };
}

// ============================================================================
// DatasetBuilder
// ============================================================================

export class DatasetBuilder {
  constructor(private outputDir: string) {}

  /**
   * 构建通用对话数据集（ChatML + ShareGPT + Alpaca 格式）。
   *
   * 筛选条件：不含 tool call 的纯对话 turn。
   * 输出到 `{outputDir}/{date}/chat/` 目录。
   */
  async buildConversationDataset(
    turns: ConversationTurn[],
    date: string,
  ): Promise<DatasetResult> {
    const { filtered, sessions } = filterAndDedup(
      turns,
      (turn) => !turn.toolCalls || turn.toolCalls.length === 0,
    );

    const chatDir = path.join(this.outputDir, date, 'chat');
    await ensureDir(chatDir);

    // 构建 ChatML 样本
    const chatmlSamples: ChatMLSample[] = filtered.map((turn) => ({
      messages: [
        { role: 'user', content: turn.userMessage },
        { role: 'assistant', content: turn.assistantReply },
      ],
    }));

    // ChatML JSONL
    const chatmlPath = path.join(chatDir, 'chatml.jsonl');
    const chatmlLines = chatmlSamples.map((s) => JSON.stringify(s));
    await fs.writeFile(chatmlPath, chatmlLines.join('\n') + (chatmlLines.length > 0 ? '\n' : ''), 'utf-8');

    // ShareGPT JSONL
    const sharegptPath = path.join(chatDir, 'sharegpt.jsonl');
    const sharegptSamples = chatmlSamples.map(chatmlToShareGpt);
    const sharegptLines = sharegptSamples.map((s) => JSON.stringify(s));
    await fs.writeFile(sharegptPath, sharegptLines.join('\n') + (sharegptLines.length > 0 ? '\n' : ''), 'utf-8');

    // Alpaca JSONL
    const alpacaPath = path.join(chatDir, 'alpaca.jsonl');
    const alpacaSamples = chatmlSamples.map(chatmlToAlpaca);
    const alpacaLines = alpacaSamples.map((s) => JSON.stringify(s));
    await fs.writeFile(alpacaPath, alpacaLines.join('\n') + (alpacaLines.length > 0 ? '\n' : ''), 'utf-8');

    // 元信息
    const meta = buildMeta(filtered.length, sessions, date, 'chatml');
    const metaPath = path.join(chatDir, 'dataset_info.json');
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

    return {
      filePath: chatmlPath,
      format: 'chatml',
      sampleCount: filtered.length,
      sourceSessions: sessions,
      date,
    };
  }

  /**
   * 构建工具调用数据集。
   *
   * 筛选条件：包含 tool call 的 turn。
   * 使用原生 ChatML tool calling 格式，输出为 JSON 数组（llama.cpp 需要此格式）。
   * 输出到 `{outputDir}/{date}/tools/all.json`。
   */
  async buildToolCallDataset(
    turns: ConversationTurn[],
    date: string,
  ): Promise<DatasetResult> {
    const { filtered, sessions } = filterAndDedup(
      turns,
      (turn) => !!(turn.toolCalls && turn.toolCalls.length > 0),
    );

    const toolsDir = path.join(this.outputDir, date, 'tools');
    await ensureDir(toolsDir);

    // 构建 ChatML tool calling 格式样本
    const samples: ChatMLSample[] = filtered.map((turn) =>
      buildToolCallSample(turn),
    );

    // 输出为 JSON 数组
    const outputPath = path.join(toolsDir, 'all.json');
    await fs.writeFile(outputPath, JSON.stringify(samples, null, 2) + '\n', 'utf-8');

    // 元信息
    const meta = buildMeta(filtered.length, sessions, date, 'chatml');
    const metaPath = path.join(toolsDir, 'dataset_info.json');
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

    return {
      filePath: outputPath,
      format: 'chatml',
      sampleCount: filtered.length,
      sourceSessions: sessions,
      date,
    };
  }

  async buildReplayDataset(
    currentSamples: RefinedSample[],
    refinedStore: RefinedDataStore,
    options?: { replayRatio?: number },
  ): Promise<RefinedSample[]> {
    const replayRatio = options?.replayRatio ?? 0.15;

    const versions = await refinedStore.listVersions();
    if (versions.length === 0) {
      return currentSamples;
    }

    const replaySamples: RefinedSample[] = [];
    for (const version of versions) {
      const samples = await refinedStore.load(version);
      const shuffled = [...samples].sort(() => Math.random() - 0.5);
      const count = Math.ceil(samples.length * replayRatio);
      replaySamples.push(...shuffled.slice(0, count));
    }

    const combined = [...currentSamples, ...replaySamples];

    const seen = new Set<string>();
    const deduped: RefinedSample[] = [];
    for (const sample of combined) {
      const hash = createHash('sha256').update(sample.instruction).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      deduped.push(sample);
    }

    return deduped;
  }

  /**
   * 为特定工具构建 Adapter 训练数据。
   *
   * 筛选条件：使用了指定工具的 turn。
   * 输出到 `{outputDir}/{date}/tools/{toolName}.json`。
   */
  async buildAdapterDataset(
    turns: ConversationTurn[],
    toolName: string,
    date: string,
  ): Promise<DatasetResult> {
    const { filtered, sessions } = filterAndDedup(
      turns,
      (turn) => !!(turn.toolCalls?.some((tc) => tc.name === toolName)),
    );

    const toolsDir = path.join(this.outputDir, date, 'tools');
    await ensureDir(toolsDir);

    // 构建 ChatML tool calling 格式样本
    const samples: ChatMLSample[] = filtered.map((turn) =>
      buildToolCallSample(turn),
    );

    // 输出为 JSON 数组
    const outputPath = path.join(toolsDir, `${toolName}.json`);
    await fs.writeFile(outputPath, JSON.stringify(samples, null, 2) + '\n', 'utf-8');

    // 元信息
    const meta = buildMeta(filtered.length, sessions, date, 'chatml');
    // 每个工具的 dataset_info 放在同目录下，用 toolName 前缀避免冲突
    const metaPath = path.join(toolsDir, `dataset_info_${toolName}.json`);
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

    return {
      filePath: outputPath,
      format: 'chatml',
      sampleCount: filtered.length,
      sourceSessions: sessions,
      date,
    };
  }
}

// ============================================================================
// 内部构建函数
// ============================================================================

/**
 * 将单个 ConversationTurn 转换为 ChatML tool calling 格式。
 *
 * 生成的 messages 结构：
 *   1. system — 固定提示词
 *   2. user — 用户消息
 *   3. assistant — content 为助手文本（若有），tool_calls 为工具调用列表
 *   4. tool (xN) — 每个工具调用对应一条 tool 消息，包含返回结果
 */
function buildToolCallSample(turn: ConversationTurn): ChatMLSample {
  const messages: ChatMLSample['messages'] = [];

  // System prompt
  messages.push({
    role: 'system',
    content: 'You are a helpful assistant with access to tools.',
  });

  // User message
  messages.push({ role: 'user', content: turn.userMessage });

  // Assistant message with tool_calls
  const toolCalls = (turn.toolCalls ?? []).map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }));

  // assistantReply 可能包含工具调用前后的思考/说明文本
  const assistantContent = turn.assistantReply || null;

  messages.push({
    role: 'assistant',
    content: assistantContent,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  });

  // Tool result messages — 按 toolUseId 匹配
  if (turn.toolResults && turn.toolResults.length > 0) {
    for (const tr of turn.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.toolUseId,
        content: tr.content,
      });
    }
  }

  return { messages };
}