/**
 * xref 的「索引哪个项目」来源 —— 根解析 + 记忆 + 索引库清点。
 *
 * 背景（2026-10-07 实测事故）：索引根此前**只能**取 agent 的启动目录。agent 从
 * 用户主目录启动时，根即主目录 ⇒ 被 assertIndexableRoot 有意拒绝（防止把
 * AppData/浏览器缓存扫进索引、产出 GB 级垃圾库）⇒ 插件静默 idle ⇒ 三个工具
 * 全不注册，而模型**没有任何补救入口**（连"换个根重建"都做不到）。
 *
 * 设计：
 *   · 根可**显式传入**（工具参数 root），构建成功后**记住** ⇒ 之后免传。
 *   · 优先级：显式参数 > 记忆 > 兜底（由调用方给出的 cwd）。
 *   · 记忆存独立小文件 ~/.agent/xref.json，**不进配置中心**，理由有二：
 *     ① 配置中心是进程级单例，一次写入会扇出给所有会话的 config watch（回声噪声）；
 *     ② 它是运行期状态，不是用户配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../sqlite.js';
import { isForbiddenAnchor } from './anchor.js';

/** 记忆文件路径（独立于 config.json，见文件头说明） */
export function xrefStatePath(): string {
  return path.join(os.homedir(), '.agent', 'xref.json');
}

/** xref 索引库存放目录 */
export function xrefCacheDir(): string {
  return path.join(os.homedir(), '.agent', 'cache');
}

/** 读取记忆的「当前项目根」；文件缺失 / 损坏 / 字段非字符串 ⇒ null */
export function readRememberedRoot(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(xrefStatePath(), 'utf-8')) as { activeRoot?: unknown };
    return typeof raw.activeRoot === 'string' && raw.activeRoot.trim() ? raw.activeRoot : null;
  } catch {
    // 文件不存在或坏了都按"没记住"处理 —— 记忆只是省事，不该阻塞建索引
    return null;
  }
}

/** 记住「当前项目根」。写失败不抛：记忆是优化，不是前提。 */
export function rememberRoot(root: string): void {
  try {
    const p = xrefStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ activeRoot: root, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    );
  } catch {
    /* 写不进就算了 —— 下次显式传 root 即可，功能不受影响 */
  }
}

/**
 * 解析本次要用的项目根。
 * @param explicit 工具参数里的 root（显式优先，支持相对路径按 cwd 解析）
 * @param fallback 兜底（通常是 agent 的启动目录）
 * @returns 绝对路径；三者皆无 ⇒ null（调用方应回一句可操作的提示）
 */
export function resolveActiveRoot(explicit: string | undefined, fallback?: string): string | null {
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  // ⚠️ 顺序是关键：**已绑定的根优先于记忆**。
  // 反过来的话，manager 一旦显式绑到 B，记忆里的 A 会把它拽回去 —— 同进程内多个项目
  // 交替使用时就会查错库（实测：xref-tools 的 13 个用例因此集体失败）。
  // 记忆只在"尚未绑定任何根"时才用来做初始绑定，语义是"上次用的那个"。
  if (fallback && fallback.trim()) return fallback.trim();
  const remembered = readRememberedRoot();
  if (remembered) return remembered;
  return null;
}

// ── 索引库清点（"我这边要有的管理能力"）────────────────────────────

export interface XrefIndexEntry {
  /** 项目键 = 库文件名去掉 `xref-` 前缀与 `.sqlite` 后缀 */
  key: string;
  /** 库文件全路径 */
  path: string;
  /** 真实占用（主库 + -wal + -shm；只算主库会低估，WAL 实测可达主库的 55%） */
  bytes: number;
  /** 库内记录的索引根（读不到为空串） */
  rootDir: string;
  /** 库内记录的最近使用时间 */
  lastUsedAt: string;
  /** 根目录已不存在 ⇒ 可回收 */
  orphan: boolean;
  /** 根落在禁区（主目录本身 / 其祖先）—— 历史事故形态，留着只会继续误导 */
  suspectRoot: boolean;
}

/** 该库的真实占用（三件套） */
function dbTripleBytes(base: string): number {
  let total = 0;
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try { total += fs.statSync(p).size; } catch { /* 不存在则跳过 */ }
  }
  return total;
}

/**
 * 清点 cache 目录下的全部 xref 索引库。
 *
 * 与 diagnostics/doctor.ts 的 `xrefCacheReport` 的分工：那边是**体检报告**（面向
 * doctor 命令，含回收孤儿）；这里是**工具入口**（面向模型）。刻意各自实现而不互相
 * import —— tools 层反向依赖 diagnostics 会破坏分层（doctor 才是依赖方，它用
 * anchor.ts 的 isForbiddenAnchor）。两者口径一致：打不开的库按"未知"处理，绝不
 * 因读不出根就判孤儿（宁可漏报，不可误删）。
 */
export function listXrefIndexes(cacheDir: string = xrefCacheDir()): XrefIndexEntry[] {
  if (!fs.existsSync(cacheDir)) return [];
  const out: XrefIndexEntry[] = [];
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.startsWith('xref-') || !name.endsWith('.sqlite')) continue;
    const full = path.join(cacheDir, name);
    let rootDir = '';
    let lastUsed = '';
    let db: ReturnType<typeof Database> | null = null;
    try {
      db = Database(full, { readonly: true });
      const get = (k: string): string =>
        (db!.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value?: string } | undefined)?.value ?? '';
      rootDir = get('root_dir');
      lastUsed = get('last_used_at');
    } catch {
      // 打不开（被别的会话占用 / 损坏）⇒ 根视为未知 ⇒ 不判孤儿（安全优先）
    } finally {
      try { db?.close(); } catch { /* 关不掉不掩盖上面的判定 */ }
    }
    let suspectRoot = false;
    if (rootDir) {
      try { suspectRoot = isForbiddenAnchor(rootDir); } catch { suspectRoot = false; }
    }
    out.push({
      key: name.slice('xref-'.length, -'.sqlite'.length),
      path: full,
      bytes: dbTripleBytes(full),
      rootDir,
      lastUsedAt: lastUsed,
      orphan: !!rootDir && !fs.existsSync(rootDir.replace(/[/\\]+$/, '')),
      suspectRoot,
    });
  }
  // 大的排前面（最该被注意的先说话）
  return out.sort((a, b) => b.bytes - a.bytes);
}
