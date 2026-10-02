#!/usr/bin/env node
/**
 * cache-trace.mjs —— 段级指纹分析（2026-10-02）
 *
 * 回答的问题：**上下文缓存为什么掉？是哪一段在变？**
 *
 * 背景：当前 provider 走 auto-prefix（零缓存断点）⇒ 判据只有一条 ——「最早变化的字节在哪」。
 * 于是 composer 每轮给每个上下文段算「内容 hash ＋ token 数」，落盘到会话目录的
 * `cache-trace.jsonl`（受 `logging.logCacheHits` 控制）。本脚本读它，做两件事：
 *   ① 逐轮列出「与上一轮相比，哪几段变了」；
 *   ② 按段统计「窗口内变化了几次」⇒ **每轮都变的那一段就是头号嫌疑**。
 *
 * 用法：
 *   node scripts/cache-trace.mjs                 # 最近的会话、最近 12 轮
 *   node scripts/cache-trace.mjs <sessionDir> [N]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRACE_FILE = 'cache-trace.jsonl';

/** 找最近写过的会话目录（含 cache-trace.jsonl 的才算） */
function findLatestSessionDir() {
  const roots = [
    path.join(os.homedir(), '.agent', 'sessions'),
  ];
  let best = null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // 会话目录形如 sessions/<type>/<sessionId>/
    for (const type of fs.readdirSync(root)) {
      const typeDir = path.join(root, type);
      if (!fs.statSync(typeDir).isDirectory()) continue;
      for (const sid of fs.readdirSync(typeDir)) {
        const dir = path.join(typeDir, sid);
        const trace = path.join(dir, TRACE_FILE);
        if (!fs.existsSync(trace)) continue;
        const m = fs.statSync(trace).mtimeMs;
        if (!best || m > best.m) best = { dir, m };
      }
    }
  }
  return best?.dir ?? null;
}

function readTurns(tracePath) {
  const raw = fs.readFileSync(tracePath, 'utf-8');
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 半行/损坏行跳过（追加写入时可能被中断）
    }
  }
  return out;
}

const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const timeOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts).slice(11, 19) : d.toTimeString().slice(0, 8);
};

const args = process.argv.slice(2);
const sessionDir = args[0] && !/^\d+$/.test(args[0]) ? args[0] : findLatestSessionDir();
const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 12);

if (!sessionDir) {
  console.error('未找到带 cache-trace.jsonl 的会话目录。');
  console.error('提示：先开启 logging.logCacheHits 并跑过至少两轮，记录才会产生。');
  process.exit(1);
}

const tracePath = path.join(sessionDir, TRACE_FILE);
if (!fs.existsSync(tracePath)) {
  console.error(`该会话没有 ${TRACE_FILE}：${tracePath}`);
  process.exit(1);
}

const all = readTurns(tracePath);
if (all.length === 0) {
  console.error('记录为空。');
  process.exit(1);
}

const turns = all.slice(-limit);
console.log(`会话：${sessionDir}`);
console.log(`记录：共 ${all.length} 轮，展示最近 ${turns.length} 轮\n`);

// ── ① 逐轮：与上一轮相比哪几段变了 ─────────────────────────────
console.log('【逐轮变化】★ = 该段 hash 与上一轮不同');
console.log('时间      总量     变化的段');
console.log('─'.repeat(78));

const changeCount = new Map(); // section → 变化次数
const seenRounds = new Map(); // section → 出现的轮数
let prev = null;

for (const t of turns) {
  const cur = new Map((t.sections ?? []).map((s) => [s.name, s]));
  for (const [name] of cur) seenRounds.set(name, (seenRounds.get(name) ?? 0) + 1);

  let changed = [];
  if (prev) {
    for (const [name, s] of cur) {
      const p = prev.get(name);
      if (!p || p.hash !== s.hash) {
        changed.push(s);
        changeCount.set(name, (changeCount.get(name) ?? 0) + 1);
      }
    }
    for (const [name] of prev) {
      if (!cur.has(name)) changed.push({ name: `${name}(消失)`, tokens: 0 });
    }
  }

  const label = prev
    ? changed.length === 0
      ? '（无变化）'
      : changed
          .map((s) => {
            const p = prev.get(s.name);
            const delta = p ? s.tokens - p.tokens : undefined;
            const d = delta === undefined || delta === 0 ? '' : `(${delta > 0 ? '+' : ''}${kfmt(delta)})`;
            return `★${s.name}${d}`;
          })
          .join(' ')
    : '（首轮，无对照）';

  console.log(`${timeOf(t.ts)}  ${String(kfmt(t.total)).padStart(7)}  ${label}`);
  prev = cur;
}

// ── ② 按段统计：谁是惯犯 ──────────────────────────────────────
console.log('\n【段稳定性】（窗口内 hash 变化次数 / 出现轮数）');
console.log('─'.repeat(78));

const rows = [...seenRounds.entries()]
  .map(([name, rounds]) => ({ name, rounds, changes: changeCount.get(name) ?? 0 }))
  .sort((a, b) => b.changes - a.changes || b.rounds - a.rounds);

const latest = turns.at(-1)?.sections ?? [];
const tokensOf = new Map(latest.map((s) => [s.name, s.tokens]));

for (const r of rows) {
  const ratio = r.rounds > 1 ? `${r.changes}/${r.rounds - 1}` : `-/${r.rounds}`;
  const flag = r.rounds > 1 && r.changes === r.rounds - 1 ? '  ← 每轮都变，头号嫌疑' : '';
  const tok = tokensOf.has(r.name) ? kfmt(tokensOf.get(r.name)) : '-';
  console.log(`${r.name.padEnd(24)} 变化 ${ratio.padStart(7)}  近期 ${tok.padStart(7)} tokens${flag}`);
}

console.log('\n判读：命中的缓存要求「从头开始连续相同」。所以即使只有一段每轮都变，');
console.log('      它**之后**的所有段都会一起作废 —— 看变化段在顺序里的位置比看数量更重要。');
