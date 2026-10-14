#!/usr/bin/env node
/**
 * cache-hits.mjs —— 命中率时间线 × 段级漂移对齐（2026-10-14）
 *
 * 回答的问题：**TUI 上看到的命中率，为什么掉到 0？是哪一段在变？**
 *
 * 数据来源（两者都在会话目录里、默认始终落盘）：
 *   - `events.jsonl`      → 每次 LLM 调用的 cache_hit_rate / hit / miss / turn
 *   - `cache-trace.jsonl` → 每次 compose 的段级指纹（哪一段内容 hash 变了）
 *
 * 为什么能对齐：compose 发生在 LLM 调用**之前**，故对每次调用取「时间上最近的
 * 那一次 compose」，其"相对上一次 compose 的段变化"就是这一轮命中率变化的根因证据。
 *
 * 用法：
 *   node scripts/cache-hits.mjs                 # 最近会话，最近 20 次调用
 *   node scripts/cache-hits.mjs <sessionDir> [N]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE_FILE = 'events.jsonl';
const TRACE_FILE = 'cache-trace.jsonl';

/** 取最近写过的会话目录（以 events.jsonl 的 mtime 为准） */
function findLatestSessionDir() {
  const root = path.join(os.homedir(), '.agent', 'sessions');
  if (!fs.existsSync(root)) return null;
  let best = null;
  for (const type of fs.readdirSync(root)) {
    const typeDir = path.join(root, type);
    if (!fs.statSync(typeDir).isDirectory()) continue;
    for (const sid of fs.readdirSync(typeDir)) {
      const dir = path.join(typeDir, sid);
      const f = path.join(dir, USAGE_FILE);
      if (!fs.existsSync(f)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { dir, m };
    }
  }
  return best?.dir ?? null;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* 半行（写入竞态）忽略 */
    }
  }
  return out;
}

/** 相对前一条 trace 的段变化（name 列表；后缀标注 新/消失） */
function computeDeltas(traces) {
  return traces.map((t, i) => {
    if (i === 0) return [];
    const prev = new Map((traces[i - 1].sections ?? []).map((s) => [s.name, s.hash]));
    const cur = new Map((t.sections ?? []).map((s) => [s.name, s.hash]));
    const changed = [];
    for (const [n, h] of cur) {
      const ph = prev.get(n);
      if (ph === undefined) changed.push(`${n}(新)`);
      else if (ph !== h) changed.push(n);
    }
    for (const n of prev.keys()) if (!cur.has(n)) changed.push(`${n}(消失)`);
    return changed;
  });
}

const argDir = process.argv[2];
const limit = Number(process.argv[3] ?? 20) || 20;
const sessionDir = argDir ? path.resolve(argDir) : findLatestSessionDir();

if (!sessionDir || !fs.existsSync(sessionDir)) {
  console.error('找不到会话目录。用法: node scripts/cache-hits.mjs <sessionDir> [N]');
  process.exit(1);
}

const usage = readJsonl(path.join(sessionDir, USAGE_FILE)).filter((e) => e.type === 'usage');
const traces = readJsonl(path.join(sessionDir, TRACE_FILE));
const deltas = computeDeltas(traces);

console.log(`会话: ${sessionDir}`);
console.log(`usage 事件 ${usage.length} 条 · cache-trace ${traces.length} 条\n`);

const withCache = usage.filter((e) => typeof e.cache_hit_rate === 'number');
if (withCache.length === 0) {
  console.log('⚠️  没有任何 usage 事件带 cache_hit_rate —— 说明这是**旧版写的** events.jsonl');
  console.log('   （留痕改动之前落盘的）。重启进程并跑几轮后才有数据。\n');
}

// ── 时间戳可解析性（不可解析则放弃对齐，明说而不是瞎配） ──
const usageTs = usage.map((e) => Date.parse(e.timestamp));
const traceTs = traces.map((t) => Date.parse(t.ts));
const canAlign =
  usageTs.every((n) => !Number.isNaN(n)) &&
  traceTs.every((n) => !Number.isNaN(n)) &&
  traces.length > 0;

/** 每次调用 → 时间上最近（at-or-before）的 trace 下标 */
function traceIdxFor(ts) {
  if (!canAlign) return -1;
  let idx = -1;
  for (let i = 0; i < traceTs.length; i++) {
    if (traceTs[i] <= ts) idx = i;
    else break;
  }
  return idx;
}

// ── 时间线 ──
const win = usage.slice(-limit);
console.log(`── 命中率时间线（最近 ${win.length} 次 LLM 调用）──`);
console.log('turn  时间                 命中率     hit / miss          input      cc   本段变化');
let dropCount = 0;
const offender = new Map();

/** 该 trace 相对上一条是否发生了压缩（compressCount 增长）—— 压缩必然重写历史 ⇒ 必然 miss */
function isCompressRound(i) {
  if (i <= 0) return false;
  const a = traces[i - 1]?.compressCount;
  const b = traces[i]?.compressCount;
  return typeof a === 'number' && typeof b === 'number' && b > a;
}

for (const e of usage.slice(-limit)) {
  const ts = Date.parse(e.timestamp);
  const idx = traceIdxFor(ts);
  const changed = idx >= 0 ? deltas[idx] : [];
  for (const n of changed) offender.set(n, (offender.get(n) ?? 0) + 1);

  const rate = typeof e.cache_hit_rate === 'number' ? e.cache_hit_rate : null;
  const isDrop = rate !== null && rate <= 1;
  if (isDrop) dropCount++;

  const rateStr = rate === null ? '  n/a  ' : `${rate.toFixed(1).padStart(5)}%`;
  const hm =
    typeof e.cache_hit_tokens === 'number'
      ? `${e.cache_hit_tokens} / ${e.cache_miss_tokens}`
      : '（无缓存字段）';
  const timeStr = Number.isNaN(ts) ? String(e.timestamp ?? '') : new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const changeStr = changed.length ? changed.join(', ') : '—';
  const cc = idx >= 0 && typeof traces[idx]?.compressCount === 'number' ? traces[idx].compressCount : '?';
  const cmark = idx >= 0 && isCompressRound(idx) ? '  [压缩轮·必然成本]' : '';
  // 段外指纹：tools 数组 / 整条 prompt —— 它们不属于任何 zone，段级变化列**看不到**，
  // 但排在请求最前 ⇒ 一变则整条前缀作废（现象＝命中率掉到 0）。
  const extra = [];
  if (idx > 0) {
    const p = traces[idx - 1];
    const c = traces[idx];
    if (p?.toolsHash && c?.toolsHash && p.toolsHash !== c.toolsHash) extra.push('tools变了');
    if (p?.promptHash && c?.promptHash && p.promptHash !== c.promptHash) extra.push('prompt变了');
  }

  console.log(
    `${String(e.turn ?? '?').padStart(4)}  ${timeStr.padEnd(19)} ${rateStr}  ${String(hm).padEnd(18)} ${String(e.input_tokens ?? '').padStart(8)}  ${String(cc).padStart(4)}  ${changeStr}${extra.length ? '  ' + extra.join(',') : ''}${isDrop ? '  ⚠️ 掉到 0' : ''}${cmark}`,
  );
}

// ── 汇总 ──
let hit = 0;
let total = 0;
for (const e of withCache) {
  hit += e.cache_hit_tokens ?? 0;
  total += (e.cache_hit_tokens ?? 0) + (e.cache_miss_tokens ?? 0);
}
console.log('\n── 汇总 ──');
console.log(
  `加权平均命中率: ${total > 0 ? ((hit / total) * 100).toFixed(1) : 'n/a'}%  （${hit} / ${total}）`,
);
console.log(`掉到 ≤1% 的调用: ${dropCount} 次`);
console.log(
  `带缓存字段的调用: ${withCache.length} / ${usage.length}${withCache.length < usage.length ? '（其余为厂商未返回缓存字段）' : ''}`,
);

if (offender.size > 0) {
  console.log('\n── 段级"惯犯"（窗口内变化次数，头号嫌疑）──');
  [...offender.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([n, c]) => console.log(`  ${String(c).padStart(3)}×  ${n}`));
}

if (!canAlign) {
  console.log(
    '\n提示: 无法按时间对齐 cache-trace（时间戳缺失或该文件不存在）⇒ 上面"本段变化"列不可用。',
  );
}
