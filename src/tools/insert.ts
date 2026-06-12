import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';

/**
 * InsertTool — 在文件指定行号处插入内容。
 * line_number=0 或 "end" = 追加到末尾，line_number=1 = 开头，line_number=N = 第 N 行之前。
 * 配合 grep（查找目标行号）使用。
 */
export class InsertTool implements Tool {
  readonly name = 'insert';
  readonly description =
    'Insert content into a file at a specific line number. ' +
    'line_number=1 inserts at the beginning. line_number=0 or "end" appends to the end (no need to read the file first). ' +
    'Use grep to find the target line number for mid-file insertion.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path:   { type: 'string', description: 'The absolute path to the file' },
      line_number: { oneOf: [
        { type: 'number', description: 'Line number (1-based). 0 or -1 = append to end.' },
        { type: 'string', enum: ['end'], description: '"end" = append to end' },
      ]},
      content:     { type: 'string', description: 'Content to insert (can be multiple lines)' },
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
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf-8');

    return `Inserted ${insertLines.length} line(s) at line ${lineNumber} in ${filePath}`;
  }
}
