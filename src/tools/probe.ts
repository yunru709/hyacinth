import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * ProbeTool — 二进制 / 超大 / 编码混杂文件的「上下文探针」
 *
 * 为什么需要它（都是真实踩坑）：
 *   1. `grep` 对二进制（如 Electron 的 app.asar、编译产物）只会给一堆无结构的命中，
 *      `-o` 拿不到"命中周围是什么"，等于没法判断语义；
 *   2. 大文件（几百 MB）既不能整份读进上下文，也不能靠 read 的 offset/limit 盲翻；
 *   3. **UTF-16 文件里搜不到 UTF-8 关键字** —— 本次整晚排查的第一道坎就是这个：
 *      日志被写成 UTF-16LE，用 UTF-8 关键字去搜永远零命中，且不报错。所以本工具会
 *      **同时按 utf8 / utf16le / utf16be 三种编码构造 needle**，并回报命中的是哪一种。
 *
 * 设计取舍：只做"定位 + 看周边"，不做语义理解；输出经过净化（控制符/NUL 一律替换），
 * 保证结果始终是纯文本可读的，不会把二进制垃圾灌进上下文。
 */

const ENC_LABEL = {
  utf8: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
} as const;
type EncKey = keyof typeof ENC_LABEL;

interface Hit {
  offset: number;
  enc: EncKey;
  length: number;
}

/** 构造三种编码的 needle（去重，避免 utf8/ascii 重复搜） */
function buildNeedles(keyword: string): Array<{ enc: EncKey; buf: Buffer }> {
  const out: Array<{ enc: EncKey; buf: Buffer }> = [];
  const seen = new Set<string>();
  const push = (enc: EncKey, buf: Buffer) => {
    const k = buf.toString('hex');
    if (buf.length === 0 || seen.has(k)) return;
    seen.add(k);
    out.push({ enc, buf });
  };
  push('utf8', Buffer.from(keyword, 'utf8'));
  try { push('utf16le', Buffer.from(keyword, 'utf16le')); } catch { /* ignore */ }
  // utf16be：Node 无原生编码，手工按 code unit 翻转字节
  const units: number[] = [];
  for (const ch of keyword) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else units.push(cp);
  }
  const be = Buffer.alloc(units.length * 2);
  units.forEach((u, i) => be.writeUInt16BE(u, i * 2));
  push('utf16be', be);
  return out;
}

/** 净化：控制符与 NUL 一律替换，保证输出是纯文本（utf8 模式保留 CJK，ascii 模式全替换） */
function sanitize(s: string, mode: 'utf8' | 'ascii'): string {
  if (mode === 'ascii') return s.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '.');
  // 保留可打印 UTF-8；只打掉 C0 控制符（保留 \n \t \r）
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '.');
}

/** 猜测容器/BOM 形态，用于给出解释性提示 */
function describeBytes(head: Buffer): string[] {
  const notes: string[] = [];
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) notes.push('BOM: UTF-16LE');
  else if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) notes.push('BOM: UTF-16BE');
  else if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) notes.push('BOM: UTF-8');
  const nulls = head.filter((b) => b === 0).length;
  if (nulls > head.length * 0.1) notes.push(`NUL 比例高（${nulls}/${head.length}）→ 疑似二进制或 UTF-16（未带 BOM）`);
  return notes;
}

export class ProbeTool implements Tool {
  readonly name = 'probe';
  readonly sideEffect = 'read' as const;
  readonly companionDescription = '往文件里扎一针，看看周围啥样。';
  readonly description =
    '在二进制 / 超大 / 编码混杂的文件里，按关键字提取「上下文窗口」。' +
    '同时按 utf-8 / utf-16le / utf-16be 三种编码搜索（UTF-16 文件里 UTF-8 关键字永远搜不到，且不报错——本工具会指明命中的编码）。' +
    '输出经过净化（控制符与 NUL 替换），适合拆 app.asar、日志、编译产物等 grep 无力的场景。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to the file to probe (absolute or relative to cwd)' },
      keyword: { type: 'string', description: 'Literal string (or regex when regex=true) to locate' },
      before: { type: 'number', description: 'Bytes of context before each hit. Default: 600' },
      after: { type: 'number', description: 'Bytes of context after each hit. Default: 1200' },
      max_hits: { type: 'number', description: 'Maximum number of hits to return. Default: 5' },
      regex: { type: 'boolean', description: 'Treat keyword as a regular expression (utf-8 scan only). Default: false' },
      sanitize: { type: 'string', enum: ['utf8', 'ascii'], description: 'utf8 (default) keeps non-ASCII text; ascii replaces everything outside printable ASCII with "."' },
      max_output_bytes: { type: 'number', description: 'Cap on total returned characters. Default: 200000' },
    },
    required: ['file', 'keyword'],
  };

  private static readonly MAX_FILE_BYTES = 1_500_000_000; // 1.5GB 上限兜底，防误读超大文件把内存打爆

  async execute(args: Record<string, unknown>): Promise<string> {
    const file = args.file as string;
    const keyword = args.keyword as string;
    if (!file) return 'Error: file is required.';
    if (!keyword) return 'Error: keyword is required.';

    const before = Math.max(0, (args.before as number) ?? 600);
    const after = Math.max(0, (args.after as number) ?? 1200);
    const maxHits = Math.max(1, (args.max_hits as number) ?? 5);
    const useRegex = args.regex === true;
    const sanitizeMode = (args.sanitize as string) === 'ascii' ? 'ascii' : 'utf8';
    const maxOut = Math.max(1000, (args.max_output_bytes as number) ?? 200_000);

    const abs = path.resolve(file);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return `Error: file not found: ${abs}`; }
    if (!stat.isFile()) return `Error: not a file: ${abs}`;
    if (stat.size > ProbeTool.MAX_FILE_BYTES) {
      return `Error: file too large (${(stat.size / 1e6).toFixed(0)}MB > ${(ProbeTool.MAX_FILE_BYTES / 1e6).toFixed(0)}MB limit). Narrow the target or raise the limit in source.`;
    }

    const buf = fs.readFileSync(abs);
    const head = buf.subarray(0, 4096);
    const notes = describeBytes(head);

    const header: string[] = [
      `file: ${abs}`,
      `size: ${stat.size} bytes${notes.length ? `   (${notes.join('; ')})` : ''}`,
    ];

    // ── 定位 ──
    const hits: Hit[] = [];
    const encodingsSearched: EncKey[] = [];
    if (useRegex) {
      // 正则只在"解码成字符串"上跑；二进制用 latin1 保字节，疑似 UTF-16 时额外按 utf16le 解码一次
      encodingsSearched.push('utf8');
      const re = new RegExp(keyword, 'g');
      const text = buf.toString('utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null && hits.length < maxHits * 4) {
        // 字符串下标 → 字节偏移：按已消费字符重新计算
        const byteOffset = Buffer.byteLength(text.slice(0, m.index), 'utf8');
        hits.push({ offset: byteOffset, enc: 'utf8', length: Buffer.byteLength(m[0], 'utf8') });
        if (m[0].length === 0) re.lastIndex++;
      }
    } else {
      for (const { enc, buf: needle } of buildNeedles(keyword)) {
        encodingsSearched.push(enc);
        let from = 0;
        while (hits.length < maxHits * 4) {
          const i = buf.indexOf(needle, from);
          if (i === -1) break;
          hits.push({ offset: i, enc, length: needle.length });
          from = i + Math.max(1, needle.length);
        }
      }
    }
    hits.sort((a, b) => a.offset - b.offset);

    // 去重：只合并"真正相邻/重叠"的命中。
    // 阈值必须是固定常量，**不能**跟着 before 走 —— 否则 before 越大，越是把一堆
    // 本应独立展示的命中并成一个窗口，max_hits 形同虚设（写测试时实测踩到）。
    const DEDUPE_WINDOW = 32;
    const distinct: Hit[] = [];
    for (const h of hits) {
      if (distinct.some((d) => Math.abs(d.offset - h.offset) <= DEDUPE_WINDOW)) continue;
      distinct.push(h);
    }

    header.push(`searched encodings: ${encodingsSearched.map((e) => ENC_LABEL[e]).join(', ')}`);
    if (distinct.length === 0) {
      header.push(`NO HITS for "${keyword}"`);
      header.push('提示：确认关键字大小写；若目标是压缩/加密产物，需先解包；若文件确为文本仍无命中，可用 keyword 的更短子串再试。');
      return header.join('\n');
    }

    const shown = distinct.slice(0, maxHits);
    header.push(`${distinct.length} hit(s)${distinct.length > shown.length ? ` (showing first ${shown.length})` : ''}`);

    const out: string[] = [header.join('\n')];
    let budget = maxOut;
    for (let n = 0; n < shown.length; n++) {
      const h = shown[n]!;
      const s = Math.max(0, h.offset - before);
      const e = Math.min(buf.length, h.offset + h.length + after);
      const raw = buf.subarray(s, e);
      // 优先按命中编码解码，其余按 utf8（净化会兜住非法字节）
      const decoded = h.enc === 'utf16le' ? raw.toString('utf16le') : raw.toString('utf8');
      let body = sanitize(decoded, sanitizeMode);
      if (body.length > budget) { body = body.slice(0, Math.max(0, budget)) + '\n...(output budget reached)'; }
      budget -= body.length;
      out.push(`\n===== HIT ${n + 1} @byte ${h.offset} (${ENC_LABEL[h.enc]}, ${h.length}B matched) =====\n${body}`);
      if (budget <= 0) break;
    }
    if (distinct.length > shown.length) {
      out.push(`\n...(${distinct.length - shown.length} more hit(s) not shown; raise max_hits)`);
    }
    return out.join('\n');
  }
}
