/**
 * 招牌机制行为测试（P1-A）：意图簇压缩族（loop-cluster）。
 *
 * 覆盖：
 * 1. loadClusterIndex —— 从 events.jsonl 回放 cluster_assign 重建簇索引；
 * 2. maybeCompressCluster —— 低于预算不压缩；超预算走「压缩 → 存簇摘要 → 打 _compressed 标记」；
 * 3. buildClusterHistoryTransform —— 存档 <5MB 不启用；无匹配簇不启用；匹配时按当前意图过滤。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadClusterIndex, maybeCompressCluster, buildClusterHistoryTransform } from './loop-cluster.js';
import type { ClusterDeps } from './loop-cluster.js';
import type { Message } from '../types.js';

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: { type: 'text', text } };
}

let tmpDir: string;
let sessionDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cluster-'));
  sessionDir = path.join(tmpDir, 'session');
  fs.mkdirSync(sessionDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<Record<keyof ClusterDeps, unknown>> = {}): ClusterDeps {
  return {
    sessionDir,
    compressor: {
      getCompressionStats: vi.fn().mockReturnValue({ totalTokens: 1000 }),
      compress: vi.fn().mockResolvedValue({
        summary: 'CLUSTER_SUMMARY',
        compressedCount: 5,
        compressedMessages: [{ _compressed: { intent: 'coding', summary_hash: 'h', compressed_at: 't' } }],
        messages: [],
        phasesUsed: [2],
      }),
      saveClusterSummary: vi.fn().mockResolvedValue(undefined),
      getClusterSummary: vi.fn(),
    },
    conversationStore: {
      readFull: vi.fn().mockResolvedValue([textMsg('user', 'a'), textMsg('assistant', 'b')]),
      markCompressed: vi.fn().mockResolvedValue(undefined),
    },
    eventStore: {
      readAll: vi.fn().mockResolvedValue([]),
    },
    summaryStore: {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    },
    configCenter: { get: vi.fn().mockReturnValue(0.75) },
    maxContextTokens: 2000,
    getCurrentIntentCapability: () => 'coding',
    ...overrides,
  } as unknown as ClusterDeps;
}

describe('loadClusterIndex（簇索引回放）', () => {
  it('从 cluster_assign 事件重建簇索引，忽略其他事件', async () => {
    const deps = makeDeps({
      eventStore: {
        readAll: vi.fn().mockResolvedValue([
          { type: 'cluster_assign', cluster_id: 'c1', capability: 'coding', summary: 's1', line_start: 10, line_end: 20 },
          { type: 'other', foo: 'bar' },
          { type: 'cluster_assign', cluster_id: 'c2', capability: 'debug', summary: 's2', line_start: 30, line_end: 40 },
        ]),
      },
    });
    const clusters = await loadClusterIndex(deps);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ cluster_id: 'c1', line_start: 10, line_end: 20 });
  });

  it('eventStore 读取失败 → 空索引（不炸）', async () => {
    const deps = makeDeps({
      eventStore: { readAll: vi.fn().mockRejectedValue(new Error('no events')) },
    });
    expect(await loadClusterIndex(deps)).toEqual([]);
  });
});

describe('maybeCompressCluster（簇级压缩门控）', () => {
  it('token 低于预算：不压缩（保持"簇没到阈值不动"）', async () => {
    const compressor = makeDeps().compressor;
    const deps = makeDeps({
      compressor: {
        ...compressor,
        getCompressionStats: vi.fn().mockReturnValue({ totalTokens: 100 }), // 预算 1500，不超
      },
    });
    await maybeCompressCluster(deps, 'c1', 1, 2, 'coding');
    expect((deps.compressor.compress as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('token 超预算：压缩 → 存簇摘要 → 打 _compressed 标记', async () => {
    const deps = makeDeps({
      conversationStore: {
        readFull: vi.fn().mockResolvedValue([textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c')]),
        markCompressed: vi.fn().mockResolvedValue(undefined),
      },
    });
    // 修补 getCompressionStats 使 token 超预算（2000 > 预算 1500），其余 mock 保持 makeDeps 基线
    (deps.compressor as unknown as { getCompressionStats: ReturnType<typeof vi.fn> }).getCompressionStats =
      vi.fn().mockReturnValue({ totalTokens: 2000 });
    await maybeCompressCluster(deps, 'c1', 1, 3, 'coding');

    // 摘要按簇 ID 落盘（cluster_c1.md）
    expect(deps.summaryStore.save).toHaveBeenCalledWith(sessionDir, 'CLUSTER_SUMMARY', 'c1');
    // 被压缩消息写回 _compressed 标记（行号切片正确：lineStart-1 开始）
    expect(deps.conversationStore.markCompressed).toHaveBeenCalledWith(sessionDir, 1, 5, expect.any(Object));
    expect(deps.compressor.saveClusterSummary).toHaveBeenCalledWith(sessionDir, 'coding');
  });
});

describe('buildClusterHistoryTransform（簇历史过滤）', () => {
  function writeFullArchive(bytes: number): void {
    const buf = Buffer.alloc(bytes, 0x61);
    fs.writeFileSync(path.join(sessionDir, 'conversation_full.jsonl'), buf);
  }

  it('存档 <5MB 或不存在：返回 null（不过滤，全量注入）', async () => {
    writeFullArchive(1024);
    const deps = makeDeps();
    expect(await buildClusterHistoryTransform(deps)).toBeNull();
  });

  it('无匹配当前意图的簇：返回 null', async () => {
    writeFullArchive(6 * 1024 * 1024);
    const deps = makeDeps({
      eventStore: {
        readAll: vi.fn().mockResolvedValue([
          { type: 'cluster_assign', cluster_id: 'c1', capability: 'debug', summary: 's', line_start: 1, line_end: 5 },
        ]),
      },
    });
    expect(await buildClusterHistoryTransform(deps)).toBeNull(); // 当前意图 coding 无匹配
  });

  it('匹配当前意图：返回过滤函数，保留目标簇消息 + 最近 10 条保底', async () => {
    writeFullArchive(6 * 1024 * 1024);
    const clusterMsgs = [
      { ...textMsg('user', 'cluster-old'), _cluster_id: 'c1' },
      { ...textMsg('assistant', 'cluster-old-2'), _cluster_id: 'c1' },
    ];
    const recentMsgs = Array.from({ length: 12 }, (_, i) => textMsg(i % 2 ? 'user' : 'assistant', `recent-${i}`));
    const deps = makeDeps({
      eventStore: {
        readAll: vi.fn().mockResolvedValue([
          { type: 'cluster_assign', cluster_id: 'c1', capability: 'coding', summary: 's', line_start: 1, line_end: 2 },
        ]),
      },
      conversationStore: {
        readFull: vi.fn().mockResolvedValue([...clusterMsgs, ...recentMsgs]),
      },
    });

    const filter = await buildClusterHistoryTransform(deps);
    expect(filter).not.toBeNull();
    // 传 10 条 fallback：过滤结果 12 条 <= 10*3，不触发「归档远大于历史则回退」防御
    const fallback = Array.from({ length: 10 }, (_, i) => textMsg(i % 2 ? 'user' : 'assistant', 'fallback-' + i));
    const out = filter!(fallback);
    // 目标簇消息被保留，最近保底也在
    const texts = out.map((m) => (m.content as { text?: string }).text).filter(Boolean);
    expect(texts).toContain('cluster-old');
    expect(texts).toContain('recent-11');
  });
});
