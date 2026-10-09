import fs from 'node:fs';
import path from 'node:path';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from './registry.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('skills/loader');

/** YAML 块标量头：`>` `|` `>-` `|+` `|2` 之类 */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/;

/**
 * 解析 Markdown 文件中的 YAML frontmatter 块。
 *
 * 支持**实际会写到的 YAML 子集**（不做完整 YAML）：
 *   key: value                   单行标量
 *   key: "v" / key: 'v'          引号标量（去引号）
 *   key: >- | > | | | |- | >+    块标量（折叠 / 字面，吃后续缩进行）
 *   key: [a, b, c]               flow 序列（去括号、逗号连接；tools 之后仍按 ',' split）
 *   key: <空值> + 缩进行          多行纯标量（按折叠块处理）
 *
 * 不支持：嵌套映射、锚点 / 别名、多文档、复杂 flow。
 *
 * ★ 原则：**不认识的构造一律 warn 并跳过，绝不静默取字面量。**
 *   历史事故：skill 的 `description: >-`（标准 YAML 折叠块）被当成字符串 ">-"，
 *   无报错、无告警 ⇒ 描述静默损坏。以后要支持更多 YAML 语法就加在这里，
 *   别让它悄悄退化回"简单解析器"。
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const lines = match[1].split(/\r?\n/);
  const result: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    // 顶格才是 key；缩进行只应作为上一块的续行（应已被下面的块标量分支 consume 掉）
    if (/^\s/.test(line)) {
      log.warn('frontmatter: 意外的缩进行（疑似嵌套结构，本解析器不支持嵌套）', { line });
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      log.warn('frontmatter: 跳过无冒号行', { line });
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (!key) {
      log.warn('frontmatter: 空 key，跳过', { line });
      continue;
    }

    // ── 块标量 / 空值：吃掉后续所有更缩进的行 ──
    if (BLOCK_SCALAR_RE.test(value) || value === '') {
      const collected: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim()) { collected.push(''); continue; }  // 块内空行保留
        if (!/^\s/.test(next)) break;                        // 回到顶格 ⇒ 块结束
        collected.push(next);
      }
      i = j - 1;

      // 无显式块指示符（value 为空）时，缩进块在 YAML 里有歧义：首行形如 `key: v` / `- item`
      // ⇒ 那是嵌套映射 / 序列，Record<string,string> 表达不了 ⇒ 喊一声并跳过，不静默压成字符串。
      // （有显式 `>` / `|` 指示符时已确定是标量，不做此判断。）
      if (!BLOCK_SCALAR_RE.test(value)) {
        const firstContent = collected.find((l) => l.trim());
        if (firstContent !== undefined && /^\s*(?:-\s|[^\s#][^:]*:(?:\s|$))/.test(firstContent)) {
          log.warn(`frontmatter: "${key}" 的值疑似嵌套映射/序列（本解析器不支持，已跳过）`, { sample: firstContent });
          continue;
        }
      }

      const body = collected.join('\n').replace(/^\n+|\n+$/g, '');
      if (!body) {
        // `key:` 后面什么都没有 = YAML null（合法，例：`tools:` 表示无工具）⇒ debug，不吵。
        // 但写了块指示符（`>-` / `|`）却没给内容 ⇒ 多半是笔误 ⇒ warn。
        const msg = `frontmatter: "${key}" 的块标量为空，跳过`;
        if (value === '') log.debug(msg); else log.warn(msg);
        continue;
      }
      const fold = value === '' || value.startsWith('>');
      value = fold
        // 折叠：段内换行压成空格，段间（空行）保留为换行
        ? body.split(/\n[ \t]*\n/).map(p => p.replace(/[ \t]*\n[ \t]*/g, ' ').trim()).filter(Boolean).join('\n\n')
        // 字面：只剥掉公共前导缩进
        : body.replace(/^[ \t]+/gm, '');
      result[key] = value;
      continue;
    }

    // ── 引号标量 ──
    if (value.length > 1 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    // ── flow 序列 → 逗号列表 ──
    else if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ');
    }
    // ── 明显是我们不支持的 YAML 结构 ⇒ 喊出来，别静默 ──
    else if (/^[&*!?]/.test(value) || /^[{>|]/.test(value) || value === '~') {
      log.warn(`frontmatter: 不支持的 YAML 构造，按字面量处理 "${key}"`, { value });
    }

    if (!value) {
      log.warn(`frontmatter: "${key}" 值为空，跳过`);
      continue;
    }
    result[key] = value;
  }

  return result;
}

/**
 * 提取 YAML frontmatter 之后的正文字段
 */
function extractBody(content: string): string {
  const parts = content.split(/^---\s*$/m);
  if (parts.length >= 3) {
    return parts.slice(2).join('---').trim();
  }
  return content.trim();
}

/**
 * 从 .md 文件加载一个 skill
 */
function loadSkillFile(filePath: string, baseDir?: string): SkillDefinition | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const meta = parseFrontmatter(content);
    if (!meta || !meta.name) return null;
    const body = extractBody(content);
    const tools = meta.tools ? meta.tools.split(',').map(t => t.trim()).filter(Boolean) : [];

    return {
      name: meta.name,
      description: meta.description || meta.name,
      promptTemplate: body,
      relatedTools: tools,
      // 只有目录式 skill 才带 dir ⇒ 单文件形态保持 undefined ✓
      ...(baseDir ? { dir: baseDir } : {}),
      source: 'file',
    };
  } catch {
    return null;
  }
}

/**
 * 扫描目录中的 .md skill 文件并注册它们
 */
function scanSkillsDir(dir: string, registry: SkillRegistry): string[] {
  const loaded: string[] = [];
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }

      // ── 目录式 skill：<name>/SKILL.md ──
      // 子文件（含再嵌套的子目录）**刻意不递归扫描** ⇒ 不会被注册成独立 skill ✓
      if (stat.isDirectory()) {
        const main = ['SKILL.md', 'skill.md'].map((f) => path.join(full, f)).find((p) => fs.existsSync(p));
        if (!main) continue;
        const dirSkill = loadSkillFile(main, full);
        if (dirSkill) {
          registry.register(dirSkill);
          loaded.push(dirSkill.name);
        }
        continue;
      }

      // ── 单文件 skill：<name>.md（向后兼容 ✓，不带 dir）──
      if (!entry.endsWith('.md')) continue;
      const skill = loadSkillFile(full);
      if (skill) {
        registry.register(skill);
        loaded.push(skill.name);
      }
    }
  } catch {
    // 目录不存在
  }
  return loaded;
}

export { loadSkillFile, scanSkillsDir };
