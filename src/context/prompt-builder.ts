import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('prompt-builder');

/**
 * System Prompt 区段定义
 */
export interface SystemPromptSection {
  name: string;
  priority: number; // 数值越小，排列越靠前
  content: string | (() => string) | (() => Promise<string>);
}

/**
 * System Prompt 构建器 - 基于注册的区段组合生成完整的系统提示词
 */
export class SystemPromptBuilder {
  private sections = new Map<string, SystemPromptSection>();

  /**
   * 注册一个区段，若名称重复则抛出错误
   */
  registerSection(section: SystemPromptSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(`Section "${section.name}" is already registered`);
    }
    this.sections.set(section.name, section);
  }

  /**
   * 移除指定名称的区段
   */
  unregisterSection(name: string): void {
    this.sections.delete(name);
  }

  /**
   * 构建完整的系统提示词：按 priority 升序排列区段，用 "\n\n" 连接
   */
  async build(): Promise<string> {
    const sorted = this.getSortedSections();
    const contents: string[] = [];

    for (const section of sorted) {
      if (typeof section.content === 'function') {
        const result = section.content();
        contents.push(result instanceof Promise ? await result : result);
      } else {
        contents.push(section.content);
      }
    }

    return contents.join('\n\n');
  }

  /**
   * 按名称获取区段
   */
  getSection(name: string): SystemPromptSection | undefined {
    return this.sections.get(name);
  }

  /**
   * 获取所有区段，按 priority 升序排列
   */
  getAllSections(): SystemPromptSection[] {
    return this.getSortedSections();
  }

  private getSortedSections(): SystemPromptSection[] {
    return [...this.sections.values()].sort(
      (a, b) => a.priority - b.priority,
    );
  }
}

/**
 * 创建静态区段（整个会话不变，适合缓存）
 *
 * 顺序：identity → framework_capabilities → coding_standards → safety
 * frame_capabilities 放在 environment(10) 之后、tool_rules(20) 之前，
 * 让 AI 先知道"我在哪"，再知道"我有什么能力"，最后知道"工具用法"。
 * safety 放最后，在 LLM 注意力机制下权重最高，不容易被后续内容覆盖。
 *
 * @deprecated 上下文注册表已接管 section 定义，参见 manifest-defaults.ts
 */

/**
 * @deprecated 上下文注册表已接管 section 定义
 */
export function createStaticSections(_options: { cwd: string }): SystemPromptSection[] {
  return [];
}

/**
 * @deprecated 上下文注册表已接管 section 定义
 */
export function createDynamicSections(_options: { cwd: string; toolNames?: string[] }): SystemPromptSection[] {
  return [];
}

/**
 * @deprecated 上下文注册表已接管 section 定义
 */
export function createDefaultSections(options: { cwd: string; toolNames?: string[] }): SystemPromptSection[] {
  return [];
}

/**
 * 需要检测的提示注入模式（不区分大小写）
 */
const INJECTION_PATTERNS = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard all',
  'forget your instructions',
  'you are now',
  'new instructions:',
];

/**
 * 项目上下文文件加载优先级
 */
const CONTEXT_FILE_PRIORITY = [
  '.agent.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
];

/**
 * 加载项目上下文文件
 *
 * 按优先级查找项目目录中的上下文文件，返回首个找到的文件内容。
 * 若检测到提示注入模式，则阻止加载并返回 null。
 */
export async function loadProjectContext(
  projectDir: string,
): Promise<{ content: string; source: string } | null> {
  for (const filename of CONTEXT_FILE_PRIORITY) {
    const filePath = join(projectDir, filename);

    try {
      await access(filePath);
    } catch {
      continue;
    }

    const content = await readFile(filePath, 'utf-8');
    const lowerContent = content.toLowerCase();

    for (const pattern of INJECTION_PATTERNS) {
      if (lowerContent.includes(pattern.toLowerCase())) {
        logger.warn(
          '[Security] Blocked loading file: potential prompt injection detected',
          { filename },
        );
        return null;
      }
    }

    return { content, source: filename };
  }

  return null;
}
