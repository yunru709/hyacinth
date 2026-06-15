import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

/**
 * GlobTool — 使用 glob 模式匹配文件路径
 *
 * 参数：
 * - pattern (必需): glob 匹配模式（支持 *、**、?）
 * - path (可选): 搜索的根目录，默认为当前工作目录
 *
 * 返回匹配的文件路径列表（按修改时间排序），限制最大返回数量（默认 1000）
 */
export class GlobTool implements Tool {
  readonly name = 'glob';
  readonly description =
    'Find files matching a glob pattern. Returns paths sorted by modification time.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against (e.g., "**/*.ts", "src/**/*.js")',
      },
      path: {
        type: 'string',
        description: 'The directory to search in. Defaults to current working directory.',
      },
    },
    required: ['pattern'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return '错误：缺少 pattern 参数。请提供文件名匹配模式，例如 "**/*.ts"。';
    const searchPath = (args.path as string | undefined) ?? process.cwd();

    // 验证搜索路径
    try {
      const stat = await fs.stat(searchPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${searchPath}`);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Path is not a directory')) {
        throw error;
      }
      throw new Error(`Directory not found: ${searchPath}`);
    }

    // 递归遍历目录获取所有文件
    const files = await this.walkDir(searchPath);

    // 将 glob 模式转换为正则表达式并匹配
    const regex = this.globToRegex(pattern);
    const matches = files.filter((f) => regex.test(f.replace(/\\/g, '/')));

    if (matches.length === 0) {
      return 'No files matched the pattern';
    }

    // 获取文件修改时间并排序
    const withStats = await Promise.all(
      matches.map(async (relativePath) => {
        const fullPath = path.join(searchPath, relativePath);
        try {
          const stat = await fs.stat(fullPath);
          return { path: fullPath, mtime: stat.mtime.getTime() };
        } catch {
          return { path: fullPath, mtime: 0 };
        }
      })
    );

    // 按修改时间降序排列（最新的在前）
    withStats.sort((a, b) => b.mtime - a.mtime);

    // 限制返回数量
    const limited = withStats.slice(0, 1000);

    return limited.map((item) => item.path).join('\n');
  }

  /**
   * 递归遍历目录，返回相对路径列表
   */
  private async walkDir(dir: string, basePath: string = ''): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const relativePath = basePath ? path.posix.join(basePath, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subResults = await this.walkDir(fullPath, relativePath);
        results.push(...subResults);
      } else if (entry.isFile()) {
        results.push(relativePath);
      }
    }

    return results;
  }

  /**
   * 将 glob 模式转换为正则表达式
   * 支持：
   * - **  匹配任意路径层级
   * - *   匹配单层内的任意字符
   * - ?   匹配单个字符
   */
  private globToRegex(pattern: string): RegExp {
    // 统一路径分隔符
    const normalized = pattern.replace(/\\/g, '/');
    let regex = '';
    let i = 0;

    while (i < normalized.length) {
      const c = normalized[i];

      if (c === '*') {
        if (normalized[i + 1] === '*') {
          if (normalized[i + 2] === '/') {
            // **/ — 匹配零或多个目录层级
            regex += '(?:[^/]*/)*';
            i += 3;
          } else {
            // ** — 匹配任意字符（含路径分隔符）
            regex += '.*';
            i += 2;
          }
        } else {
          // * — 匹配单层内的任意字符
          regex += '[^/]*';
          i++;
        }
      } else if (c === '?') {
        // ? — 匹配单个非路径分隔符字符
        regex += '[^/]';
        i++;
      } else if (c === '/') {
        regex += '/';
        i++;
      } else if ('.+^${}()|[]\\'.includes(c)) {
        // 转义正则特殊字符
        regex += '\\' + c;
        i++;
      } else {
        regex += c;
        i++;
      }
    }

    return new RegExp('^' + regex + '$');
  }
}
