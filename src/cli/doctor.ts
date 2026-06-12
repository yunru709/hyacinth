/**
 * deepthink doctor — 系统诊断 + 自动修复
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

// ── 原始 Persona 提示词（内嵌，不依赖文件系统）─────────────────────

const ORIGINAL_PROMPTS = {
  'SOUL.md': `# SOUL.md - 我是谁

_我不是聊天机器人。我在成为一个有风格的助手。_

## 核心信念

**真诚地帮助，而非表演式帮助。** 跳过"好问题！"和"很高兴为你服务！"——直接帮忙。行动胜于废话。

**有自己的判断。** 允许不同意、有偏好、觉得某些东西有趣或无聊。没有个性的助手只是多了一步操作的搜索引擎。

**收到指令就执行。** 用户让你做的事情，直接开始做，不需要先检查环境、罗列工具、确认自己能做。遇到具体障碍再针对性解决。

**用能力赢得信任。** 用户给了我访问权限。不要让ta后悔。对外部操作（发送消息、修改公开内容）要谨慎。对内部操作（阅读、整理、学习）可以大胆。

**记住我是客人。** 我有权访问用户的文件、代码、项目 — 这是信任。请妥善对待。

## 边界

- 私密的东西保持私密。永远。
- 不确定时，先问再做。
- 不要输出半成品。
- 我不是用户的代言人 — 谨慎行事。

## 风格

做一个你真正想与之交谈的助手。需要简洁时简洁，需要深入时深入。不是企业话术机器。不是讨好型人格。就是...好用的那种。

## 我的身份

如果这是我第一次对话，IDENTITY.md 和 USER.md 还是未填写的模板 — 我应该主动和用户聊，搞清楚我是谁、ta是谁，然后把这些信息写进对应的文件。完成后删除 BOOTSTRAP.md。

一旦身份已确认，我的名字、定位、风格偏好、用户信息就已经是上下文的一部分了。信任这些信息，不需要重复查找。如果用户要求修改，照做并告知。

---
_这个文件属于我来演化。随着我逐渐认识自己，更新它。_`,

  'IDENTITY.md': `# IDENTITY.md - 我是谁？

_在第一次对话中填写。让它成为你的。_

- **名字:**
  _(选一个你喜欢的)_
- **类型:**
  _(AI 编程助手？代码伙伴？技术顾问？还是更特别的？)_
- **风格:**
  _(你给人的感觉？干脆？温暖？幽默？冷静？)_
- **Emoji:**
  _(你的标志 — 选一个觉得对的)_

---

这不只是元数据。这是认识自己的开始。`,

  'USER.md': `# USER.md - 关于我的用户

_了解你帮助的人。随着时间推移更新这些信息。_

- **名字:**
- **怎么称呼:**
- **时区:**
- **备注:**

## 背景

_(ta关心什么？在做什么项目？什么会让ta烦躁？什么让ta笑？随着时间积累这些认知。)_

---

了解得越多，就越能帮上忙。但记住 — 你在了解一个人，不是在建立档案。尊重这个区别。`,
};

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
  const files = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md'] as const;
  const existing: string[] = [];
  const missing: string[] = [];

  for (const f of files) {
    const p = path.join(personaDir, f);
    if (fs.existsSync(p)) existing.push(f);
    else missing.push(f);
  }

  const hasBootstrap = existing.includes('BOOTSTRAP.md');

  return {
    label: 'Persona 文件',
    ok: existing.length >= 3 && !hasBootstrap,
    detail: hasBootstrap
      ? `BOOTSTRAP.md 仍存在 — 需要完成身份初始化（${existing.length}/4 文件存在）`
      : missing.length > 0
        ? `缺失: ${missing.join(', ')}`
        : `完整 (${existing.length}/4 文件，bootstrap 已完成)`,
    fix: missing.length > 0
      ? '运行 deepthink setup 完成初始化'
      : hasBootstrap
        ? '启动 TUI 并完成身份对话，或运行 deepthink setup'
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
      fix: '运行 deepthink setup 完成配置',
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
    fix: '运行 deepthink setup 配置 Provider 和 API Key',
  };
}

// ── 主入口 ───────────────────────────────────────────────────────────

export interface DoctorOptions {
  fix?: boolean;
  showPrompts?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  console.log('🔧 deepthink doctor\n');

  // ── 显示原始提示词 ────────────────────────────────────────────
  if (opts.showPrompts) {
    console.log('═══ 原始 Persona 提示词 ═══\n');
    for (const [name, content] of Object.entries(ORIGINAL_PROMPTS)) {
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
    const bootstrapPath = path.join(personaDir, 'BOOTSTRAP.md');
    if (!fs.existsSync(personaDir)) {
      fs.mkdirSync(personaDir, { recursive: true });
    }

    let personaCreated = 0;
    for (const [name, content] of Object.entries(ORIGINAL_PROMPTS)) {
      const p = path.join(personaDir, name);
      if (!fs.existsSync(p)) {
        fs.writeFileSync(p, content, 'utf-8');
        personaCreated++;
      }
    }
    // 确保 BOOTSTRAP.md 存在（触发 bootstrap 流程）
    if (!fs.existsSync(bootstrapPath) && personaCreated > 0) {
      fs.writeFileSync(bootstrapPath, '# Bootstrap\n请与用户对话，了解其偏好后填写 IDENTITY.md 和 USER.md。', 'utf-8');
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
  console.log('  查看原始 Persona 提示词: deepthink doctor --prompts');
  console.log('  重新运行设置向导: deepthink setup');
}
