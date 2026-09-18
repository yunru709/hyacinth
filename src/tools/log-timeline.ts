import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Tool } from './interface.js';

/**
 * LogTimelineTool — 日志「时间轴 / 聚合」分析（流式，只回聚合不回原文）
 *
 * 为什么需要它（本会话的真实痛点，且不止一次）：
 *   - 我反复手搓 node 脚本去扫 jsonl 日志；
 *   - `grep` 在 >1MB 的 jsonl 上**静默漏报**（本仓库记忆里专门记过这条）；
 *   - 原始日志直接读会把上下文冲爆，而我要的其实只是
 *     "什么事件、多少次、什么时候、**中间断了多久**"。
 *
 * 真实日志形态（**实机采样得出，不是猜的**）：
 *   ~/.agent/tui.log      : {"ts":"…","lvl":"info","mod":"factory","msg":"…","ctx":{…}}
 *   sessions/⟨session⟩/events.jsonl : {"type":"session_start","timestamp":"…"}
 *   （上面第二行的路径原写作 sessions 斜杠星号斜杠 events.jsonl，结果那个 "星号斜杠"
 *     提前终止了本块注释、把后面的说明变成了代码 —— 测试一跑就 PARSE_ERROR。
 *     在此记一笔：**注释里不能出现闭注释符号**，哪怕它属于一个 glob 路径。）
 *   两者都**混有非 JSON 行**（如 `[clawbot] poll error: …`），故必须同时处理两种行。
 *   实测最大的日志 30MB+，因此**必须流式**、聚合量必须有界。
 *
 * 设计取舍：只输出**聚合结果**（计数 / 直方图 / 空档 / 首次出现），
 * 原始行默认不吐（需要时用 `samples` 少量取样）。聚合状态全部有界：
 * 直方图按桶、事件按 Top N、空档只记相邻时间差、首次出现按去重事件名。
 */
export class LogTimelineTool implements Tool {
  readonly name = 'log_timeline';
  readonly sideEffect = 'read' as const;
  readonly description =
    '把日志（jsonl 或纯文本，可混排）压成**时间轴与聚合**：按 level / 事件计数、时间直方图、时间空档（gaps）、首次出现。' +
    '流式处理、聚合有界，适合几 MB 到几十 MB 的日志；只回聚合不回原文（可用 samples 少量取样）。' +
    '时间/级别/事件字段可从常见键名自动探测（ts / timestamp / lvl / level / type / msg …），也可显式指定。';
  readonly companionDescription = '这堆日志里都发生了啥？';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Log file, or a directory (recursively collects *.log / *.jsonl, capped).' },
      time_field: { type: 'string', description: 'Field holding the timestamp. Auto-detected by default (ts/timestamp/time/created_at/@timestamp).' },
      level_field: { type: 'string', description: 'Field holding the severity. Auto-detected (lvl/level/severity).' },
      event_field: { type: 'string', description: 'Field used as the event name. Auto-detected (type/msg/message/event/name); plain lines fall back to message templates.' },
      last: { type: 'string', description: 'Only consider the last N of the log, e.g. "30m", "2h", "1d". Applied relative to the newest entry.' },
      filter: { type: 'string', description: 'Keep only lines containing this substring (or /regex/ when wrapped in slashes).' },
      bucket: { type: 'string', description: 'Histogram bucket, e.g. "1m", "1h". Auto-chosen from the time span by default.' },
      gap_threshold: { type: 'string', description: 'Report gaps longer than this, e.g. "5m". Defaults to ~8x the bucket.' },
      top: { type: 'number', description: 'How many event names to list. Default 15.' },
      samples: { type: 'number', description: 'Attach up to N sample lines per listed event. Default 0 (off).' },
      max_lines: { type: 'number', description: 'Safety cap on parsed lines. Default 2000000.' },
    },
    required: ['path'],
  };

  private static readonly TIME_KEYS = ['ts', 'timestamp', 'time', '@timestamp', 'created_at', 'datetime', 'date'];
  private static readonly LEVEL_KEYS = ['lvl', 'level', 'severity'];
  private static readonly EVENT_KEYS = ['type', 'msg', 'message', 'event', 'name'];

  async execute(args: Record<string, unknown>): Promise<string> {
    const target = args.path as string;
    if (!target) return 'Error: path is required.';

    const files = collectFiles(target);
    if (files.length === 0) return `Error: no log files found at ${target}`;

    const maxLines = Math.max(1000, (args.max_lines as number) ?? 2_000_000);
    const top = Math.max(1, (args.top as number) ?? 15);
    const samples = Math.max(0, (args.samples as number) ?? 0);
    const filter = args.filter as string | undefined;
    const filterRe = filter && /^\/.*\/$/.test(filter) ? safeRegex(filter.slice(1, -1)) : null;
    const filterSub = filter && !filterRe ? filter : null;
    const lastMs = args.last ? parseDuration(args.last as string) : null;

    // ── 聚合状态（全部有界）──
    const ticks: number[] = [];                 // 时间戳（用于直方图/空档/范围）
    const levelCount = new Map<string, number>();
    const eventCount = new Map<string, number>();
    const firstSeen = new Map<string, number>();
    const eventSamples = new Map<string, string[]>();
    let jsonLines = 0;
    let plainLines = 0;
    let noTimeLines = 0;
    let filteredOut = 0;
    let truncated = false;

    // 自动探测字段（用首批样本决定，探测到即固定）
    let timeField = (args.time_field as string) || '';
    let levelField = (args.level_field as string) || '';
    let eventField = (args.event_field as string) || '';
    let probed = false;

    let total = 0;
    for (const file of files) {
      if (total >= maxLines) { truncated = true; break; }
      const rl = createInterface({ input: createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
      for await (const line of rl) {
        total++;
        if (total > maxLines) { truncated = true; break; }
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (filterSub && !trimmed.includes(filterSub)) { filteredOut++; continue; }
        if (filterRe && !filterRe.test(trimmed)) { filteredOut++; continue; }

        let obj: Record<string, unknown> | null = null;
        if (trimmed.startsWith('{')) {
          try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { obj = null; }
        }

        if (obj) {
          jsonLines++;
          if (!probed) {
            timeField = timeField || pickKey(obj, LogTimelineTool.TIME_KEYS);
            levelField = levelField || pickKey(obj, LogTimelineTool.LEVEL_KEYS);
            eventField = eventField || pickKey(obj, LogTimelineTool.EVENT_KEYS);
            probed = true;
          }
          const ts = timeField ? toMs(obj[timeField]) : null;
          if (ts !== null) ticks.push(ts); else noTimeLines++;
          const lvl = levelField ? String(obj[levelField] ?? '') : '';
          if (lvl) levelCount.set(lvl, (levelCount.get(lvl) ?? 0) + 1);
          const ev = eventField ? String(obj[eventField] ?? '(no event)') : '(no event)';
          bump(eventCount, ev);
          if (ts !== null && !firstSeen.has(ev)) firstSeen.set(ev, ts);
          if (samples > 0) pushSample(eventSamples, ev, trimmed, samples);
        } else {
          plainLines++;
          const { ts, rest } = splitLeadingTimestamp(trimmed);
          if (ts !== null) ticks.push(ts); else noTimeLines++;
          const tpl = templatize(rest);
          bump(eventCount, tpl);
          if (ts !== null && !firstSeen.has(tpl)) firstSeen.set(tpl, ts);
          if (samples > 0) pushSample(eventSamples, tpl, trimmed, samples);
        }
      }
      rl.close();
    }

    if (ticks.length === 0 && eventCount.size === 0) {
      return `[log_timeline] ${target}\nparsed ${total} line(s) but nothing usable was found (no timestamps, no events).`;
    }

    ticks.sort((a, b) => a - b);
    const span = ticks.length > 1 ? ticks[ticks.length - 1]! - ticks[0]! : 0;
    const cutoff = lastMs !== null && ticks.length > 0 ? ticks[ticks.length - 1]! - lastMs : null;

    // 直方图（桶大小：显式 > 自动）；桶数目标 ~40
    const bucketMs = args.bucket ? parseDuration(args.bucket as string) : autoBucket(span);
    const histogram = new Map<number, number>();
    for (const t of ticks) {
      if (cutoff !== null && t < cutoff) continue;
      const b = Math.floor(t / bucketMs) * bucketMs;
      histogram.set(b, (histogram.get(b) ?? 0) + 1);
    }

    // 空档：只看相邻时间差（状态有界）
    const gapThreshold = args.gap_threshold ? parseDuration(args.gap_threshold as string) : bucketMs * 8;
    const gaps: Array<{ from: number; to: number; delta: number }> = [];
    for (let i = 1; i < ticks.length; i++) {
      const d = ticks[i]! - ticks[i - 1]!;
      if (d >= gapThreshold) gaps.push({ from: ticks[i - 1]!, to: ticks[i]!, delta: d });
    }

    // ── 输出 ──
    const totalBytes = files.reduce((s, f) => s + (fs.statSync(f).size || 0), 0);
    const out: string[] = [
      `[log_timeline] ${target}`,
      `files: ${files.length} (${fmtBytes(totalBytes)})${files.length === 1 ? ` — ${files[0]}` : ''}`,
      `lines: ${total} parsed (json ${jsonLines} / plain ${plainLines}; no usable timestamp ${noTimeLines})`
        + (filteredOut > 0 ? ` | filtered out ${filteredOut}` : '')
        + (truncated ? ` | STOPPED at max_lines=${maxLines}` : ''),
      `fields: time=${timeField || '(none)'} event=${eventField || '(template)'} level=${levelField || '(none)'}`,
    ];
    if (ticks.length > 0) {
      out.push(`range: ${iso(ticks[0]!)} → ${iso(ticks[ticks.length - 1]!)}  (${fmtDur(span)})`
        + (cutoff !== null ? `  [filtered to last ${fmtDur(lastMs!)}]` : ''));
    }

    if (levelCount.size > 0) {
      out.push('', 'by level:');
      for (const [k, v] of [...levelCount.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`  ${String(v).padStart(8)}  ${k}`);
      }
    }

    out.push('', `top events (${Math.min(top, eventCount.size)} of ${eventCount.size}):`);
    const ranked = [...eventCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    for (const [name, n] of ranked) {
      const fs0 = firstSeen.get(name);
      const when = fs0 !== undefined ? `  first ${iso(fs0)}` : '';
      out.push(`  ${String(n).padStart(8)}  ${truncate(name, 90)}${when}`);
      if (samples > 0) {
        for (const s of eventSamples.get(name) ?? []) out.push(`              ${truncate(s, 140)}`);
      }
    }

    if (histogram.size > 0 && cutoff === null) {
      const bars = [...histogram.entries()].sort((a, b) => a[0] - b[0]);
      const maxN = Math.max(...bars.map(([, n]) => n));
      const width = bucketMs >= 86_400_000 ? 10 : 16;
      out.push('', `timeline (bucket ${fmtDur(bucketMs)}, ${bars.length} buckets, peak ${maxN}):`);
      for (const [b, n] of bars) {
        const len = maxN === 0 ? 0 : Math.max(1, Math.round((n / maxN) * 24));
        out.push(`  ${ts(b, width)}  ${'█'.repeat(len)} ${n}`);
      }
    } else if (histogram.size > 0) {
      const total2 = [...histogram.values()].reduce((a, b) => a + b, 0);
      out.push('', `timeline: ${histogram.size} non-empty bucket(s) in window, ${total2} entries (skipped in "last" mode)`);
    }

    if (gaps.length > 0) {
      out.push('', `gaps ≥ ${fmtDur(gapThreshold)} (${gaps.length}):`);
      for (const g of gaps.slice(0, 12)) {
        out.push(`  ${iso(g.from)} → ${iso(g.to)}   ${fmtDur(g.delta)}`);
      }
      if (gaps.length > 12) out.push(`  ... (+${gaps.length - 12} more)`);
    } else {
      out.push('', `gaps ≥ ${fmtDur(gapThreshold)}: none`);
    }

    return out.join('\n');
  }
}

// ── 采集与解析 ────────────────────────────────────────────────

const LOG_EXTS = new Set(['.log', '.jsonl', '.ndjson', '.txt']);
const MAX_FILES = 20;

/** 文件 → [file]；目录 → 递归收集日志后缀文件（上限 MAX_FILES，按路径排序保证确定性） */
function collectFiles(target: string): string[] {
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { return []; }
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    if (found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_FILES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
      else if (LOG_EXTS.has(path.extname(e.name).toLowerCase())) found.push(p);
    }
  };
  walk(target);
  return found;
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function pushSample(m: Map<string, string[]>, k: string, line: string, cap: number): void {
  const arr = m.get(k);
  if (!arr) { m.set(k, [line]); return; }
  if (arr.length < cap) arr.push(line);
}

/** 从对象里挑第一个存在的候选键 */
function pickKey(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (k in obj) return k;
  return '';
}

/** 值 → epoch ms（支持 ISO 字符串与数字） */
function toMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? (v > 1e12 ? v : v * 1000) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(s)) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** 纯文本行：切出前导时间戳（ISO8601 或 `YYYY-MM-DD HH:mm:ss`） */
function splitLeadingTimestamp(line: string): { ts: number | null; rest: string } {
  const m = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/.exec(line);
  if (!m) return { ts: null, rest: line };
  const isoish = m[1]!.replace(' ', 'T').replace(',', '.');
  const t = Date.parse(isoish);
  return { ts: Number.isFinite(t) ? t : null, rest: line.slice(m[0].length) };
}

/** 把消息压成模板：数字/十六进制/UUID/引号内容 → 占位符，便于同类聚合 */
function templatize(msg: string): string {
  const t = msg
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<uuid>')
    .replace(/\b0x[0-9a-fA-F]+\b/g, '<hex>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/'[^']*'/g, "'<s>'")
    .replace(/"[^"]*"/g, '"<s>"')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, 120) || '(empty line)';
}

// ── 时间工具 ─────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

/** '30m' / '2h' / '1d' / '90s' → ms */
function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(s.trim());
  if (!m) return 60_000;
  return Number(m[1]) * (UNITS[m[2]!.toLowerCase()] ?? 60_000);
}

/** 按时间跨度自动选桶：目标约 40 个桶，取值吸附到"整齐"的档位 */
function autoBucket(spanMs: number): number {
  if (spanMs <= 0) return 60_000;
  const raw = spanMs / 40;
  const steps = [1_000, 5_000, 15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
    3_600_000, 6 * 3_600_000, 86_400_000];
  for (const s of steps) if (raw <= s) return s;
  return steps[steps.length - 1]!;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function ts(ms: number, width: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getUTCMonth() + 1}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return s.padEnd(width);
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function safeRegex(src: string): RegExp | null {
  try { return new RegExp(src); } catch { return null; }
}
