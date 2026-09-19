import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';   // ← 内联副本使用同步 API（本文件其余部分用 async fs）
import path from 'node:path';
import type { Tool } from './interface.js';
import { computeDiff } from '../utils/diff.js';
import { pushDiff } from './diff-channel.js';
import { getLastReadTime, recordFileWrite } from './file-tracker.js';
import { refuseWriteUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { adaptEolTo } from '../utils/eol.js';
import { autoReferenceCheck } from './reference-analysis.js';

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
  readonly sideEffect = 'write' as const;
  readonly description =
    '创建或覆盖文件。自动创建不存在的父目录。写入后返回文件路径和行数。';
  readonly companionDescription = '写东西喽。';
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
    if (!filePath) {
      const received = Object.keys(args).filter(k => args[k] !== undefined && args[k] !== null);
      const rawJson = JSON.stringify(args);
      const truncated = rawJson.length > 500 ? rawJson.slice(0, 497) + '...' : rawJson;
      return `错误：缺少 file_path 参数。已收到参数: ${received.length > 0 ? received.join(', ') : '(无)'}。原始输入: ${truncated}。请使用 file_path 提供目标文件的绝对路径，例如 file_path: "/path/to/file.md"。`;
    }
    if (content === undefined || content === null) return '错误：缺少 content 参数。请提供要写入的内容。';

    // 自动创建父目录
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // ── Read-before-write 门控 ──
    let fileExists = false;
    try { await fs.access(filePath); fileExists = true; } catch {}
    if (fileExists) {
      const lastRead = getLastReadTime(filePath);
      if (lastRead === null) {
        // 拒绝覆盖，但**顺手把当前内容交出去**（教学 + 给料，3 轮压到 2 轮）。
        // 安全边界见 read-gate.ts 头部：「交出了多少，才允许往下走多少」——
        // 只有交出全文才算读过；只给片段时仍不放行（否则可能把没看到的中段写没）。
        let cur = '';
        try { cur = await fs.readFile(filePath, 'utf-8'); } catch {}
        return refuseWriteUnread(filePath, cur, 'unread');
      }
      try {
        const stat = await fs.stat(filePath);
        // 注意：stat.mtimeMs 是高精度（带小数），Date.now() 是整数毫秒。
        // 同一毫秒内 read 后 write 时，mtimeMs 小数部分会让它 > lastRead，误判为"外部修改"。
        // 加 50ms 容差吸收精度差异；真正的并发外部修改通常间隔更久。
        if (stat.mtimeMs > lastRead + 50) {
          // 这是**真实的安全信号**（文件被外部改过），不是流程形式 —— 同样把现状交出去
          let cur = '';
          try { cur = await fs.readFile(filePath, 'utf-8'); } catch {}
          return refuseWriteUnread(filePath, cur, 'stale');
        }
      } catch {}
    }

    // 读旧内容（如果文件存在）
    let oldContent = '';
    if (fileExists) {
      try { oldContent = await fs.readFile(filePath, 'utf-8'); } catch {}
    }

    // TODO: 回收站机制 — write 覆盖前把旧文件备份到 {sessionDir}/.recycle/{filename}.{timestamp}.bak
    //       当前 session 目录删除时（delete_session / cleanup 过期）回收站自动随 session 一起清掉，无需额外维护。
    //       需先解决 WriteTool 获取 sessionDir 的问题（目前没有注入该信息）。

    // 写入文件
    // PS 5.1 的 -File 靠 BOM 识别编码：无 BOM 的 UTF-8 脚本会被按 ANSI(GB2312) 解析，
    // 中文串乱码、甚至吞掉闭合引号导致解析期崩溃。脚本类后缀补 BOM。
    // 与 bash.ts 写临时 .ps1 的做法保持一致（那边注释已明确说明该坑）。
    const needsBom = /\.(ps1|psm1|bat|cmd)$/i.test(filePath);
    // 行尾纪律：**覆盖既有文件时适配该文件原有行尾**，避免整份翻成 LF。
    // 仓库既有文件是 CRLF（core.autocrlf=true），而模型给的 content 通常是 LF ——
    // 实测 background-registry.ts 就被这样从 CRLF 毁成纯 LF。新建文件保持 content 原样。
    const body = fileExists && oldContent ? adaptEolTo(content, oldContent) : content;
    await fs.writeFile(filePath, needsBom ? '\uFEFF' + body : body, 'utf-8');

    // 记录写入（写入后自动更新 readTime = writeTime）
    recordFileWrite(filePath);

    // 计算 diff
    try {
      pushDiff(filePath, computeDiff(oldContent, content, filePath), { before: oldContent, after: content });
    } catch {}

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

    // ── 自动诊断：修改后运行类型检查/编译检查 ──
    try {
      const diag = await maybeRunDiagnostics(process.cwd());
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

    // ── 自动引用搜索：覆盖已有文件时搜索变更符号的引用 ──
    if (oldContent) {
      try {
        const ref = autoReferenceCheck(filePath, oldContent, oldContent, content);
        if (ref.text) result += '\n\n' + ref.text;
      } catch { /* 引用搜索失败不影响工具返回值 */ }
    }

    return result;
  }
}



// ─────────────────────────────────────────────────────────────────────
// 仅测试用导出：特征化测试与守卫测试需要直接拿到内联副本的实现。
// **刻意放在上面的标记块之外** —— 否则 write.ts 与 edit.ts 两份块就不再逐字节一致，
// 守卫测试（inlined-copies-sync.test.ts）也就失去意义。
// 这不是给别的工具调用的 API：工具之间不得互相依赖（verify-layers 规则 6）。
// ─────────────────────────────────────────────────────────────────────
export { autoReferenceCheck as __autoReferenceCheckForTest };
