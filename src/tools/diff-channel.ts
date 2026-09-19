/**
 * 共享 Diff 通道 — edit/write 工具计算 diff 后写入，executor 读取并通知 UI
 * 按 filePath 索引
 */
import path from 'node:path';
import type { DiffLine } from '../utils/diff.js';

interface DiffEntry {
  filePath: string;
  lines: DiffLine[];
  /** 改动前的文件全文（**结构事实**，供后置消费者推导语义；UI 消费者忽略它） */
  before?: string;
  /** 改动后的文件全文 */
  after?: string;
}
const channel = new Map<string, DiffEntry>();

/**
 * 写入 diff 账本。
 *
 * `texts` 是**结构事实**：工具在写出前手上有改动前后全文，记进来最省事；
 * 不记的话，后置消费者（引用自检）只能去反推 —— 而那时磁盘上已是新内容，推不出来。
 * 这与联动三律第 2 条一致：**工具记结构事实，语义推导归消费者**。
 */
export function pushDiff(filePath: string, lines: DiffLine[], texts?: { before: string; after: string }): void {
  channel.set(path.normalize(filePath), { filePath, lines, ...(texts ?? {}) });
}

/**
 * 读而不删 —— 供**多个**消费者共用一条结构事实（UI 通知 + 引用自检）。
 *
 * 为什么需要（2026-09-19 P0 教训）：本账本原先只有 popDiff（读即消费）⇒
 * inline 路径的 UI 通知先 pop 掉 ⇒ 引用自检再也拿不到 ⇒ 功能在**真实 provider 的常态路径**上不触发 ✗。
 * 结构事实账本的语义应是"事实可被多个消费者读"，故补 peek；**消费仍需显式 pop 一次**（每路径在末尾）。
 */
export function peekDiff(filePath: string): DiffEntry | undefined {
  return channel.get(path.normalize(filePath));
}

export function popDiff(filePath: string): DiffEntry | undefined {
  const key = path.normalize(filePath);
  const d = channel.get(key);
  if (d) channel.delete(key);
  return d;
}
