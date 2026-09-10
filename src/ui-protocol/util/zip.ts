// ============================================================
// 最小 ZIP 打包器（纯 Node 实现，零第三方依赖）
// ============================================================
// 用途：session.export 把多份 session 打包成一个 zip 文件。
// 实现：deflate（zlib.deflateRawSync）+ 标准 ZIP 结构
// （local file header + central directory + end record）。
// 兼容 Windows 资源管理器 / macOS Archive Utility / 常见解压工具。
// ============================================================

import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** zip 内路径（正斜杠分隔，如 `webui_xxx/conversation.jsonl`） */
  path: string;
  data: Buffer;
}

/** 表驱动 CRC32（避免依赖 Node 新版本 zlib.crc32） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): number {
  return (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
}

function dosDate(date: Date): number {
  return ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

/** 写入小端整数 */
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * 打包 entries 为 zip Buffer。
 * 所有条目统一使用当前时间（DOS 时间字段），deflate 压缩。
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);

  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf-8');
    const raw = entry.data;
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const csize = compressed.length;
    const usize = raw.length;

    // ── Local file header ──
    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20),         // version needed to extract
      u16(0),          // general purpose flag
      u16(8),          // compression method: deflate
      u16(time),
      u16(date),
      u32(crc),
      u32(csize),
      u32(usize),
      u16(nameBuf.length),
      u16(0),          // extra field length
      nameBuf,
      compressed,
    ]);
    chunks.push(local);
    offset += local.length;

    // ── Central directory entry ──
    central.push(
      Buffer.concat([
        u32(0x02014b50), // central file header signature
        u16(20),         // version made by
        u16(20),         // version needed to extract
        u16(0),          // flags
        u16(8),          // method
        u16(time),
        u16(date),
        u32(crc),
        u32(csize),
        u32(usize),
        u16(nameBuf.length),
        u16(0),          // extra length
        u16(0),          // comment length
        u16(0),          // disk number start
        u16(0),          // internal attrs
        u32(0),          // external attrs
        u32(offset - local.length), // local header offset
        nameBuf,
      ]),
    );
  }

  const centralBuf = Buffer.concat(central);
  const centralStart = offset;

  // ── End of central directory record ──
  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0),          // disk number
    u16(0),          // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(centralStart),
    u16(0),          // comment length
  ]);

  return Buffer.concat([...chunks, centralBuf, end]);
}
