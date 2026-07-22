/**
 * hyacinth doctor — 系统诊断 + 自动修复
 *
 * 检查项：
 *   1. 运行环境（Node 版本、OS、编码）
 *   2. 依赖完整性（sharp、chokidar、better-sqlite3）
 *   3. 原生模块（better-sqlite3 .node 二进制）
 *   4. Persona 文件（是否仍是模板？显示原始提示词）
 *   5. 配置文件（~/.agent/config.json）
 *   6. 知识库状态（kb.sqlite、files/ 目录）
 *   7. API Key 检测
 *
 * --fix 参数自动安装缺失依赖
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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
  return {
    label: 'Node.js 版本',
    ok: major >= 18,
    detail: `${v} (需要 >= 18)`,
    fix: major < 18 ? '升级 Node.js 到 v18 或以上' : undefined,
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
  const deps = ['sharp', 'chokidar', 'better-sqlite3'];

  for (const dep of deps) {
    try {
      require.resolve(dep);
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
    const m = require.resolve('better-sqlite3');
    // 尝试加载验证
    require(m);
    return { label: '原生模块 (better-sqlite3)', ok: true, detail: '已加载' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      label: '原生模块 (better-sqlite3)',
      ok: false,
      detail: msg.slice(0, 120),
      fix: 'pnpm rebuild better-sqlite3 或 pnpm approve-builds',
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
      // 尝试读取 SQLite 统计
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
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

