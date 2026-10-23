/**
 * preview-routes — 工作区**只读**文件预览（供 WebUI 右侧「预览」栏）
 *
 * 端点：
 *   GET /api/fs/meta              → 工作区根路径 / 名称 / 各项上限
 *   GET /api/fs/list?path=&all=1  → 某个目录的一级条目
 *   GET /api/fs/read?path=        → 文本文件内容（UTF-8，超长截断）
 *   GET /api/fs/raw?path=         → 原始字节（图片 / PDF / 其它二进制）
 *
 * 认证策略（与 /api/media **相反**）：
 *   媒体端点豁免钥匙，是因为 <img src> 没法带 Authorization 头；
 *   本组端点是 fetch 调用的，能带。而它能读到工作区里**任何**文件——源码、
 *   配置、可能含密钥的 .env——没有理由放宽，因此不进 isPublicReadRoute。
 *
 * 安全姿态（fail-closed，三条）：
 *   1. 只接受相对路径；以 / 或盘符开头的绝对路径直接拒（path.resolve 在
 *      Windows 上遇到第二个绝对路径会**整体丢弃前一个**，只看相对性判断会漏）。
 *   2. resolve 之后再用 realpath 比对：符号链接指向工作区外 ⇒ 拒。
 *      只看 resolve 后的字符串会被 `link -> /etc` 这类链接骗过去。
 *   3. `.git` 永不列出：对象库体积大且对"看文件"毫无意义。
 *
 * 只读是本模块的硬边界：没有写、没有删、没有移动。要改文件走 agent 的工具
 * （带审批），不要在这里开口子。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('preview-routes');

/** 文本文件读取上限：超过就截断并在响应里标记（前端提示"已截断"） */
export const MAX_TEXT_BYTES = 512 * 1024;
/** 原始字节上限（图片/PDF）：超过直接 413，不流式下发半个文件 */
export const MAX_RAW_BYTES = 20 * 1024 * 1024;
/** 单个目录最多列多少条（node_modules 动辄上万条，全量返回会卡死前端） */
export const MAX_LIST_ENTRIES = 800;
/** 判定"二进制"的前缀探测长度 */
const SNIFF_BYTES = 512;

/** 永不列出的目录名（大小写不敏感） */
const ALWAYS_HIDDEN = new Set(['.git']);
/** 默认隐藏、但 `?all=1` 时可以列出的目录名 */
const HIDDEN_BY_DEFAULT = new Set(['node_modules', '.svn', '.hg']);

/**
 * 带 HTTP 状态码的内部错误。路由里统一 catch → 转成对应 status，
 * 避免"越界"和"不存在"都返回 500 让前端无从区分。
 */
class PreviewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PreviewError';
  }
}

// ── 路径校验 ──────────────────────────────────────────────────────

interface SafePath {
  /** 绝对路径（供 fs 调用） */
  abs: string;
  /** 相对于 root 的 POSIX 路径（供前端回传） */
  rel: string;
}

/**
 * 把一个"前端传来的相对路径"解析成工作区内的绝对路径。
 * 任何越界/非法输入都抛 PreviewError，不返回可疑路径让调用方自己判断。
 */
export function resolveInside(rootReal: string, rootNorm: string, rel: string | undefined | null): SafePath {
  let relIn = (rel ?? '').trim();
  // 空 / `.` / `/` 都指工作区根
  if (relIn === '' || relIn === '.' || relIn === '/' || relIn === './') relIn = '.';

  // ① 拒绝绝对路径：path.resolve('C:\root', 'C:\other') 在 Windows 上会直接
  //    变成 'C:\other'，只看最后的相对性判断会把它当成合法路径放行 ✗
  if (relIn.startsWith('/') || relIn.startsWith('\\') || /^[A-Za-z]:/.test(relIn)) {
    throw new PreviewError('只接受工作区内的相对路径', 400);
  }

  const abs = path.resolve(rootNorm, relIn);
  const relBack = path.relative(rootNorm, abs);
  // ⚠️ relBack === '' 表示"就是工作区根本身"，是**合法**的；只有真跑到
  //    外面（.. 开头）或解析成另一个盘符的绝对路径才越界。
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new PreviewError('路径越出工作区', 403);
  }

  // ② realpath 校验：路径里任意一段是符号链接时，resolve 出来的字符串仍可能
  //    老老实实地"看起来在里头"，真实落点却在外面（link -> /etc/passwd）✗
  const { real: realTarget } = realpathNearest(abs);
  if (!isInsideReal(rootReal, realTarget)) {
    throw new PreviewError('路径越出工作区（符号链接）', 403);
  }

  return { abs, rel: relBack.split(path.sep).join('/') || '.' };
}

/** real 是否落在 baseReal 之内（大小写不敏感：Windows 上盘符/目录名大小写不保证） */
function isInsideReal(baseReal: string, real: string): boolean {
  const b = baseReal.toLowerCase();
  const t = real.toLowerCase();
  if (t === b) return true;
  const prefix = b.endsWith(path.sep) ? b : b + path.sep;
  return t.startsWith(prefix);
}

/**
 * 对可能还不存在的路径做 realpath：从自身往上找最近的存在祖先，
 * 逐段 realpath 后再拼回缺失的尾巴。
 * 为什么要绕这一下：新建文件/前端点了还没落盘的路径时 fs.realpathSync 会
 * 直接抛 ENOENT，而"路径不存在"和"路径越界"是两回事，不能混成 403 ✗
 */
function realpathNearest(abs: string): { real: string; missingTail: string[] } {
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), missingTail: tail.reverse() };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ── 类型 / MIME ───────────────────────────────────────────────────

export type PreviewEntryType = 'dir' | 'file' | 'link';

interface DirEntry {
  name: string;
  /** 相对 root 的 POSIX 路径 */
  path: string;
  type: PreviewEntryType;
  size: number;
  mtime: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

/** 前端用来决定"怎么渲染"的类别；不是完整 MIME 表，够用即可 */
export type PreviewKind = 'text' | 'markdown' | 'image' | 'pdf' | 'binary' | 'dir';

export function classifyFile(relPath: string): { ext: string; kind: PreviewKind; lang: string } {
  const ext = path.extname(relPath).toLowerCase();
  const name = path.basename(relPath).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || name === 'readme') {
    return { ext, kind: 'markdown', lang: 'markdown' };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'].includes(ext)) {
    return { ext, kind: 'image', lang: '' };
  }
  if (ext === '.pdf') return { ext, kind: 'pdf', lang: '' };
  return { ext, kind: 'text', lang: LANG_BY_EXT[ext] ?? '' };
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'python', '.pyw': 'python',
  '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.fs': 'fsharp',
  '.rb': 'ruby', '.php': 'php', '.pl': 'perl', '.lua': 'lua',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.ps1': 'powershell', '.bat': 'batch',
  '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.xml': 'xml', '.md': 'markdown', '.diff': 'diff', '.patch': 'diff',
  '.tex': 'latex', '.r': 'r', '.dart': 'dart', '.scala': 'scala',
};

function mimeFor(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * 二进制判定：只看前 512 字节里有没有 NUL。
 * 为什么不用扩展名白名单：工作区里什么后缀都可能出现，靠后缀判断会把
 * `.log` 之外的未知格式误判成文本，然后把一堆乱码塞进 <pre> ✗
 */
function looksBinary(head: Buffer): boolean {
  const n = Math.min(head.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

/** 精确读满 n 字节（fs.read 允许短读，只调一次会拿到半截文件） */
async function readExactly(fh: fs.promises.FileHandle, buf: Buffer, length: number): Promise<number> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// ── 路由注册 ──────────────────────────────────────────────────────

/**
 * 注册工作区文件预览路由。
 * @param app Fastify 实例（由 http-webhook 传入）
 * @param cwd 工作目录（即"工作区根"；预览不允许越过它）
 */
export function registerPreviewRoutes(app: FastifyInstance, cwd: string): void {
  const rootNorm = path.resolve(cwd || process.cwd());
  // root 自己也 realpath 一次：若 cwd 本身就在符号链接下，用它当基准比对会
  // 把"链接内"误判成"链接外" ✗
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootNorm);
  } catch {
    rootReal = rootNorm;
  }

  const safe = (rel: string | undefined | null): SafePath => resolveInside(rootReal, rootNorm, rel);

  // ── GET /api/fs/meta ────────────────────────────────────────────
  app.get('/api/fs/meta', async (_req: FastifyRequest, reply: FastifyReply) => {
    let exists = false;
    try {
      exists = fs.statSync(rootNorm).isDirectory();
    } catch {
      exists = false;
    }
    return reply.send({
      root: rootNorm,
      name: path.basename(rootNorm) || rootNorm,
      exists,
      maxTextBytes: MAX_TEXT_BYTES,
      maxRawBytes: MAX_RAW_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
      hidden: [...ALWAYS_HIDDEN],
      hiddenByDefault: [...HIDDEN_BY_DEFAULT],
    });
  });

  // ── GET /api/fs/list ────────────────────────────────────────────
  app.get('/api/fs/list', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    const showAll = q.all === '1' || q.all === 'true';
    try {
      const { abs, rel } = safe(q.path);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        return reply.status(404).send({ error: '目录不存在' });
      }
      if (!st.isDirectory()) {
        return reply.status(400).send({ error: '不是目录' });
      }

      const names = await fs.promises.readdir(abs);
      const entries: DirEntry[] = [];
      let truncated = false;

      for (const name of names) {
        if (showAll) {
          if (ALWAYS_HIDDEN.has(name.toLowerCase())) continue;
        } else {
          const lower = name.toLowerCase();
          if (ALWAYS_HIDDEN.has(lower) || HIDDEN_BY_DEFAULT.has(lower)) continue;
        }
        if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; break; }

        const childAbs = path.join(abs, name);
        let type: PreviewEntryType = 'file';
        let size = 0;
        let mtime = 0;
        try {
          // lstat：符号链接本身的信息。跟随 stat 会在链接指向自身时无限递归。
          const ls = await fs.promises.lstat(childAbs);
          mtime = Math.floor(ls.mtimeMs);
          size = ls.size;
          if (ls.isSymbolicLink()) {
            type = 'link';
            try {
              const ts = await fs.promises.stat(childAbs);
              size = ts.size;
            } catch { /* 断链：保留 lstat 的 size */ }
          } else if (ls.isDirectory()) {
            type = 'dir';
          }
        } catch {
          // 权限不足 / 竞态删除：条目仍然列出，只是没有元信息。
          // 静默跳过会让"这个文件明明在"变成看不见 ✗
        }
        entries.push({ name, path: (rel === '.' ? '' : rel + '/') + name, type, size, mtime });
      }

      // 目录在前、同层按名排（localeCompare 保证中文名不至于落到最后）
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (b.type === 'dir' && a.type !== 'dir') return 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });

      return reply.send({ path: rel, entries, truncated });
    } catch (err) {
      return fail(reply, err, 'list');
    }
  });

  // ── GET /api/fs/read ────────────────────────────────────────────
  app.get('/api/fs/read', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const { abs, rel } = safe(q.path);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        return reply.status(404).send({ error: '文件不存在' });
      }
      if (st.isDirectory()) {
        return reply.status(400).send({ error: '这是目录，请用 list' });
      }

      const { ext, kind, lang } = classifyFile(rel);
      const want = Math.min(st.size, MAX_TEXT_BYTES + 1);
      const buf = Buffer.alloc(Math.max(want, SNIFF_BYTES));
      const fh = await fs.promises.open(abs, 'r');
      let got = 0;
      try {
        got = await readExactly(fh, buf, want);
      } finally {
        await fh.close();
      }
      const head = buf.subarray(0, got);

      if (looksBinary(head)) {
        // 二进制不硬塞进 <pre>：回一个明确信号，让前端改走 /api/fs/raw
        return reply.send({
          path: rel,
          name: path.basename(rel),
          ext,
          kind: kind === 'image' ? 'image' : (ext === '.pdf' ? 'pdf' : 'binary'),
          lang: '',
          binary: true,
          content: '',
          size: st.size,
          bytes: 0,
          truncated: false,
          mtime: Math.floor(st.mtimeMs),
        });
      }

      const truncated = st.size > MAX_TEXT_BYTES;
      const text = stripBom(head.subarray(0, Math.min(got, MAX_TEXT_BYTES)).toString('utf8'));
      return reply.send({
        path: rel,
        name: path.basename(rel),
        ext,
        kind,
        lang,
        binary: false,
        content: text,
        size: st.size,
        bytes: Buffer.byteLength(text, 'utf8'),
        truncated,
        mtime: Math.floor(st.mtimeMs),
      });
    } catch (err) {
      return fail(reply, err, 'read');
    }
  });

  // ── GET /api/fs/raw ─────────────────────────────────────────────
  app.get('/api/fs/raw', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const { abs, rel } = safe(q.path);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        return reply.status(404).send({ error: '文件不存在' });
      }
      if (st.isDirectory()) {
        return reply.status(400).send({ error: '这是目录' });
      }
      if (st.size > MAX_RAW_BYTES) {
        return reply.status(413).send({ error: `文件超过 ${MAX_RAW_BYTES} 字节，预览不下发` });
      }

      const ext = path.extname(rel).toLowerCase();
      const mime = mimeFor(ext);
      reply.type(mime);
      reply.header('Cache-Control', 'private, max-age=60');
      // inline：图片/PDF 要在页面里显示，不能触发下载
      reply.header('Content-Disposition', 'inline');

      // SVG 是**可执行**内容：同源内联渲染时里面的 <script> 会跑，等于给工作区
      // 里任意 svg 一个 XSS 通道 ✗。CSP 收紧到 default-src 'none'，脚本不执行，
      // 样式仍允许内联（否则图形丢色）。
      if (ext === '.svg') {
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      }

      const stream = fs.createReadStream(abs);
      return reply.send(stream);
    } catch (err) {
      return fail(reply, err, 'raw');
    }
  });
}

/** 统一错误出口：PreviewError 带状态码，其它是意外错误一律 500 并记日志 */
function fail(reply: FastifyReply, err: unknown, where: string) {
  if (err instanceof PreviewError) {
    return reply.status(err.status).send({ error: err.message });
  }
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(`fs ${where} failed: ${e.message}`);
  return reply.status(500).send({ error: `${where} failed: ${e.message}` });
}
