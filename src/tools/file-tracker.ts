/**
 * file-tracker — 追踪文件读写时间，支撑 read-before-write 门控。
 *
 * 全局 in-memory 记录表：
 *   - recordFileRead(path)    — read 工具读取文件后调用
 *   - recordFileWrite(path)   — write/edit 修改文件后调用
 *   - getLastReadTime(path)   — 获取上次读取时间，null = 从未读取
 *
 * write/edit/multi_edit 在修改文件前检查：
 *   1. 文件存在但从未被 read → 拒绝（幻觉编辑）
 *   2. 文件在读取后被外部修改过 → 拒绝（过期数据编辑）
 *   3. 文件不存在 → 放行（新建文件无需读取）
 */

import path from 'node:path';

interface FileRecord {
  readTime: number;   // Date.now()
  writeTime: number;  // Date.now()
}

const records = new Map<string, FileRecord>();

/** 规范化路径为绝对路径，Windows 上统一盘符大小写 */
function normalize(p: string): string {
  const resolved = path.resolve(p);
  // Windows: 盘符统一大写，避免 c:\foo 和 C:\foo 被当成两个 key
  if (process.platform === 'win32' && resolved.length >= 2 && resolved[1] === ':') {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

/** 记录文件被读取 */
export function recordFileRead(filePath: string): void {
  const key = normalize(filePath);
  const existing = records.get(key);
  const now = Date.now();
  records.set(key, { readTime: now, writeTime: existing?.writeTime ?? 0 });
}

/** 获取文件上次被本进程读取的时间。null = 从未读取 */
export function getLastReadTime(filePath: string): number | null {
  const key = normalize(filePath);
  const record = records.get(key);
  return record ? record.readTime : null;
}

/** 记录文件被写入（写入后自动更新 readTime，等同于 read 过） */
export function recordFileWrite(filePath: string): void {
  const key = normalize(filePath);
  const now = Date.now();
  records.set(key, { readTime: now, writeTime: now });
}
