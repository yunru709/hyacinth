/**
 * ## 提示词加载器 — 外部化原则
 *
 * 项目设计原则：所有面向模型的提示词内容必须通过此加载器获取，
 * 不得在代码中硬编码大段提示词文本。
 *
 * 外部覆盖顺序（项目级 → 全局 → 内置）：
 *   1. .agent/prompts/{name}.md          ← 项目自定义
 *   2. ~/.agent/prompts/{name}.md        ← 全局用户覆盖
 *   3. dist/prompts/{name}.md            ← 内置默认
 *
 * 这样用户可以在不修改源码的情况下定制任何提示词。
 * 所有 Workflow 引导模板、Persona 文件、系统规则都在此体系内。
 *
 * 如果你要新增提示词：
 *   1. 在 src/prompts/ 下建 .md 文件
 *   2. 代码中调用 loadPrompt('modes/xxx') 而非硬编码字符串
 *   3. 需要变量的用 renderPrompt(template, { key: value })
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const promptCache = new Map<string, string>();

export function getExternalPromptsDir(): string {
  return path.join(process.cwd(), '.agent', 'prompts');
}

/**
 * 加载提示词文件。
 *
 * 查找顺序（外部优先）：
 * 1. 外部目录 .agent/prompts/{name}.md（精确路径）
 * 2. 外部目录 .agent/prompts/{name}/{name}.md（子目录路径）
 * 3. 外部目录 .agent/prompts/ 递归搜索
 * 4. 编译默认目录 dist/prompts/{name}.md（精确路径）
 * 5. 编译默认目录 dist/prompts/{name}/{name}.md（子目录路径）
 * 6. 编译默认目录 dist/prompts/ 递归搜索
 *
 * skipCache: 为 true 时每次重新从磁盘读取，支持热加载
 */
export function loadPrompt(name: string, opts?: { skipCache?: boolean }): string {
  const skipCache = opts?.skipCache ?? false;

  if (!skipCache && promptCache.has(name)) {
    return promptCache.get(name)!;
  }

  const externalDir = getExternalPromptsDir();
  const builtInDir = __dirname;

  const content =
    tryLoadFromDir(externalDir, name) ??
    tryLoadFromDir(builtInDir, name);

  if (content) {
    promptCache.set(name, content);
    return content;
  }

  throw new Error(`Prompt file not found: ${name}`);
}

function tryLoadFromDir(dir: string, name: string): string | null {
  if (!fs.existsSync(dir)) return null;

  const directPath = path.join(dir, `${name}.md`);
  if (fs.existsSync(directPath)) {
    return fs.readFileSync(directPath, 'utf-8');
  }

  const subDirPath = path.join(dir, name, `${name}.md`);
  if (fs.existsSync(subDirPath)) {
    return fs.readFileSync(subDirPath, 'utf-8');
  }

  const found = findPromptFile(dir, name);
  if (found) {
    return fs.readFileSync(found, 'utf-8');
  }

  return null;
}

/** 递归搜索 .md 文件 */
function findPromptFile(dir: string, name: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findPromptFile(fullPath, name);
      if (result) return result;
    } else if (entry.name === `${name}.md`) {
      return fullPath;
    }
  }

  return null;
}

/** 清除提示词缓存 */
export function clearPromptCache(): void {
  promptCache.clear();
}

/** 获取 prompts 目录路径 */
export function getPromptsDir(): string {
  return __dirname;
}

/** 渲染模板：替换 {{variable}} 占位符 */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}
