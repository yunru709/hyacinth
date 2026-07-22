import fs from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import type { Tool } from './interface.js';

/**
 * DiffFilesTool — 比较两个文件的行级差异
 *
 * 参数：
 * - file1 (必需): 第一个文件路径
 * - file2 (必需): 第二个文件路径
 *
 * 返回统一的 diff 格式，每行标记 + / - / 不变。
 */
export class DiffFilesTool implements Tool {
  readonly name = 'diff_files';
  readonly description =
    '逐行比较两个文件，返回 unified diff 格式的差异。+ 表示新增行，- 表示删除行。支持绝对路径和相对路径。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file1: { type: 'string', description: 'Path to the first file (absolute or relative to cwd)' },
      file2: { type: 'string', description: 'Path to the second file (absolute or relative to cwd)' },
    },
    required: ['file1', 'file2'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const file1 = args.file1 as string;
    const file2 = args.file2 as string;

    if (!file1 || !file2) return 'Error: Both file1 and file2 are required.';

    const cwd = process.cwd();
    const resolve = (p: string) => path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const abs1 = resolve(file1);
    const abs2 = resolve(file2);

    let content1: string, content2: string;
    try { content1 = fs.readFileSync(abs1, 'utf-8'); }
    catch { return `Error: Cannot read file1: ${abs1}`; }
    try { content2 = fs.readFileSync(abs2, 'utf-8'); }
    catch { return `Error: Cannot read file2: ${abs2}`; }

    const changes = diffLines(content1, content2);
    if (changes.length === 1 && !changes[0].added && !changes[0].removed) {
      return 'Files are identical.';
    }

    const lines: string[] = [`--- ${abs1}`, `+++ ${abs2}`];
    let lineNum1 = 1;
    let lineNum2 = 1;

    for (const change of changes) {
      const value = change.value.replace(/\n$/, '');
      const changeLines = value ? value.split('\n') : [];

      if (change.added) {
        for (const l of changeLines) {
          lines.push(`+ ${String(lineNum2).padStart(4, ' ')} | ${l}`);
          lineNum2++;
        }
      } else if (change.removed) {
        for (const l of changeLines) {
          lines.push(`- ${String(lineNum1).padStart(4, ' ')} | ${l}`);
          lineNum1++;
        }
      } else {
        for (const l of changeLines) {
          // Only show context lines near changes; skip large unchanged blocks
          lines.push(`  ${String(lineNum1).padStart(4, ' ')} | ${l}`);
          lineNum1++;
          lineNum2++;
        }
      }
    }

    const MAX_LINES = 5000; // ToolResultBuffer handles context protection
    if (lines.length > MAX_LINES + 2) {
      const truncated = lines.slice(0, MAX_LINES);
      truncated.push(`... (truncated, ${lines.length - MAX_LINES - 2} more lines)`);
      return truncated.join('\n');
    }
    return lines.join('\n');
  }
}
