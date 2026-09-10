/**
 * 会话分支（A7，DSH 投影式回退）—— materializeFork。
 *
 * 从源会话的「全量存档」（conversation_full.jsonl，真 append-only、行号稳定）取前
 * keepMessages 条，剥离 _compressed / _cluster_id 标记（它们是相对旧簇状态的压缩产物，
 * 在新会话中应还原为原始消息），一次性写入目标会话目录。
 *
 * 语义：回滚从"文件层"（git 逐回合回滚）升到"完整状态层"——失败的决策点之后
 * 的所有内容都被丢弃，agent 可以从干净的原始上下文重新开始。纯读取源 + 一次性
 * 写入目标，不破坏源会话（可反复 fork 不同的决策点）。
 *
 * 数据模型前提（已验证）：
 * - conversation_full.jsonl 只追加、不删行，行号稳定 → 前 N 条就是时间线前 N 条；
 * - 压缩时被压消息的原件带 _compressed 标记写回存档（compressor.ts 决策 C），
 *   剥离标记即还原原始消息；从未压缩的会话没有存档 → 回退读 conversation.jsonl。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ForkResult {
  /** 写入目标会话的消息数 */
  messageCount: number;
  /** 剥离的压缩/簇标记数 */
  droppedMarkers: number;
  /** 源消息总数（存档或工作会话） */
  sourceCount: number;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

/**
 * 从源会话投影前 keepMessages 条消息到目标会话目录。
 * @throws 当 keepMessages 越界或源会话无可读消息时
 */
export async function materializeFork(
  sourceSessionDir: string,
  keepMessages: number,
  targetSessionDir: string,
): Promise<ForkResult> {
  // 优先读全量存档（压缩后的完整时间线）；不存在则回退工作会话
  const fullPath = path.join(sourceSessionDir, 'conversation_full.jsonl');
  let source: Array<Record<string, unknown>>;
  try {
    source = await readJsonl<Record<string, unknown>>(fullPath);
  } catch {
    source = await readJsonl<Record<string, unknown>>(
      path.join(sourceSessionDir, 'conversation.jsonl'),
    );
  }

  if (source.length === 0) {
    throw new Error('源会话没有可分支的消息（conversation_full.jsonl / conversation.jsonl 均为空）');
  }
  if (!Number.isInteger(keepMessages) || keepMessages < 1 || keepMessages > source.length) {
    throw new Error(`keep_messages 越界：可用 1..${source.length}，收到 ${keepMessages}`);
  }

  // 剥离压缩/簇标记，还原为原始消息
  let droppedMarkers = 0;
  const kept = source.slice(0, keepMessages).map((m) => {
    const copy = { ...m };
    if ('_compressed' in copy) { delete copy._compressed; droppedMarkers++; }
    if ('_cluster_id' in copy) { delete copy._cluster_id; droppedMarkers++; }
    return copy;
  });

  await fs.mkdir(targetSessionDir, { recursive: true });
  const content = kept.map((m) => JSON.stringify(m)).join('\n') + '\n';
  // 分支会话的两个文件内容一致：工作会话 = 全量存档 = 回退点之前的原始消息
  await fs.writeFile(path.join(targetSessionDir, 'conversation.jsonl'), content, 'utf-8');
  await fs.writeFile(path.join(targetSessionDir, 'conversation_full.jsonl'), content, 'utf-8');
  await fs.writeFile(path.join(targetSessionDir, 'events.jsonl'), '', 'utf-8');
  await fs.writeFile(path.join(targetSessionDir, 'stats.json'), '{}', 'utf-8');

  return { messageCount: kept.length, droppedMarkers, sourceCount: source.length };
}
