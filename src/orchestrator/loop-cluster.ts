/**
 * 意图簇压缩族（B3 拆出）——簇级压缩、簇索引回放、cluster 历史过滤变换。
 *
 * 原为 loop.ts 的四个私有方法：maybeCompressCluster / buildClusterHistoryTransform /
 * loadClusterIndex / _maybeRestoreSummary（~190 行）。纯计算 + 文件/存储操作，
 * 无 loop 内部状态回写，故拆为模块级函数；AgentLoop 保留同名薄壳方法
 * （stageServices 闭包与 run() 内两处调用点经 loop 转发）。
 * 行为零变更：纯搬移，`this.xxx` 参数化为 deps。
 */
import path from 'node:path';
import { basename } from 'node:path';
import { compressorUserId } from '../provider/user-id.js';
import os from 'node:os';
import fs from 'node:fs';
import type { Message } from '../types.js';
import type { CompressorOrchestrator } from '../context/compressor.js';
import type { ConversationStore } from '../memory/conversation.js';
import type { EventStore } from '../memory/events.js';
import type { SummaryStore } from '../memory/summary.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { Logger } from '../logging/logger.js';

/** 簇压缩族的依赖快照（每轮由 makeClusterDeps() 现取当前值） */
export interface ClusterDeps {
  sessionDir: string;
  compressor: CompressorOrchestrator;
  conversationStore: ConversationStore;
  eventStore: EventStore;
  summaryStore: SummaryStore;
  configCenter?: RuntimeConfigCenter;
  maxContextTokens: number;
  /** 当前意图 capability（loop.getCurrentIntentCapability()，来自 _currentIntent 实时值） */
  getCurrentIntentCapability: () => string;
  logger?: Logger;
}

/** 簇索引条目（events.jsonl cluster_assign 事件回放结果） */
export interface ClusterIndexEntry {
  cluster_id: string;
  capability: string;
  summary: string;
  line_start: number;
  line_end: number;
}

/**
 * 检查指定簇是否超限，超限则从全量存档提取消息并压缩。
 * 压缩结果存入 summaries/cluster_X.md。
 * 触发阈值沿用现有全局压缩阈值（context.compressThreshold），不为簇独立设计。
 */
export async function maybeCompressCluster(
  deps: ClusterDeps,
  clusterId: string,
  lineStart: number,
  lineEnd: number,
  capability: string,
): Promise<void> {
  const { sessionDir, compressor, conversationStore, summaryStore, configCenter, logger } = deps;
  try {
    const fullMsgs = await conversationStore.readFull(sessionDir);
    const clusterMsgs = fullMsgs.slice(lineStart - 1, lineEnd); // 行号从 1 开始
    if (clusterMsgs.length === 0) return;

    const tokenCount = compressor
      ? compressor.getCompressionStats(clusterMsgs).totalTokens
      : clusterMsgs.length * 50; // 回退估算

    // 沿用全局压缩阈值（与主流程一致），预算 = 总上限 × 全局阈值
    const compressThreshold = configCenter
      ? (configCenter.get('context.compressThreshold') as number) ?? 0.75
      : 0.75;
    const budget = deps.maxContextTokens * compressThreshold;
    if (tokenCount < budget) return;

    if (!compressor) {
      logger?.info?.(`[cluster] compress skipped for ${clusterId}: no compressor available`);
      return;
    }

    logger?.info?.(
      `[cluster] compressing cluster "${clusterId}" (${capability}): ` +
      `${clusterMsgs.length} msgs, ${tokenCount} tokens > ${budget} budget`,
    );

    // 加载已有簇摘要做增量压缩
    const existingSummary = await summaryStore.load(sessionDir, clusterId);
    const result = await compressor.compress(
      clusterMsgs,
      existingSummary ?? undefined,
      0,         // protectLast = 0（簇内不加保护）
      budget,
      // 方案 3.5：指定 clusterKey 按簇压缩——预算 ×0.7、摘要入 clusterSummaries 分桶、收集 compressedMessages
      { clusterKey: capability, userId: compressorUserId(basename(sessionDir)) },
    );

    if (result.summary) {
      // 簇级摘要（cluster_{clusterId}.md）——factory 读取端依赖此路径（Step 4 对齐）
      await summaryStore.save(sessionDir, result.summary, clusterId);
      // 方案 G：capability 分桶（summary.{capability}.md），渐进式新增包装层
      try {
        await compressor.saveClusterSummary(sessionDir, capability);
      } catch { /* 分桶写入失败不阻塞 */ }
      // 决策 C：被压缩消息写回 _compressed 标记（仅保留最近一次压缩记录，覆盖而非追加）
      if (result.compressedCount && result.compressedCount > 0) {
        const marker = result.compressedMessages?.[0]?._compressed ?? {
          intent: capability,
          summary_hash: '',
          compressed_at: new Date().toISOString(),
        };
        await conversationStore.markCompressed(
          sessionDir,
          lineStart,
          result.compressedCount,
          marker,
        );
      }
      logger?.info?.(
        `[cluster] compressed "${clusterId}" (${capability}): ${result.compressedCount ?? 0} msgs → summary saved + _compressed marked`,
      );
    }
  } catch (err) {
    logger?.warn?.(
      `[cluster] compress failed for "${clusterId}": ${(err as Error).message}`,
    );
  }
}

// ── 意图簇：Composer 过滤钩子 ─────────────────────────────

/**
 * 构建 historyTransform 函数供 Composer 使用。
 * 启用条件：conversation_full.jsonl 文件大小 > 5MB 且存在匹配当前意图的簇。
 * 过滤基于全量归档（conversation_full.jsonl，含 _cluster_id 标记）：
 *   保留「当前意图簇的消息 + 最近 N 轮保底」，其余丢弃。
 * 未启用时返回 null（全量注入，和现在一样）。
 */
export async function buildClusterHistoryTransform(
  deps: ClusterDeps,
): Promise<((msgs: Message[]) => Message[]) | null> {
  const { sessionDir, conversationStore, logger } = deps;
  // 阈值检查
  try {
    const fullPath = path.join(sessionDir, 'conversation_full.jsonl');
    const stat = await fs.promises.stat(fullPath);
    if (stat.size < 5 * 1024 * 1024) return null; // < 5MB，不过滤
  } catch {
    return null; // 文件不存在
  }

  // 读取簇索引（从 events.jsonl 回放）
  const clusters = await loadClusterIndex(deps);
  if (clusters.length === 0) return null;

  const currentCapability = deps.getCurrentIntentCapability();
  // 当前意图对应的簇 ID 集合（capability 匹配）
  const targetClusterIds = new Set(
    clusters.filter((c) => c.capability === currentCapability).map((c) => c.cluster_id),
  );
  if (targetClusterIds.size === 0) {
    logger?.info?.(
      `[cluster] filter skipped: capability=${currentCapability} 无匹配簇，回退全量注入`,
    );
    return null;
  }

  const recentCount = 10; // 最近 N 轮保底（与压缩器 protect 量级一致）

  logger?.info?.(
    `[cluster] filter enabled: capability=${currentCapability}, ` +
    `targetClusters=${[...targetClusterIds].join(',')}, recent=${recentCount}`,
  );

  // 预取全量归档并预筛（全量归档含 _cluster_id 标记，conversation.jsonl 没有）
  // 闭包内同步返回，避免 composer 的同步 historyTransform 阻塞。
  const fullMsgs = await conversationStore.readFull(sessionDir);
  if (fullMsgs.length === 0) return null;
  const recentMsgs = fullMsgs.slice(-recentCount);
  const olderMsgs = fullMsgs.slice(0, -recentCount);
  const keptOlder = olderMsgs.filter(
    (m) => m._cluster_id && targetClusterIds.has(m._cluster_id),
  );
  const filteredFull = [...keptOlder, ...recentMsgs];

  return (_msgs: Message[]): Message[] => {
    // 若过滤结果为空，回退调用方传入的历史（防御）
    if (filteredFull.length === 0) return _msgs;
    // 全量归档远大于 conversation 历史时（压缩已发生），以 conversation 为准
    // 避免压缩后的精简历史被全量原始消息绕过
    if (filteredFull.length > _msgs.length * 3) return _msgs;
    return filteredFull;
  };
}

/**
 * 从 events.jsonl 回放 cluster_assign 事件，重建簇索引。
 */
export async function loadClusterIndex(deps: ClusterDeps): Promise<ClusterIndexEntry[]> {
  const { sessionDir, eventStore } = deps;
  try {
    const events = await eventStore.readAll(sessionDir);
    const clusters: ClusterIndexEntry[] = [];
    for (const evt of events) {
      if (evt.type === 'cluster_assign') {
        clusters.push({
          cluster_id: evt.cluster_id as string,
          capability: evt.capability as string,
          summary: evt.summary as string,
          line_start: evt.line_start as number,
          line_end: evt.line_end as number,
        });
      }
    }
    return clusters;
  } catch {
    return [];
  }
}

/**
 * deep 压缩临时模板恢复：turn 结束后把 summary.md 恢复为原内容
 * （deepCompressOriginal 保存的原模板；null 表示原本无自定义模板 → 删临时文件）。
 * 状态（_deepCompressRestore / _deepCompressOriginal）留在 loop：
 * 经 restore 对象传入（引用语义），函数内直接改写字段实现回写，
 * loop 侧随即将快照同步回私有字段。
 */
export function maybeRestoreSummary(
  restore: { deepCompressRestore: boolean; deepCompressOriginal: string | null },
): { deepCompressRestore: boolean; deepCompressOriginal: string | null } {
  if (!restore.deepCompressRestore) return restore;
  restore.deepCompressRestore = false;
  const summaryPath = path.join(os.homedir(), '.agent', 'prompts', 'summary.md');
  try {
    if (restore.deepCompressOriginal !== null) {
      fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
      fs.writeFileSync(summaryPath, restore.deepCompressOriginal, 'utf-8');
    } else {
      // 原本没有自定义模板 → 删除临时文件，回退到内置默认
      try { fs.unlinkSync(summaryPath); } catch {}
    }
  } catch {
    // 恢复失败不阻塞主流程
  }
  restore.deepCompressOriginal = null;
  return restore;
}
