import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';   // ← 内联副本使用同步 API（本文件其余部分用 async fs）
import path from 'node:path';   // ← 内联副本使用
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';
import { getLastReadTime, getAnyReadTime, recordFileWrite } from './file-tracker.js';
import { refuseEditUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { detectEol, applyEol } from '../utils/eol.js';

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
  readonly sideEffect = 'write' as const;
  readonly description =
    '精确替换文件中的字符串，或按行号替换。字符串模式：old_string 必须唯一匹配（除非 replace_all=true）。行号模式：line_start 指定起始行（1-based），line_count 指定行数。两种模式互斥。';
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
    // 拒绝时不再只回一句错误，而是**交出 old_string 命中处的上下文**（教学 + 给料，3 轮压到 2 轮）。
    // edit 是锚定替换、改动只落在匹配处，故给出锚点上下文即可放行下一轮（边界见 read-gate.ts）；
    // 若 old_string 根本没命中，这个响应会直接告诉模型"你对这个文件内容的假设是错的"。
    // 门控强度随模式而变（见 read-gate.ts 的安全边界表）：
    //   - 字符串模式：old_string 可自校验（猜错就匹配不上 → 当场拒绝）→ 完整或部分读过都算；
    //   - 行模式（line_start，无锚点）：改动可落在**没看到过的行**上 → 与 write 同等严格，只认完整读过。
    const lastRead = oldString ? getAnyReadTime(filePath) : getLastReadTime(filePath);
    if (lastRead === null) {
      return refuseEditUnread(filePath, content, oldString, 'unread');
    }
    try {
      const stat = await fs.stat(filePath);
      // 注意：stat.mtimeMs 是高精度（带小数），Date.now() 是整数毫秒。
      // 同一毫秒内 read 后 edit 时，mtimeMs 小数部分会让它 > lastRead，误判为"外部修改"。
      // 加 50ms 容差吸收精度差异；真正的并发外部修改通常间隔更久。
      if (stat.mtimeMs > lastRead + 50) {
        return refuseEditUnread(filePath, content, oldString, 'stale');
      }
    } catch {}

    // TODO: 回收站机制 — edit 替换前把旧文件备份到 {sessionDir}/.recycle/{filename}.{timestamp}.bak
    //       当前 session 目录删除时（delete_session / cleanup 过期）回收站自动随 session 一起清掉，无需额外维护。
    //       需先解决 EditTool 获取 sessionDir 的问题（目前没有注入该信息）。

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
      const diag = await maybeRunDiagnostics(process.cwd());
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

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
    // 行模式的行尾处理（第一版想漏了，被字节级 E2E 抓出来）：
    // content 按 '\n' 切分后各行仍带 \r，join('\n') 恰好还原 CRLF —— 但**join 的分隔符本身
    // 也是 LF**，插入的 newString 里面的换行同样不会自动变 CRLF。只适配 newString 内部是不够的
    // （实测结果 "l1\r\nNEW1\r\nNEW2\nl3\r\n"，NEW2 后仍留裸 LF）。
    // 正确做法：拼完之后**整串按文件原有行尾统一规整一次**。applyEol 内部先 toLf 折平，
    // 因此不会把已有的 \r\n 变成 \r\r\n。
    const newContent = applyEol([...before, newString, ...after].join('\n'), detectEol(content));

    await fs.writeFile(filePath, newContent, 'utf-8');
    try {
      pushDiff(filePath, computeDiff(content, newContent, filePath), { before: content, after: newContent });
    } catch {}

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

    // 行尾适配（2026-09-18 实测缺陷）：调用方给的 old/new_string 通常是 LF，
    // 而仓库既有文件是 CRLF。若不适配会有两个后果：
    //   ① 跨行 old_string 用 LF 去匹配 CRLF 文件**必然失败**（报 "not found"）；
    //   ② 写入的 new_string 会在 CRLF 文件里留下裸 LF，制造混合行尾
    //      （实测 src/tools/grep.ts 变成 CRLF=379 / 裸LF=22）。
    // 在分支之前统一把两侧适配成**文件原有行尾**，匹配与写回便自然一致。
    const eol = detectEol(content);
    oldString = applyEol(oldString, eol);
    newString = applyEol(newString, eol);

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
    try {
      pushDiff(filePath, computeDiff(content, newContent, filePath), { before: content, after: newContent });
    } catch {}

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


