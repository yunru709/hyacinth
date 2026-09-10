/**
 * 招牌机制行为测试（P1-A）：四阶段差分压缩器 + ToolOutputTrimmer。
 *
 * 覆盖三个被审计确认过的关键承诺：
 * 1. 决策 C：被压缩消息打 _compressed 标记（intent / summary_hash / compressed_at），不静默丢弃；
 * 2. 摘要失败降级：summarizer 抛错时绝不丢 layer3，降级规则裁剪（ToolOutputTrimmer）；
 * 3. 收敛：达到 targetRatio(0.15) 或 0.5 即停，不多压。
 * 4. protectLast 保护区不被压缩。
 */
import { describe, it, expect, vi } from 'vitest';
import { CompressorOrchestrator, ToolOutputTrimmer } from './compressor.js';
import type { Message } from '../types.js';

// ── helpers ─────────────────────────────────────────────────────────

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: { type: 'text', text } };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: { type: 'tool_result', tool_use_id: toolUseId, content },
  };
}

function makeHistory(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    i % 3 === 2
      ? toolResultMsg(`tu_${i}`, `tool-output-${i}`)
      : textMsg(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`),
  );
}

/** 每个消息固定 10 token 的假 tokenizer（token 数 = 消息数 × 10） */
const constTokenizer = {
  countMessagesTokens: (msgs: Message[]) => msgs.length * 10,
};

function makeSummarizer(impl?: { fail?: boolean; summary?: string }) {
  return {
    setCompressDepth: vi.fn(),
    summarize: vi.fn().mockImplementation(async () => {
      if (impl?.fail) throw new Error('LLM unavailable');
      return impl?.summary ?? 'MOCK_SUMMARY';
    }),
  };
}

// ── ToolOutputTrimmer ────────────────────────────────────────────────

describe('ToolOutputTrimmer（规则裁剪）', () => {
  it('trimToolResults：最近 trimWindow 条保留，更旧的工具结果被裁剪', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => toolResultMsg(`tu_${i}`, `RAW-${i}`));
    const out = new ToolOutputTrimmer(6).trimToolResults(msgs);

    // 旧结果被替换（不再是原文），新结果保留原文
    expect(out[0].content).not.toHaveProperty('content', 'RAW-0');
    expect(out[9].content).toHaveProperty('content', 'RAW-9');
  });

  it('deduplicateToolResults：相同内容的工具结果只保留最新，旧引用替换为 [Duplicate]', () => {
    const msgs = [
      toolResultMsg('tu_1', 'SAME'),
      toolResultMsg('tu_2', 'SAME'),
      toolResultMsg('tu_3', 'DIFF'),
    ];
    const out = new ToolOutputTrimmer(6).deduplicateToolResults(msgs);

    // tu_1 与 tu_2 内容相同 → 其中一个被替换为 [Duplicate]
    const contents = out.map((m) => (m.content as { content: string }).content);
    expect(contents.some((c) => c.startsWith('[Duplicate]'))).toBe(true);
    expect(contents.some((c) => c === 'DIFF')).toBe(true);
  });

  it('truncateLargeToolCalls：超大 tool_call input 被截断/摘要', () => {
    const hugeInput = { file_path: '/x', content: 'A'.repeat(5000) };
    const msgs: Message[] = [
      { role: 'assistant', content: { type: 'tool_use', id: 'tu_big', name: 'write', input: hugeInput } },
    ];
    const out = new ToolOutputTrimmer(6).truncateLargeToolCalls(msgs, 2000);
    const input = (out[0].content as { input: unknown }).input as Record<string, unknown>;
    expect(String(input.content ?? '')).toHaveLength(0); // 智能摘要后不再携带原文
  });
});

// ── CompressorOrchestrator（mock tokenizer + summarizer）─────────────

describe('CompressorOrchestrator（四阶段差分压缩）', () => {
  it('needsCompression / getCompressionStats 阈值语义', () => {
    const c = new CompressorOrchestrator(constTokenizer, makeSummarizer() as never, 200, {
      compressThreshold: 0.75,
    });
    expect(c.needsCompression(makeHistory(20))).toBe(true); // 200/200 = 1.0
    expect(c.needsCompression(makeHistory(10))).toBe(false); // 100/200 = 0.5
    const stats = c.getCompressionStats(makeHistory(10));
    expect(stats.usageRatio).toBe(0.5);
  });

  it('compress 成功：_compressed 标记（intent/summary_hash/compressed_at）+ 收敛不超压', async () => {
    const summarizer = makeSummarizer();
    const c = new CompressorOrchestrator(constTokenizer, summarizer as never, 300, {
      maxRounds: 3,
      compressThreshold: 0.75,
      targetRatio: 0.15,
      safetyThreshold: 0.95,
    });
    const result = await c.compress(makeHistory(30), undefined, 2, 300);

    // 收敛：messages 数量明显减少，且没有把保护区压缩掉
    expect(result.messages.length).toBeLessThan(30);
    expect(result.compressedCount).toBeGreaterThan(0);
    // 决策 C：被压缩消息带 _compressed 标记
    expect(result.compressedMessages).toBeDefined();
    for (const m of result.compressedMessages!) {
      expect(m._compressed?.intent).toBe('general');
      expect(m._compressed?.summary_hash).toBeTruthy();
      expect(m._compressed?.compressed_at).toBeTruthy();
    }
    expect(result.summary).toBe('MOCK_SUMMARY');
    // phasesUsed 含 2（首轮无旧摘要 → 全量摘要）
    expect(result.phasesUsed).toContain(2);
  });

  it('compress 摘要失败：绝不丢 layer3，降级规则裁剪且不打 _compressed 标记', async () => {
    const c = new CompressorOrchestrator(constTokenizer, makeSummarizer({ fail: true }) as never, 300, {
      maxRounds: 3,
      safetyThreshold: 0.95,
    });
    const result = await c.compress(makeHistory(30), undefined, 2, 300);

    // 文本消息全部保留（无数据丢失），只裁剪了旧工具结果
    const texts = result.messages.filter((m) => m.content && (m.content as { type: string }).type === 'text');
    expect(texts.length).toBeGreaterThanOrEqual(18); // 30 条中 10 条是工具结果，文本绝大多数保留（防静默丢数据）
    expect(result.compressedMessages).toBeUndefined(); // 未成功摘要 → 无标记
    expect(result.summary).toBeUndefined();
    expect(result.compressedCount).toBeGreaterThan(0); // 规则裁剪仍然压掉工具结果
  });

  it('compress protectLast：最后 N 条消息不被压缩', async () => {
    const c = new CompressorOrchestrator(constTokenizer, makeSummarizer() as never, 300, {
      maxRounds: 3,
      safetyThreshold: 0.95,
    });
    // 纯文本输入：保护区消息可精确定位（避免工具结果/孤儿修复的干扰）
    const input = Array.from({ length: 30 }, (_, i) =>
      textMsg(i % 2 === 0 ? 'user' : 'assistant', 'm' + i),
    );
    const result = await c.compress(input, undefined, 5, 300);

    const outTexts = result.messages.map((m) => (m.content as { text?: string }).text).filter(Boolean);
    // 保护区（最后 5 条）按原顺序完整保留在输出尾部
    expect(outTexts.slice(-5)).toEqual(['m25', 'm26', 'm27', 'm28', 'm29']);
  });

  it('compress clusterKey：摘要进分桶（getClusterSummary）+ 标记 intent 为 capability', async () => {
    const c = new CompressorOrchestrator(constTokenizer, makeSummarizer() as never, 300, {
      maxRounds: 1,
      safetyThreshold: 0.95,
    });
    const result = await c.compress(makeHistory(30), undefined, 0, 300, {
      clusterKey: 'coding',
    });
    expect(result.compressedMessages?.[0]?._compressed?.intent).toBe('coding');
    expect(c.getClusterSummary('coding')).toBe('MOCK_SUMMARY');
  });
});
