import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';

/**
 * WriteTool — 创建或覆盖文件
 *
 * 参数：
 * - file_path (必需): 文件的绝对路径
 * - content (必需): 要写入的文件内容
 *
 * 自动创建父目录（如果不存在），返回确认信息（文件路径和行数）
 */
export class WriteTool implements Tool {
  readonly name = 'write';
  readonly description =
    'Creates or overwrites a file with the given content. Automatically creates parent directories if they do not exist. Returns confirmation with file path and line count.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'The content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = (args.file_path || args.path) as string;
    const content = args.content as string;
    if (!filePath) return '错误：缺少 file_path 参数。请提供文件的绝对路径，例如 file_path: "/path/to/file.md"。';
    if (content === undefined || content === null) return '错误：缺少 content 参数。请提供要写入的内容。';

    // 自动创建父目录
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // 读旧内容（如果文件存在）
    let oldContent = '';
    try { oldContent = await fs.readFile(filePath, 'utf-8'); } catch {}

    // 写入文件
    await fs.writeFile(filePath, content, 'utf-8');

    // 计算 diff
    try { pushDiff(filePath, computeDiff(oldContent, content, filePath)); } catch {}

    // 计算行数
    const lineCount = content.split('\n').length;

    // 生成内容摘要：前几行 + 总行数，让模型知道自己写了什么
    const lines = content.split('\n');
    const previewLines = lines.slice(0, 5);
    const preview = previewLines.join('\n');
    const truncated = lines.length > 5;

    let result = `Successfully wrote to ${filePath} (${lineCount} lines)`;
    result += `\n--- Content preview ---\n${preview}`;
    if (truncated) {
      result += `\n... (${lines.length - 5} more lines)`;
    }
    result += `\n--- End preview ---`;

    return result;
  }
}
