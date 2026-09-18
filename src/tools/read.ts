import { createReadStream, promises as fs, type Stats } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Tool } from './interface.js';
import { recordFileRead } from './file-tracker.js';
import { getToolConfig } from './tool-config.js';
import { detectLang, outline, findDeclRange } from '../utils/code-structure.js';

/** 图片处理器 — 将 read 工具输出的图片注入到 ImageStore */
export interface ImageHandler {
  store(base64Data: string, mediaType: string, sourcePath: string): string;
  inject(imgId: string, data: string, mediaType: string): void;
}

// ── 常量 ────────────────────────────────────────────────────────

const BINARY_SNIFF_BYTES = 512;
const TEXT_HINT_THRESHOLD = 10 * 1024 * 1024; // 10MB

/** 单次最大/默认读取行数（tools.read.maxLines，默认 2000） */
function maxLines(): number {
  return getToolConfig('read.maxLines', 2000);
}

const IMAGE_SIGNATURES: Array<{ ext: string; mime: string; bytes: number[]; offset: number }> = [
  { ext: 'png',  mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },
  { ext: 'jpg',  mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF],       offset: 0 },
  { ext: 'gif',  mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38], offset: 0 },
  { ext: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  { ext: 'bmp',  mime: 'image/bmp',  bytes: [0x42, 0x4D],             offset: 0 },
];

// ── 二进制检测 ──────────────────────────────────────────────────

function hasNullBytes(buf: Buffer, length: number): boolean {
  for (let i = 0; i < length; i++) if (buf[i] === 0) return true;
  return false;
}

function matchSignature(buf: Buffer, sig: typeof IMAGE_SIGNATURES[number]): boolean {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[sig.offset + i] === b);
}

function detectImageType(buf: Buffer): (typeof IMAGE_SIGNATURES[number]) | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (matchSignature(buf, sig)) {
      if (sig.ext === 'webp' && buf.length >= 12) {
        if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return sig;
        continue;
      }
      return sig;
    }
  }
  return null;
}

function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

// ── 图片尺寸提取（仅读文件头，不加载像素数据）───────────────────

async function getImageDimensions(filePath: string, type: string): Promise<{ width: number; height: number } | null> {
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      await fh.read(buf, 0, 64, 0);
      switch (type) {
        case 'png':
          if (buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
          break;
        case 'jpg':
          for (let i = 2; i < buf.length - 9; i++) {
            if (buf[i] === 0xFF && buf[i + 1] === 0xC0) {
              return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
            }
          }
          break;
        case 'gif':
          if (buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
          break;
        case 'bmp':
          if (buf.length >= 26) return { width: buf.readInt32LE(18), height: buf.readInt32LE(22) };
          break;
        case 'webp':
          if (buf.length >= 30) {
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
              return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
            }
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
              const bits = buf.readUInt32LE(21);
              return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
            }
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
              return { width: (buf.readUIntLE(24, 3) & 0xFFFFFF) + 1, height: (buf.readUIntLE(27, 3) & 0xFFFFFF) + 1 };
            }
          }
          break;
      }
    } finally { await fh.close(); }
  } catch { /* degrade */ }
  return null;
}

// ── PDF trailer 页数（仅读尾部 8KB，不上全量）────────────────────

async function getPdfPageCount(filePath: string, fileSize: number | bigint): Promise<number | null> {
  try {
    const size = typeof fileSize === 'bigint' ? Number(fileSize) : fileSize;
    const tailSize = Math.min(8192, size);
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(tailSize);
      await fh.read(buf, 0, tailSize, size - tailSize);
      const tail = buf.toString('latin1');
      const m = tail.match(/\/Count\s+(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0) return n;
      }
    } finally { await fh.close(); }
  } catch { /* degrade */ }
  return null;
}

// ── 格式化 ──────────────────────────────────────────────────────

function formatLines(startLine: number, lines: string[]): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => String(startLine + i).padStart(width) + '→' + line).join('\n');
}

function formatFileSize(bytes: number | bigint): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

// ── 流式文本读取 ────────────────────────────────────────────────

async function readTextLines(filePath: string, offset: number, limit: number, fileSize: number | bigint): Promise<string> {
  const safeLimit = Math.max(1, Math.min(limit, maxLines()));
  const startLine = Math.max(1, offset);
  const endLine = startLine + safeLimit - 1;

  const resultLines: string[] = [];
  let totalLines = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    totalLines++;
    if (totalLines >= startLine && totalLines <= endLine) resultLines.push(rawLine);
    if (totalLines >= endLine) { rl.close(); break; }
  }
  rl.close();

  if (resultLines.length === 0) {
    return `(empty) offset=${offset} exceeds file (total: ${totalLines} lines)`;
  }

  const sizeNum = typeof fileSize === 'bigint' ? Number(fileSize) : fileSize;
  let output = formatLines(startLine, resultLines);

  if (sizeNum > TEXT_HINT_THRESHOLD && totalLines >= endLine) {
    output += `\n\n(file ${formatFileSize(fileSize)}, lines ${startLine}-${startLine + resultLines.length - 1} of ${totalLines}+. Use offset=${startLine + resultLines.length} for next chunk)`;
  }

  return output;
}

// ── 图片 / PDF 读取 ─────────────────────────────────────────────

async function readImage(
  filePath: string, imageType: typeof IMAGE_SIGNATURES[number], stat: Stats,
  returnBase64 = false, imageHandler?: ImageHandler | null,
): Promise<string> {
  const dims = await getImageDimensions(filePath, imageType.ext);
  const parts = [
    `[Image: ${imageType.ext.toUpperCase()}]`,
    `Size: ${formatFileSize(stat.size)}`,
  ];
  if (dims) parts.push(`Dimensions: ${dims.width}x${dims.height}px`);
  else parts.push(`Dimensions: (unable to parse)`);

  if (returnBase64) {
    const fh = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(stat.size);
    await fh.read(buf, 0, stat.size, 0);
    await fh.close();
    const b64 = buf.toString('base64');

    // 通过 ImageHandler 注入到 ImageStore，下一轮 compose 时自动作为 ImageContent 发送
    if (imageHandler) {
      const imgId = imageHandler.store(b64, imageType.mime, filePath);
      imageHandler.inject(imgId, b64, imageType.mime);
      parts.push(`Data: data:${imageType.mime};base64,${b64.slice(0, 200)}...`);
      parts.push(`Image #${imgId} injected — visible to vision models in next response.`);
    } else {
      parts.push(`Data: data:${imageType.mime};base64,${b64}`);
    }
  } else {
    parts.push('(metadata only, pixel data not loaded — use return_base64:true for vision models)');
  }
  return parts.join('\n');
}

async function readPdf(filePath: string, stat: Stats): Promise<string> {
  const pageCount = await getPdfPageCount(filePath, stat.size);
  const parts = [
    `[PDF Document]`,
    `Size: ${formatFileSize(stat.size)}`,
  ];
  if (pageCount !== null) parts.push(`Pages: ${pageCount}`);
  parts.push('(use a PDF MCP server for text/image extraction)');
  return parts.join('\n');
}

// ── ReadTool ────────────────────────────────────────────────────

export class ReadTool implements Tool {
  readonly name = 'read';
  readonly description = '读取磁盘上的文件。支持 offset/limit 分块读取。图片文件返回尺寸信息，PDF 返回页数。每次最多读取 2000 行，大文件请用 offset+limit 分段读取。另支持结构模式：outline=true 列出该文件的符号大纲（函数/类/方法+行号），symbol="名字" 只读该声明的区间 —— 二者都不依赖 xref 索引，永不"过期"。';
  readonly companionDescription = '需要看点别的东西了。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-based). Default 1.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read (1-2000, default 2000).',
      },
      return_base64: {
        type: 'boolean',
        description: 'For image files: return full base64-encoded data for use with vision models. For text files: ignored.',
      },
      outline: {
        type: 'boolean',
        description: 'List the file\'s symbol outline (functions/classes/methods with line numbers) instead of its content. Pure-text scan, no index needed. Useful before reading a large file.',
      },
      symbol: {
        type: 'string',
        description: 'Read only the given declaration\'s body (function/class/method), by name. C-family bodies are matched by brace balance, Python by indentation. Pair with outline=true to discover names.',
      },
    },
    required: ['file_path'],
  };

  private imageHandler: ImageHandler | null = null;

  setImageHandler(handler: ImageHandler): void {
    this.imageHandler = handler;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    if (!filePath) return '错误：缺少 file_path 参数。请提供文件的绝对路径。';
    const offset = Math.max(1, (args.offset as number | undefined) ?? 1);
    const limit  = Math.max(1, Math.min((args.limit as number | undefined) ?? maxLines(), maxLines()));

    let stat: Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!stat.isFile()) throw new Error(`Path is not a file: ${filePath}`);

    // 记录文件已被读取（支撑 write/edit 的 read-before-write 门控）
    recordFileRead(filePath);

    // sniff 512 bytes for type detection
    try {
      const sniffBuf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const sniffFh = await fs.open(filePath, 'r');
      const { bytesRead } = await sniffFh.read(sniffBuf, 0, BINARY_SNIFF_BYTES, 0);
      await sniffFh.close();

      const imageType = detectImageType(sniffBuf);
      if (imageType) return readImage(filePath, imageType, stat, !!args.return_base64, this.imageHandler);

      if (isPdf(sniffBuf)) return readPdf(filePath, stat);

      if (hasNullBytes(sniffBuf, bytesRead)) {
        return `[Binary File]\nSize: ${formatFileSize(stat.size)}\nBinary data detected, cannot display as text.`;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('File not found')) throw err;
    }

    // ── 结构模式（outline / symbol）──
    // 纯文本扫描，不依赖 xref 索引，因此永远不会"过期"。需要全文才能算结构，故设上限，
    // 避免把超大文件整份读进内存；超限时明确引导改用 grep structure 或分段 read。
    const wantOutline = args.outline === true;
    const symbol = args.symbol as string | undefined;
    if (wantOutline || symbol) {
      const MAX_STRUCT_BYTES = 2 * 1024 * 1024;
      if (stat.size > MAX_STRUCT_BYTES) {
        return `文件过大，结构模式不支持（${formatFileSize(stat.size)} > 上限 ${formatFileSize(MAX_STRUCT_BYTES)}）。请改用 grep 的 structure:true，或 read 分段。`;
      }
      const text = await fs.readFile(filePath, 'utf-8');
      const allLines = text.split('\n');
      const lang = detectLang(filePath);

      if (wantOutline) {
        const decls = outline(text, lang);
        if (decls.length === 0) {
          return `未在 ${filePath} 中识别出任何声明（lang=${lang}）。\n提示：若该文件确含函数/类，可用 grep 的 structure:true 辅助定位，或直接 read 分段。`;
        }
        const width = String(decls[decls.length - 1]!.line).length;
        const body = decls
          .map((d) => String(d.line).padStart(width) + '→' + d.kind.padEnd(10) + ' ' + d.name)
          .join('\n');
        return `[outline] ${filePath} (lang=${lang}, ${decls.length} 个声明)\n${body}\n\n(用 read symbol="名字" 只读某个声明的区间)`;
      }

      const range = findDeclRange(allLines, symbol!, lang);
      if (!range) {
        return `未找到符号 "${symbol}"（lang=${lang}）。\n提示：先用 read outline:true 看该文件有哪些符号名。`;
      }
      const body = allLines.slice(range.start - 1, range.end);
      return formatLines(range.start, body)
        + `\n\n(symbol "${symbol}" 位于 ${range.start}-${range.end} 行，共 ${range.end - range.start + 1} 行)`;
    }

    return readTextLines(filePath, offset, limit, stat.size);
  }
}
