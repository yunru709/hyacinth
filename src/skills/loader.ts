import fs from 'node:fs';
import path from 'node:path';
import type { SkillDefinition } from '../types.js';
import type { SkillRegistry } from './registry.js';

/**
 * 解析 Markdown 文件中的 YAML frontmatter 块
 * 简单解析器 -- 仅处理 key: value 格式
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) result[key] = value;
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
function loadSkillFile(filePath: string): SkillDefinition | null {
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
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const skill = loadSkillFile(filePath);
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
