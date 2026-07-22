import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';
import { GlobTool } from './glob.js';
import { getLastReadTime, recordFileWrite } from './file-tracker.js';
import { runDiagnostics } from './diagnostics.js';

export class MultiEditTool implements Tool {
  readonly name = 'multi_edit';
  readonly description =
    '跨多个文件执行搜索替换，通过 glob 模式匹配目标文件。支持 dry_run 预览模式（仅显示变更内容不写入）。默认最多匹配 10 个文件。replace_all=true 时允许单文件内多次替换。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      glob: {
        type: 'string',
        description: 'File matching pattern (e.g., "src/**/*.ts")',
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
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const maxFiles = (args.max_files as number | undefined) ?? 10;
    const dryRun = (args.dry_run as boolean | undefined) ?? false;
    const replaceAll = (args.replace_all as boolean | undefined) ?? false;

    const globTool = new GlobTool();
    const globResult = await globTool.execute({ pattern });

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
      } catch {
        continue;
      }

      // ── Read-before-write 门控 ──
      const lastRead = getLastReadTime(filePath);
      if (lastRead === null) {
        return `Error: You must read "${filePath}" before editing it. Use the read tool first.`;
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > lastRead) {
          return `Error: "${filePath}" has been modified on disk since it was last read. Please re-read it first.`;
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
      const diag = await runDiagnostics(process.cwd(), 15000);
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
