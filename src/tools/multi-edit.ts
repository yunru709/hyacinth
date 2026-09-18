import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';
import { GlobTool } from './glob.js';
import { getAnyReadTime, recordFileWrite } from './file-tracker.js';
import { refuseEditUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { detectEol, applyEol } from '../utils/eol.js';

export class MultiEditTool implements Tool {
  readonly name = 'multi_edit';
  readonly sideEffect = 'write' as const;
  readonly description =
    '跨多个文件执行搜索替换，通过 glob 模式匹配目标文件。支持 dry_run 预览模式（仅显示变更内容不写入）。默认最多匹配 10 个文件。replace_all=true 时允许单文件内多次替换。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      glob: {
        type: 'string',
        description: 'File matching pattern (e.g., "src/**/*.ts")',
      },
      path: {
        type: 'string',
        description: 'The directory to search in. Defaults to the current working directory.',
      },
      old_string: {
        type: 'string',
        description: 'The text to replace (must match exactly)',
      },
      new_string: {
        type: 'string',
        description: 'The text to replace it with',
      },
      max_files: {
        type: 'number',
        description: 'Maximum number of files to match. Defaults to 10.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview mode — show what would be changed without writing. Defaults to false.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Allow multiple replacements per file. Defaults to false.',
      },
    },
    required: ['glob', 'old_string', 'new_string'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.glob as string;
    const searchPath = (args.path as string | undefined) || process.cwd();
    // 用 let：下面要按各文件的行尾生成适配副本（为何需要适配见 utils/eol.ts 的说明）
    let oldString = args.old_string as string;
    let newString = args.new_string as string;
    const maxFiles = (args.max_files as number | undefined) ?? 10;
    const dryRun = (args.dry_run as boolean | undefined) ?? false;
    const replaceAll = (args.replace_all as boolean | undefined) ?? false;

    const globTool = new GlobTool();
    const globResult = await globTool.execute({ pattern, path: searchPath });

    // GlobTool 无匹配时返回错误串而非路径列表——识别并直接返回，避免把错误文本当文件路径
    if (globResult.trim() === 'No files matched the pattern') {
      return `No files matched the pattern "${pattern}".`;
    }

    const filePaths = globResult
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (filePaths.length === 0) {
      return `No files matched the pattern "${pattern}".`;
    }

    if (filePaths.length > maxFiles) {
      throw new Error(
        `Matched ${filePaths.length} files (${">"} ${maxFiles}). ` +
        `Narrow your glob or increase max_files.`
      );
    }

    type FilePlan = { path: string; matchCount: number };
    const plans: FilePlan[] = [];

    for (const filePath of filePaths) {
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');

        // ── 行尾适配（2026-09-18）──
        // 必须在**匹配计数之前**按本文件行尾适配：否则跨行 old_string 用 LF 去匹配 CRLF
        // 文件会得到 0 匹配，然后在下面 `if (matchCount === 0) continue` 被**静默跳过** ——
        // 表现为"执行成功但文件根本没变"，比明着报错更危险（字节级 E2E 抓出）。
        // applyEol 幂等，故循环到不同行尾的文件也安全。
        const fileEol = detectEol(content);
        oldString = applyEol(oldString, fileEol);
        newString = applyEol(newString, fileEol);
      } catch {
        continue;
      }

      // ── Read-before-write 门控 ──
      // 同 edit：拒绝时交出 old_string 锚点上下文（教学 + 给料），不只是一句错误。
      // 同 edit：完整或部分读过都算（锚定替换不需要全文）
      const lastRead = getAnyReadTime(filePath);
      if (lastRead === null) {
        return refuseEditUnread(filePath, content, oldString, 'unread');
      }
      try {
        const stat = await fs.stat(filePath);
        // 与 write/edit 一致的 50ms 容差：stat.mtimeMs 是高精度（带小数），
        // Date.now() 是整数毫秒，同一毫秒内 read 后 edit 会误判为"外部修改"
        if (stat.mtimeMs > lastRead + 50) {
          return refuseEditUnread(filePath, content, oldString, 'stale');
        }
      } catch {}

      const matchCount = this.countOccurrences(content, oldString);

      if (matchCount === 0) continue;

      if (matchCount > 1 && !replaceAll) {
        const basename = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
        throw new Error(
          `File "${basename}" has ${matchCount} matches. ` +
          `Use replace_all=true to replace all, or narrow your glob scope.`
        );
      }

      plans.push({ path: filePath, matchCount });
    }

    if (plans.length === 0) {
      return `"${oldString}" was not found in any matched file.`;
    }

    if (dryRun) {
      let preview = `Preview — ${plans.length} file${plans.length > 1 ? 's' : ''} would be modified:\n`;
      let totalReplacements = 0;
      for (const plan of plans) {
        const basename = plan.path.replace(/\\/g, '/').split('/').pop() || plan.path;
        preview += `${basename}: ${plan.matchCount} replacement${plan.matchCount > 1 ? 's' : ''}\n`;
        totalReplacements += plan.matchCount;
      }
      preview += `---\nRun without dry_run to apply.`;
      return preview;
    }

    let totalReplacements = 0;
    for (const plan of plans) {
      let content = await fs.readFile(plan.path, 'utf-8');

      // 行尾适配（2026-09-18，同 edit 字符串模式）：调用方给的 old/new_string 通常是 LF，
      // 而目标文件可能是 CRLF。不适配会有两个后果：跨行匹配失败；写回留下裸 LF。
      // 在分支之前适配一次即可覆盖下方两条分支；applyEol 幂等，故循环到不同行尾的文件也安全。
      const planEol = detectEol(content);
      oldString = applyEol(oldString, planEol);
      newString = applyEol(newString, planEol);

      if (replaceAll) {
        content = content.split(oldString).join(newString);
      } else {
        const index = content.indexOf(oldString);
        content =
          content.slice(0, index) + newString + content.slice(index + oldString.length);
      }

      await fs.writeFile(plan.path, content, 'utf-8');
      recordFileWrite(plan.path);
      totalReplacements += plan.matchCount;
    }

    let result = `Modified ${plans.length} file${plans.length > 1 ? 's' : ''} (${totalReplacements} replacement${totalReplacements > 1 ? 's' : ''} total):\n`;
    for (const plan of plans) {
      const basename = plan.path.replace(/\\/g, '/').split('/').pop() || plan.path;
      result += `${basename}: ${plan.matchCount} replacement${plan.matchCount > 1 ? 's' : ''}\n`;
    }

    // ── 自动诊断：修改后运行类型检查/编译检查 ──
    try {
      const diag = await maybeRunDiagnostics(process.cwd());
      if (diag) result += '\n\n' + diag;
    } catch { /* 诊断失败不影响工具返回值 */ }

    return result;
  }

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
