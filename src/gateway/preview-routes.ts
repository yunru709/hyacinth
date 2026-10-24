/**
 * preview-routes — 文件预览（供 WebUI 右侧「预览」栏）
 *
 * 端点：
 *   GET  /api/fs/meta              → 当前根路径 / 名称 / 各项上限
 *   GET  /api/fs/list?path=&all=1  → 某个目录的一级条目
 *   GET  /api/fs/read?path=        → 文本文件内容（UTF-8，超长截断）
 *   GET  /api/fs/raw?path=         → 原始字节（图片 / PDF / HTML / 其它二进制）
 *   GET  /api/fs/browse?dir=       → 目录选择器用：列**子目录**（只回环可达）
 *   POST /api/fs/root              → 切换预览根目录（只回环可达）
 *
 * 认证策略（与 /api/media **相反**）：
 *   媒体端点豁免钥匙，是因为 <img src> 没法带 Authorization 头；
 *   本组端点是 fetch 调用的，能带。而它能读到根目录里**任何**文件——源码、
 *   配置、可能含密钥的 .env——没有理由放宽，因此不进 isPublicReadRoute。
 *
 * 安全姿态（fail-closed，四条）：
 *   1. list/read/raw 只接受**相对当前根**的路径；以 / 或盘符开头的绝对路径
 *      直接拒（path.resolve 在 Windows 上遇到第二个绝对路径会**整体丢弃前
 *      一个**，只看相对性判断会漏）。
 *   2. resolve 之后再用 realpath 比对：符号链接指向根外 ⇒ 拒。
 *      只看 resolve 后的字符串会被 `link -> /etc` 这类链接骗过去。
 *   3. `.git` 永不列出：对象库体积大且对"看文件"毫无意义。
 *   4. **换根只能本机发起**（browse / root 两个端点校验 remoteAddress 是回环）。
 *      否则任何拿到钥匙的局域网客户端都能把根设成 `C:\` 再随意读——
 *      那等于把"预览工作区"变成"读全盘"。回环限制不影响正常使用：
 *      换根本来就是坐在机器前的人做的事。
 *
 * 只读是本模块的硬边界：没有写、没有删、没有移动。要改文件走 agent 的工具
 * （带审批），不要在这里开口子。
 */

import fs from 'node:fs';
import os from 'node:os';
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
  // HTML 预览用同源 iframe 加载：缺了这条会回 octet-stream，浏览器只会当附件下载。
  // ⚠️ **不能带 charset**：HTTP 头的 charset 优先级高于页面里的 <meta charset>，
  //    写死 utf-8 会让 gb2312/gbk 的老页面整页乱码（实测 tools-dev 下的页面就是 gb2312）。
  //    不声明则浏览器按 <meta> 走；没有 meta 的现代页面会被自动嗅探成 utf-8。
  '.html': 'text/html',
  '.htm': 'text/html',
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
export type PreviewKind = 'text' | 'markdown' | 'image' | 'pdf' | 'html' | 'binary' | 'dir';

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
  // HTML 单独成一类：前端默认用沙箱 iframe 渲染，并可切回源码。
  // 当成普通 text 的话，点开一个页面只能看到标签 —— 预览栏对 .html 就等于没有预览。
  if (ext === '.html' || ext === '.htm') return { ext, kind: 'html', lang: 'html' };
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

// ── 根目录状态 ────────────────────────────────────────────────────

/** 根目录选择的落盘位置（与其它本机状态同放 ~/.agent） */
const ROOT_STATE_FILE = path.join(os.homedir(), '.agent', 'preview-root.json');
/** 目录选择器里最多回多少条子目录 */
const MAX_BROWSE_ENTRIES = 500;
/** 最近使用保留几条 */
const MAX_RECENT_ROOTS = 6;

interface RootState {
  /** 规范化绝对路径（未 realpath） */
  norm: string;
  /** realpath 后的路径，越界判定基准 */
  real: string;
}

interface RootPrefs {
  root: string;
  recent: string[];
}

/**
 * 把一个绝对路径变成 RootState。
 * realpath 失败（目录刚被删/没权限）时退回 norm —— 此时 meta 会给出
 * exists:false，前端据此提示，而不是把整个预览栏打死。
 */
function makeRoot(abs: string): RootState {
  const norm = path.resolve(abs);
  let real: string;
  try {
    real = fs.realpathSync(norm);
  } catch {
    real = norm;
  }
  return { norm, real };
}

/** 目录是否存在（异常一律当不存在：无权限与不存在对用户是同一种结果） */
function isDirectory(abs: string): boolean {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** 读根目录偏好；坏文件/不存在都退回空设置（不抛） */
function loadRootPrefs(file: string): RootPrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<RootPrefs>;
    return {
      root: typeof raw.root === 'string' ? raw.root : '',
      recent: Array.isArray(raw.recent) ? raw.recent.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return { root: '', recent: [] };
  }
}

function saveRootPrefs(file: string, prefs: RootPrefs): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (err) {
    // 存不下只是"下次启动记不住"，不该让当前这次切换失败
    logger.warn(`preview root 持久化失败: ${(err as Error)?.message ?? err}`);
  }
}

/**
 * 是否本机发起。换根 / 浏览任意目录只对回环开放：
 * 这两件事等价于"扩大服务端的可读范围"，没有任何理由让局域网客户端做。
 */
function isLoopbackRequest(req: FastifyRequest): boolean {
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
}

/** Windows 下探测存在的盘符根（`C:\`），其它平台给 `/` */
function listDriveRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      if (fs.statSync(root).isDirectory()) out.push(root);
    } catch {
      // 空光驱/未挂载的盘符会抛，正常跳过
    }
  }
  return out;
}

// ── 路由注册 ──────────────────────────────────────────────────────

/**
 * 注册文件预览路由。
 * @param app Fastify 实例（由 http-webhook 传入）
 * @param cwd 启动时的工作目录 —— 作为**默认根**，用户可在预览栏里换成别的目录
 * @param opts.stateFile 根目录偏好的落盘文件（测试传临时文件，避免污染 ~/.agent）
 */
export function registerPreviewRoutes(
  app: FastifyInstance,
  cwd: string,
  opts: { stateFile?: string } = {},
): void {
  const stateFile = opts.stateFile ?? ROOT_STATE_FILE;
  const defaultRootNorm = path.resolve(cwd || process.cwd());
  // 持久化过的根优先：重启后接着看上次那个目录，符合"我选过了"的预期。
  // 但记录里的目录若已不存在，就别硬撑 —— 退回工作区，否则一开栏就是一屏报错。
  const prefs = loadRootPrefs(stateFile);
  const savedOk = prefs.root && isDirectory(prefs.root);
  let root: RootState = makeRoot(savedOk ? prefs.root : defaultRootNorm);

  const safe = (rel: string | undefined | null): SafePath => resolveInside(root.real, root.norm, rel);

  function metaOf(): Record<string, unknown> {
    let exists = false;
    try {
      exists = fs.statSync(root.norm).isDirectory();
    } catch {
      exists = false;
    }
    return {
      root: root.norm,
      name: path.basename(root.norm) || root.norm,
      exists,
      defaultRoot: defaultRootNorm,
      // 换过根 ⇒ 前端可以显示"回到工作区"这类入口
      isCustom: path.resolve(root.norm) !== path.resolve(defaultRootNorm),
      maxTextBytes: MAX_TEXT_BYTES,
      maxRawBytes: MAX_RAW_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
      hidden: [...ALWAYS_HIDDEN],
      hiddenByDefault: [...HIDDEN_BY_DEFAULT],
    };
  }

  function rememberRecent(dir: string): void {
    const next = [dir, ...prefs.recent.filter((x) => path.resolve(x) !== path.resolve(dir))]
      .slice(0, MAX_RECENT_ROOTS);
    prefs.recent = next;
    prefs.root = dir;
    saveRootPrefs(stateFile, prefs);
  }

  // ── GET /api/fs/meta ────────────────────────────────────────────
  app.get('/api/fs/meta', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(metaOf());
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

  // ── GET /api/fs/browse ─────────────────────────────────────────
  // 目录选择器专用：接受**绝对路径**（无法再走 resolveInside —— 它的意义就是
  // 走到当前根之外去挑新根）。所以只回目录名、不回文件内容，且只限本机。
  app.get('/api/fs/browse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackRequest(req)) {
      return reply.status(403).send({ error: '选择目录只允许在本机操作' });
    }
    const q = req.query as Record<string, string | undefined>;
    const raw = (q.dir ?? '').trim();
    if (raw && !path.isAbsolute(raw)) {
      return reply.status(400).send({ error: '需要绝对路径' });
    }
    const dir = raw ? path.resolve(raw) : root.norm;

    let st: fs.Stats;
    try {
      st = await fs.promises.stat(dir);
    } catch {
      return reply.status(404).send({ error: '目录不存在或无权访问' });
    }
    if (!st.isDirectory()) {
      return reply.status(400).send({ error: '这不是目录' });
    }

    let names: string[] = [];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // 系统保护目录（System Volume Information 之类）会 EPERM/EACCES：
      // 这是"看到了但进不去"，与"不存在"要分开说，否则用户以为路径打错了
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        return reply.status(403).send({ error: '没有访问该目录的权限' });
      }
      throw e;
    }

    const entries: Array<{ name: string; path: string }> = [];
    let truncated = false;
    for (const name of names) {
      if (name === '.git' || name === '.svn' || name === '.hg') continue;
      const childAbs = path.join(dir, name);
      let isDir = false;
      try {
        // lstat 而非 stat：符号链接一律不当目录列出来，避免点进去落到别处
        const ls = await fs.promises.lstat(childAbs);
        isDir = ls.isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (entries.length >= MAX_BROWSE_ENTRIES) { truncated = true; break; }
      entries.push({ name, path: childAbs });
    }
    // Windows 的盘符根与 POSIX 的 / 都不区分大小写，排序用 localeCompare 更自然
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    const parent = path.dirname(dir);
    const shortcuts: Array<{ label: string; path: string; kind: string }> = [
      { label: '工作区', path: defaultRootNorm, kind: 'workspace' },
      { label: '主目录', path: os.homedir(), kind: 'home' },
      ...listDriveRoots().map((p) => ({ label: p.replace(/[\\/]+$/, '') || p, path: p, kind: 'drive' })),
    ];
    // 去重（主目录和工作区可能是同一个），保序
    const seen = new Set<string>();
    const uniq = shortcuts.filter((s) => {
      const k = path.resolve(s.path).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return reply.send({
      dir,
      // 到盘符根就没了：dirname('C:\\') === 'C:\\'
      parent: parent === dir ? null : parent,
      entries,
      truncated,
      shortcuts: uniq,
      recent: prefs.recent.filter((x) => isDirectory(x)),
      current: root.norm,
    });
  });

  // ── POST /api/fs/root ──────────────────────────────────────────
  // 换根：只改"预览看哪儿"，不动 agent 的工作目录，也不动工具围栏。
  app.post('/api/fs/root', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackRequest(req)) {
      return reply.status(403).send({ error: '切换根目录只允许在本机操作' });
    }
    const body = (req.body ?? {}) as { root?: unknown };
    const raw = typeof body.root === 'string' ? body.root.trim() : '';

    // 空 / 'default' ⇒ 回到启动时的工作区（前端"回到工作区"按钮走这条路）
    const target = !raw || raw === 'default' ? defaultRootNorm : raw;
    if (target !== defaultRootNorm && !path.isAbsolute(target)) {
      return reply.status(400).send({ error: '需要绝对路径' });
    }
    if (!isDirectory(target)) {
      return reply.status(404).send({ error: '目录不存在' });
    }

    root = makeRoot(target);
    rememberRecent(root.norm);
    logger.info(`preview root → ${root.norm}`);
    return reply.send(metaOf());
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
