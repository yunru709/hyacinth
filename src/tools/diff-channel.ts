/**
 * 共享 Diff 通道 — edit/write 工具计算 diff 后写入，executor 读取并通知 UI
 * 按 filePath 索引，executor 从 tool args 中获取 filePath 查表。
 */
import type { DiffLine } from '../utils/diff.js';

interface DiffEntry { filePath: string; lines: DiffLine[] }
const channel = new Map<string, DiffEntry>();

export function pushDiff(filePath: string, lines: DiffLine[]): void {
  channel.set(filePath, { filePath: path.normalize(filePath), lines });
}

export function popDiff(filePath: string): DiffEntry | undefined {
  const key = path.normalize(filePath);
  const d = channel.get(key);
  if (d) channel.delete(key);
  return d;
}

import path from 'node:path';
