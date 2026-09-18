/**
 * file-tracker — 追踪文件读写时间，支撑 read-before-write 门控。
 *
 * 全局 in-memory 记录表：
 *   - recordFileRead(path)     — read 工具（或 write 交出了全文）后调用：**完整**读过
 *   - recordPartialRead(path)  — 拒绝写入时只交出了部分内容（片段/头尾）：**部分**见过
 *   - recordFileWrite(path)    — write/edit 修改文件后调用
 *   - getLastReadTime(path)    — 上次**完整**读取时间，null = 从未完整读过
 *   - getAnyReadTime(path)     — 完整或部分（取较晚者）
 *
 * write/edit/multi_edit 在修改文件前检查：
 *   1. 文件存在但从未被 read → 拒绝（幻觉编辑）
 *   2. 文件在读取后被外部修改过 → 拒绝（过期数据编辑）
 *   3. 文件不存在 → 放行（新建文件无需读取）
 *
 * ── 为什么要有"两级"（2026-09-19 立）──────────────────────────
 * 拒绝写入时不再只回一句错误，而是**顺手把内容给出去**（把惩罚变成教学 + 给料，
 * 少一轮往返）。但"给了多少"决定了"能放行多少"：
 *
 *   - **`write`（整份覆盖）**：只有**交出全文**才算读过。只给片段就放行，模型会拿着
 *     一份没看过中段的印象去覆盖整份文件 → **静默丢内容**。浪费一轮远比丢内容便宜。
 *   - **`edit` / `multi_edit`（锚定替换）**：给出 `old_string` 命中处上下文即足够 ——
 *     改动只落在匹配处，不存在"没看到的中段被写没"的风险。
 *   - **`insert`（按行插入）**：本身不覆盖任何内容，故**没有本门控**（只受工作区围栏约束）。
 *
 * 一句话原则：**交出了多少，才允许它往下走多少。**
 */

import path from 'node:path';

interface FileRecord {
  readTime: number;   // 完整读过（read 工具 / write 交出全文）
  writeTime: number;  // Date.now()
}

const records = new Map<string, FileRecord>();
/** 只交出过部分内容的记录（不满足 write 的门控） */
const partialReads = new Map<string, number>();

/** 规范化路径为绝对路径，Windows 上统一盘符大小写 */
function normalize(p: string): string {
  const resolved = path.resolve(p);
  // Windows: 盘符统一大写，避免 c:\foo 和 C:\foo 被当成两个 key
  if (process.platform === 'win32' && resolved.length >= 2 && resolved[1] === ':') {
    return resolved[0].toUpperCase() + resolved.slice(1);
  }
  return resolved;
}

/** 记录文件被**完整**读取（read 工具、或 write 拒绝时交出了全文）*/
export function recordFileRead(filePath: string): void {
  const key = normalize(filePath);
  const existing = records.get(key);
  const now = Date.now();
  records.set(key, { readTime: now, writeTime: existing?.writeTime ?? 0 });
  partialReads.delete(key); // 完整读过即覆盖"部分"标记
}

/** 记录只交出过**部分**内容（片段/头尾）。仅满足 edit/multi_edit，不满足 write */
export function recordPartialRead(filePath: string): void {
  const key = normalize(filePath);
  // 若已完整读过，不降级
  if (records.has(key)) return;
  partialReads.set(key, Date.now());
}

/** 获取文件上次被本进程**完整**读取的时间。null = 从未完整读取 */
export function getLastReadTime(filePath: string): number | null {
  const key = normalize(filePath);
  const record = records.get(key);
  return record ? record.readTime : null;
}

/** 获取"完整或部分"见过的较晚时间。null = 从未见过 */
export function getAnyReadTime(filePath: string): number | null {
  const key = normalize(filePath);
  const full = records.get(key)?.readTime ?? null;
  const part = partialReads.get(key) ?? null;
  if (full === null) return part;
  if (part === null) return full;
  return Math.max(full, part);
}

/** 记录文件被写入（写入后自动更新 readTime，等同于完整读过）*/
export function recordFileWrite(filePath: string): void {
  const key = normalize(filePath);
  const now = Date.now();
  records.set(key, { readTime: now, writeTime: now });
  partialReads.delete(key);
}
