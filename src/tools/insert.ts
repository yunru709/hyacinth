import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';
import { detectEol, applyEol } from '../utils/eol.js';
// 追加/插入是**我们自己**改的文件 ⇒ 必须告知读写门控（否则紧随其后的 edit 会被误判过期 ✗）
import { recordFileTouch } from './file-tracker.js';

/**
 * InsertTool — 在文件指定行号处插入内容。
 * line_number=0 或 "end" = 追加到末尾，line_number=1 = 开头，line_number=N = 第 N 行之前。
 * 配合 grep（查找目标行号）使用。
 */
export class InsertTool implements Tool {
  readonly name = 'insert';
  readonly sideEffect = 'write' as const;
  readonly description =
    '在文件的指定行号位置插入内容。line_number=1 插入到文件开头。line_number=0 或 "end" 追加到文件末尾（无需先读取文件）。行中插入时先用 grep 定位目标行号。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path:   { type: 'string', description: '文件的绝对路径' },
      line_number: { oneOf: [
        { type: 'number', description: '行号（1-based）。0 或 -1 = 追加到末尾。' },
        { type: 'string', enum: ['end'], description: '"end" = 追加到末尾' },
      ]},
      content:     { type: 'string', description: '要插入的内容（可以多行）' },
    },
    required: ['file_path', 'line_number', 'content'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const content  = args.content as string;
    const lineNum  = args.line_number;

    // 末尾追加
    const isAppend = lineNum === 0 || lineNum === -1 || lineNum === 'end';
    if (isAppend) {
      const fh = await fs.open(filePath, 'a');
      await fh.write(content);
      await fh.close();
      recordFileTouch(filePath); // 告知读写门控：这次改动是我们做的（否则紧随其后的 edit 被误判过期 ✗）
      const lines = content.split('\n').length;
      return `Appended ${lines} line(s) to end of ${filePath}`;
    }

    const lineNumber = typeof lineNum === 'string' ? parseInt(lineNum, 10) : (lineNum as number);
    if (isNaN(lineNumber) || lineNumber < 1) {
      throw new Error(`line_number must be ≥ 1 for insertion, or 0/"end" for append. Got: ${lineNum}`);
    }

    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    if (lineNumber > lines.length + 1) {
      throw new Error(
        `line_number ${lineNumber} is out of range. File has ${lines.length} lines. ` +
        `Valid range: 1-${lines.length + 1} (use 0 or "end" to append).`
      );
    }

    const insertLines = content.split('\n');
    lines.splice(lineNumber - 1, 0, ...insertLines);
    // 行尾适配：目标若是 CRLF 文件，插入的 content（LF）以及这里的 `+ '\n'`
    // 都会留下裸 LF。整串按文件原有行尾统一规整一次即可
    // （applyEol 内部先 toLf 折平，因此不会把已有的 \r\n 变成 \r\r\n）。
    await fs.writeFile(filePath, applyEol(lines.join('\n') + '\n', detectEol(text ?? '')), 'utf-8');

    recordFileTouch(filePath); // 同上：改是我们自己做的 ⇒ 别让紧随其后的编辑被判过期
    return `Inserted ${insertLines.length} line(s) at line ${lineNumber} in ${filePath}`;
  }
}
