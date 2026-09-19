/**
 * hyacinth doctor — 系统诊断 + 自动修复
 *
 * 检查项：
 *   1. 运行环境（Node 版本、OS、编码）
 *   2. 依赖完整性（sharp、chokidar）
 *   3. 内置 SQLite（node:sqlite，Node ≥22.5 自带，无需原生编译）
 *   4. Persona 文件（是否仍是模板？显示原始提示词）
 *   5. 配置文件（~/.agent/config.json）
 *   6. 知识库状态（kb.sqlite、files/ 目录）
 *   7. API Key 检测
 *   8. xref cache 体检（总量 / top 库 / 孤儿清单；--fix 回收孤儿）
 *
 * --fix 参数自动安装缺失依赖、并回收孤儿索引库
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Database from '../tools/sqlite.js';
import { isForbiddenAnchor } from '../tools/xref/anchor.js';

// 本文件编译为 ESM，作用域内没有 require。
// doctor 由 dist/index.js 运行，createRequire 以 dist/diagnostics/ 本文件为基准解析，
// 即可正确解析到主仓库 node_modules（cwd 无关）。
const nodeRequire = createRequire(import.meta.url);

// ── 原始 Persona 提示词（运行时从文件读取，避免内嵌不同步）─────────

function loadOriginalPrompts(): Record<string, string> {
  const sources = ['src/prompts/persona', 'dist/prompts/persona'];
  const files = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;
  const result: Record<string, string> = {};
  for (const f of files) {
    for (const dir of sources) {
      const p = path.join(process.cwd(), dir, f);
      if (fs.existsSync(p)) { result[f] = fs.readFileSync(p, 'utf-8'); break; }
    }
  }
  return result;
}

// ── 诊断结果类型 ────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

// ── 检查项 ───────────────────────────────────────────────────────────

function checkNodeEnv(): CheckResult {
  const v = process.version;
  const major = parseInt(v.slice(1).split('.')[0]!);
  const minor = parseInt(v.slice(1).split('.')[1] ?? '0');
  // node:sqlite（内置 SQLite）需要 Node ≥22.5；数据库/知识库/xref 均依赖它
  const ok = major > 22 || (major === 22 && minor >= 5);
  return {
    label: 'Node.js 版本',
    ok,
    detail: `${v} (需要 >= 22.5，内置 SQLite)`,
    fix: ok ? undefined : '升级 Node.js 到 v22.5 或以上（知识库/xref 依赖内置 node:sqlite）',
  };
}

function checkEncoding(): CheckResult {
  const cp = process.env.CODEPAGE || '';
  const isUtf8 = cp === '65001' || process.platform !== 'win32';
  return {
    label: '终端编码',
    ok: isUtf8,
    detail: isUtf8 ? 'UTF-8' : `CP${cp} (推荐 chcp 65001)`,
  };
}

function checkPersona(): CheckResult {
  const personaDir = path.join(os.homedir(), '.agent', 'prompts', 'persona');
  const files = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;
  const existing: string[] = [];
  const missing: string[] = [];

  for (const f of files) {
    const p = path.join(personaDir, f);
    if (fs.existsSync(p)) existing.push(f);
    else missing.push(f);
  }

  return {
    label: 'Persona 文件',
    ok: existing.length >= 3,
    detail: missing.length > 0
      ? `缺失: ${missing.join(', ')}`
      : `完整 (${existing.length}/3 文件)`,
    fix: missing.length > 0
      ? '运行 hyacinth setup 完成初始化'
      : undefined,
  };
}

function checkDeps(): CheckResult {
  const failures: string[] = [];
  const deps = ['sharp', 'chokidar'];

  for (const dep of deps) {
    try {
      nodeRequire.resolve(dep);
    } catch {
      failures.push(dep);
    }
  }

  return {
    label: '核心依赖',
    ok: failures.length === 0,
    detail: failures.length > 0 ? `缺失: ${failures.join(', ')}` : '全部就绪',
    fix: failures.length > 0 ? `pnpm install (缺失: ${failures.join(', ')})` : undefined,
  };
}

function checkNativeModule(): CheckResult {
  try {
    // 内置 node:sqlite（Node ≥22.5 自带，无需原生编译）
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a)');
    db.exec('INSERT INTO t VALUES (1)');
    db.close();
    return { label: '内置 SQLite (node:sqlite)', ok: true, detail: '已加载（无需原生编译）' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      label: '内置 SQLite (node:sqlite)',
      ok: false,
      detail: msg.slice(0, 120),
      fix: '升级 Node.js 到 v22.5 或以上（node:sqlite 为内置模块）',
    };
  }
}

function checkConfig(): CheckResult {
  const configPath = path.join(os.homedir(), '.agent', 'config.json');
  if (!fs.existsSync(configPath)) {
    return {
      label: '配置文件',
      ok: false,
      detail: '~/.agent/config.json 不存在',
      fix: '运行 hyacinth setup 完成配置',
    };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    JSON.parse(raw);
    return { label: '配置文件', ok: true, detail: configPath };
  } catch {
    return {
      label: '配置文件',
      ok: false,
      detail: 'JSON 解析失败',
      fix: '检查 ~/.agent/config.json 格式，或删除后重新 setup',
    };
  }
}

function checkKnowledgeBase(): CheckResult {
  const kbDir = path.join(os.homedir(), '.agent', 'knowledge');
  const dbPath = path.join(kbDir, 'kb.sqlite');
  const filesDir = path.join(kbDir, 'files');

  const hasDb = fs.existsSync(dbPath);
  const hasFiles = fs.existsSync(filesDir);

  if (!hasDb && !hasFiles) {
    return {
      label: '知识库',
      ok: true,
      detail: '未初始化（首次启动时自动创建）',
    };
  }

  let docCount = 0;
  if (hasDb) {
    try {
      // 尝试读取 SQLite 统计（内置 node:sqlite）
      const db = Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) as cnt FROM docs').get() as { cnt: number };
      docCount = row.cnt;
      db.close();
    } catch {
      // 忽略
    }
  }

  const parts: string[] = [];
  if (hasDb) parts.push(`SQLite: ${docCount} 条`);
  if (hasFiles) {
    const fileCount = fs.readdirSync(filesDir).filter(f => !f.startsWith('.')).length;
    parts.push(`files/: ${fileCount} 个文件`);
  }

  return {
    label: '知识库',
    ok: true,
    detail: parts.join(' | '),
  };
}

/** xref cache 体检的原始数据（纯函数产出，便于测试 —— 打印只是它的一个消费者） */
export interface XrefCacheReport {
  total_bytes: number;
  dbs: {
    name: string;
    path: string;
    bytes: number;
    root_dir: string;
    last_used_at: string;
    /** 孤儿 = 能读到 root_dir，但那个目录已不存在（读不到的不算，避免误删） */
    orphan: boolean;
    /**
     * 可疑根 = root_dir 落在禁区（主目录本身 / 主目录的祖先）。
     * 与"孤儿"不同：目录**存在**，但把它当项目根会把无关目录整片扫进来 ——
     * 这正是 2026-09-19 那起 1.18GB 事故的特征（root = C:\Users\74689）。
     */
    suspect_root: boolean;
  }[];
}

/** 该库的真实占用（主库 + -wal + -shm；只算主库会低估，WAL 实测可达主库 55%） */
function dbTripleBytes(base: string): number {
  let total = 0;
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try { total += fs.statSync(p).size; } catch { /* 不存在则跳过 */ }
  }
  return total;
}

/**
 * 扫描 xref cache，产出体检报告。
 * 打不开的库（被别的会话占用 / 损坏）**按未知处理、不算孤儿** —— 宁可漏报也不能误删。
 */
export function xrefCacheReport(cacheDir: string): XrefCacheReport {
  if (!fs.existsSync(cacheDir)) return { total_bytes: 0, dbs: [] };
  const dbs: XrefCacheReport['dbs'] = [];
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
      // 打不开（非数据库 / 被占用）→ rootDir 留空 → 不判孤儿（安全优先）
    } finally {
      // **必须 finally 关闭**：构造成功但 prepare 抛错时，若 close() 只写在 try 末尾就永远不会执行
      //（实测后果：体检后缓存文件被独占，后续清理 EBUSY —— 由治理测试的清理阶段抓住）
      try { db?.close(); } catch { /* 关不掉也无妨，不掩盖上面的判定结果 */ }
    }
    let suspectRoot = false;
    if (rootDir) {
      try {
        suspectRoot = isForbiddenAnchor(rootDir);
      } catch {
        suspectRoot = false; // 判定不了就不判可疑
      }
    }
    dbs.push({
      name,
      path: full,
      bytes: dbTripleBytes(full),
      root_dir: rootDir,
      last_used_at: lastUsed,
      orphan: !!rootDir && !fs.existsSync(rootDir.replace(/[/\\]+$/, '')),
      suspect_root: suspectRoot,
    });
  }
  return { total_bytes: dbs.reduce((a, d) => a + d.bytes, 0), dbs };
}

/** 回收孤儿库（三件套一起删），返回删掉的清单与回收字节数 */
export function reclaimOrphans(report: XrefCacheReport): { removed: string[]; bytes: number } {
  const removed: string[] = [];
  let bytes = 0;
  for (const d of report.dbs) {
    // 孤儿（根没了）与可疑根（根落在禁区）都可回收 —— 后者是事故形态，留着只会继续误导
    if (!d.orphan && !d.suspect_root) continue;
    for (const p of [d.path, `${d.path}-wal`, `${d.path}-shm`]) {
      try { fs.rmSync(p, { force: true }); } catch { /* 被占用则留给下次 */ }
    }
    removed.push(d.name);
    bytes += d.bytes;
  }
  return { removed, bytes };
}

/**
 * xref cache 体检（任务单四.3）。**只读报告 + 可选回收孤儿** —— 活跃库一律不动
 * （last_used_at 只用于展示，回收的唯一依据是"根目录真的没了"）。
 */
function checkXrefCache(fix: boolean): CheckResult {
  const cacheDir = path.join(os.homedir(), '.agent', 'cache');
  const report = xrefCacheReport(cacheDir);
  if (report.dbs.length === 0) {
    return { label: 'xref cache', ok: true, detail: '无索引库（尚未构建过）' };
  }

  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const orphans = report.dbs.filter((d) => d.orphan);
  const suspects = report.dbs.filter((d) => d.suspect_root && !d.orphan);
  const top = [...report.dbs].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  const active = report.dbs.filter((d) => !d.orphan && d.bytes > 50 * 1024 * 1024).length;

  const lines: string[] = [`合计 ${mb(report.total_bytes)} / ${report.dbs.length} 个库`];
  lines.push('top 库：');
  for (const d of top) lines.push(`    ${mb(d.bytes).padStart(10)}  ${d.name}`);
  if (orphans.length > 0) {
    lines.push(`孤儿 ${orphans.length} 个（root_dir 已不存在，共 ${mb(orphans.reduce((a, d) => a + d.bytes, 0))}）：`);
    for (const o of orphans) lines.push(`    ${o.name}  ← 根已消失：${o.root_dir}`);
  }

  if (suspects.length > 0) {
    lines.push(`可疑根 ${suspects.length} 个（root_dir 落在禁区，会把无关目录整片扫进来）：`);
    for (const s of suspects) lines.push(`    ${s.name}  ← 根=${s.root_dir}`);
  }

  let reclaimed = '';
  if (fix && (orphans.length > 0 || suspects.length > 0)) {
    const r = reclaimOrphans(report);
    reclaimed = ` ｜ 已回收 ${mb(r.bytes)}（${r.removed.length} 个）`;
  } else if (orphans.length > 0 || suspects.length > 0) {
    lines.push('（加 --fix 可回收这些库）');
  }

  const detail = lines.join('\n') + reclaimed;
  const ok = orphans.length === 0 && suspects.length === 0;
  if (active > 0) {
    // 大库不是"错"，但值得点出来 —— 任务单四.4 的阈值同源
    lines.push(`提示：${active} 个活跃库超 50MB，可考虑收窄构建范围（只索引需要的子目录）。`);
  }
  return { label: 'xref cache', ok, detail };
}

function checkApiKeys(): CheckResult {
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'MINIMAX_API_KEY',
    'GROQ_API_KEY',
  ];
  const found: string[] = [];
  for (const k of envKeys) {
    if (process.env[k]) found.push(k);
  }

  if (found.length > 0) {
    return {
      label: 'API Keys (环境变量)',
      ok: true,
      detail: `${found.length} 个: ${found.map(k => k.split('_')[0]).join(', ')}`,
    };
  }

  // 检查 config.json
  const configPath = path.join(os.homedir(), '.agent', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.provider?.apiKey || config.providers) {
        return { label: 'API Keys', ok: true, detail: '已配置于 config.json' };
      }
    } catch { /* ignore */ }
  }

  return {
    label: 'API Keys',
    ok: false,
    detail: '未检测到任何 API Key',
    fix: '运行 hyacinth setup 配置 Provider 和 API Key',
  };
}

// ── 主入口 ───────────────────────────────────────────────────────────

export interface DoctorOptions {
  fix?: boolean;
  showPrompts?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  console.log('🔧 hyacinth doctor\n');

  // ── 显示原始提示词 ────────────────────────────────────────────
  if (opts.showPrompts) {
    console.log('═══ 原始 Persona 提示词 ═══\n');
    for (const [name, content] of Object.entries(loadOriginalPrompts())) {
      console.log(`── ${name} ──\n`);
      console.log(content);
      console.log();
    }
    console.log('═══ 提示词结束 ═══\n');
    return;
  }

  // ── 运行诊断 ──────────────────────────────────────────────────
  const checks: CheckResult[] = [
    checkNodeEnv(),
    checkEncoding(),
    checkDeps(),
    checkNativeModule(),
    checkPersona(),
    checkConfig(),
    checkKnowledgeBase(),
    checkApiKeys(),
    checkXrefCache(!!opts.fix),
  ];

  let allOk = true;
  const needsFix: string[] = [];

  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    console.log(`${icon} ${c.label}: ${c.detail}`);
    if (!c.ok) {
      allOk = false;
      if (c.fix) needsFix.push(c.fix);
    }
  }

  console.log();

  if (allOk) {
    console.log('✅ 所有检查通过。');
    return;
  }

  console.log('修复建议：');
  for (const f of needsFix) {
    console.log(`  → ${f}`);
  }

  // ── 自动修复 ──────────────────────────────────────────────────
  if (opts.fix) {
    console.log('\n── 自动修复 ──');

    // 修复 persona 文件
    const personaDir = path.join(os.homedir(), '.agent', 'prompts', 'persona');
    if (!fs.existsSync(personaDir)) {
      fs.mkdirSync(personaDir, { recursive: true });
    }

    let personaCreated = 0;
    for (const [name, content] of Object.entries(loadOriginalPrompts())) {
      const p = path.join(personaDir, name);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, content, 'utf-8');
        personaCreated++;
      }
    }
    if (personaCreated > 0) {
      console.log(`  ✅ 创建了 ${personaCreated} 个 Persona 文件`);
    }

    // 修复依赖
    const depResult = checkDeps();
    if (!depResult.ok) {
      console.log('  🔄 安装缺失依赖...');
      try {
        execSync('pnpm install', {
          cwd: path.join(os.homedir(), '.agent'),
          stdio: 'inherit',
        });
        console.log('  ✅ 依赖安装完成');
      } catch {
        console.log('  ⚠️ 自动安装失败，请手动执行 pnpm install');
      }
    }

    console.log('\n── 再次运行诊断 ──');
    // Re-run checks after fix
    const postFix = [checkDeps(), checkPersona(), checkNativeModule()];
    for (const c of postFix) {
      const icon = c.ok ? '✅' : '❌';
      console.log(`${icon} ${c.label}: ${c.detail}`);
    }
  }

  // 显示原始提示词的位置
  console.log('\n── 提示 ──');
  console.log('  查看原始 Persona 提示词: hyacinth doctor --prompts');
  console.log('  重新运行设置向导: hyacinth setup');
}

