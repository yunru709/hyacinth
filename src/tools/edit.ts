import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';
import { getLastReadTime, recordFileWrite } from './file-tracker.js';
import { runDiagnostics } from './diagnostics.js';
import { autoReferenceCheck } from './symbol-references.js';

/**
 * EditTool — 在文件中精确替换匹配的字符串 或 按行号替换
 *
 * 支持两种模式（互斥）：
 *
 * 模式一：字符串替换（原有逻辑）
 * - old_string (必需): 要被替换的字符串
 * - new_string (必需): 替换后的字符串
 * - replace_all (可选): 是否替换所有匹配，默认 false
 *
 * 模式二：行号替换（新增）
 * - line_start (必需): 替换起始行号 (1-based)
 * - line_count (可选): 替换行数，默认 1
 * - new_string (必需): 替换后的内容
 */
export class EditTool implements Tool {
  readonly name = 'edit';
  readonly description =
    'Performs exact string replacements in a file (' +
    'old_string must uniquely match unless replace_all=true), ' +
    'or replaces lines by line number using line_start/line_count. ' +
    'line_start and old_string are mutually exclusive.';
  readonly companionDescription = '得改一下了。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The text to replace (must match exactly). Mutually exclusive with line_start.',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences of old_string. Defaults to false.',
      },
      line_start: {
        type: 'number',
        description: 'Starting line number for replacement (1-based). Mutually exclusive with old_string.',
      },
      line_count: {
        type: 'number',
        description: 'Number of lines to replace. Defaults to 1.',
      },
    },
    required: ['file_path', 'new_string'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const newString = args.new_string as string;
    const lineStart = args.line_start as number | undefined;
    const oldString = args.old_string as string | undefined;

    if (!filePath) return '错误：缺少 file_path 参数。请提供文件的绝对路径。';
    if (newString === undefined || newString === null) return '错误：缺少 new_string 参数。请提供替换后的内容。';
    if (lineStart === undefined && oldString === undefined) return '错误：请提供 line_start（按行编辑）或 old_string（字符串替换）。';
    if (lineStart !== undefined && lineStart < 1) return '错误：line_start 必须 >= 1。';

    if (lineStart !== undefined && oldString !== undefined) {
      throw new Error(
        'line_start and old_string are mutually exclusive. Use one mode or the other.'
      );
    }

    // 拒绝编辑图片文件
    const IMG_SIGS = [
      [0xFF, 0xD8],                    // JPEG
      [0x89, 0x50, 0x4E, 0x47],       // PNG
      [0x47, 0x49, 0x46],             // GIF
      [0x42, 0x4D],                    // BMP
      [0x52, 0x49, 0x46, 0x46],       // WEBP (RIFF)
    ];
    try {
      const fh = await fs.open(filePath, 'r');
      const sniff = Buffer.alloc(12);
      await fh.read(sniff, 0, 12, 0);
      await fh.close();
      for (const sig of IMG_SIGS) {
        if (sig.every((b, i) => sniff[i] === b)) {
          return `Error: Cannot edit image files (${filePath}). Use specialized image tools instead.`;
        }
      }
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    // ── Read-before-write 门控 ──
    const lastRead = getLastReadTime(filePath);
    if (lastRead === null) {
      return 'Error: You must read the file before editing it. Use the read tool first.';
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > lastRead) {
        return 'Error: File has been modified on disk since it was last read. Please re-read it first.';
      }
    } catch {}

    let result: string;
    if (lineStart !== undefined) {
      result = await this.executeLineReplace(filePath, content, newString, lineStart, args);
    } else {
      result = await this.executeStringReplace(filePath, content, oldString!, newString, args);
    }

    // 记录写入
    recordFileWrite(filePath);

    // ── 自动诊断：修改后运行类型检查/编译检查 ──
    try {
      const diag = await runDiagnostics(process.cwd(), 15000);
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

    // ── 自动引用搜索：提取变更符号 → 项目内搜索引用 ──
    try {
      const effectiveOld = oldString ?? (() => {
        const ls = (args.line_start as number) ?? 1;
        const lc = (args.line_count as number) ?? 1;
        return content.split('\n').slice(ls - 1, ls - 1 + lc).join('\n');
      })();
      const ref = autoReferenceCheck(filePath, content, effectiveOld, newString);
      if (ref.text) result += '\n\n' + ref.text;
    } catch { /* 引用搜索失败不影响工具返回值 */ }

    return result;
  }

  private async executeLineReplace(
    filePath: string,
    content: string,
    newString: string,
    lineStart: number,
    args: Record<string, unknown>,
  ): Promise<string> {
    const lineCount = (args.line_count as number | undefined) ?? 1;
    const lines = content.split('\n');
    const start = lineStart - 1;

    if (start < 0 || start >= lines.length) {
      throw new Error(
        `line_start ${lineStart} is out of range. File has ${lines.length} lines.`
      );
    }

    if (lineCount < 1) {
      throw new Error('line_count must be at least 1.');
    }

    const end = Math.min(start + lineCount, lines.length);
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    const newContent = [...before, newString, ...after].join('\n');

    await fs.writeFile(filePath, newContent, 'utf-8');
    try { pushDiff(filePath, computeDiff(content, newContent, filePath)); } catch {}

    const replaced = end - start;
    // 生成变更摘要：显示替换后的内容
    const newLines = newString.split('\n');
    const previewLines = newLines.slice(0, 5);
    const preview = previewLines.join('\n');
    const truncated = newLines.length > 5;

    let result = `Successfully edited ${filePath} (replaced ${replaced} line${replaced > 1 ? 's' : ''} starting at line ${lineStart})`;
    result += `\n--- New content preview ---\n${preview}`;
    if (truncated) {
      result += `\n... (${newLines.length - 5} more lines)`;
    }
    result += `\n--- End preview ---`;
    return result;
  }

  private async executeStringReplace(
    filePath: string,
    content: string,
    oldString: string,
    newString: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const replaceAll = (args.replace_all as boolean | undefined) ?? false;

    const matchCount = this.countOccurrences(content, oldString);

    if (matchCount === 0) {
      throw new Error(
        `String not found in file: ${filePath}\n` +
        `The old_string was not found. Make sure the string matches exactly, including whitespace and indentation.`
      );
    }

    if (matchCount > 1 && !replaceAll) {
      throw new Error(
        `Multiple matches found (${matchCount} occurrences) in file: ${filePath}\n` +
        `Use replace_all=true to replace all occurrences, or provide a larger old_string that uniquely identifies the target.`
      );
    }

    let newContent: string;
    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
    } else {
      const index = content.indexOf(oldString);
      newContent =
        content.slice(0, index) + newString + content.slice(index + oldString.length);
    }

    await fs.writeFile(filePath, newContent, 'utf-8');
    try { pushDiff(filePath, computeDiff(content, newContent, filePath)); } catch {}

    const replacementCount = replaceAll ? matchCount : 1;
    // 生成变更摘要：显示 old_string 和 new_string 的对比
    const oldPreview = oldString.split('\n').slice(0, 3).join('\n');
    const newPreview = newString.split('\n').slice(0, 3).join('\n');
    const oldTruncated = oldString.split('\n').length > 3;
    const newTruncated = newString.split('\n').length > 3;

    let result = `Successfully edited ${filePath} (${replacementCount} replacement${replacementCount > 1 ? 's' : ''})`;
    result += `\n--- Replaced ---\n${oldPreview}`;
    if (oldTruncated) result += '\n...';
    result += `\n--- With ---\n${newPreview}`;
    if (newTruncated) result += '\n...';
    result += '\n--- End diff ---';
    return result;
  }

  /**
   * 统计字符串在文本中出现的次数
   */
  private countOccurrences(text: string, search: string): number {
    if (search.length === 0) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(search, pos)) !== -1) {
      count++;
      pos += search.length;
    }
    return count;
  }
}
