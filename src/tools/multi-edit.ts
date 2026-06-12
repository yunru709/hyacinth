import { promises as fs } from 'node:fs';
import type { Tool } from './interface.js';
import { GlobTool } from './glob.js';

export class MultiEditTool implements Tool {
  readonly name = 'multi_edit';
  readonly description =
    'Performs search-and-replace across multiple files matching a glob pattern. ' +
    'Supports dry_run preview mode. Default maximum 10 files. ' +
    'Use replace_all=true to allow multiple replacements per file.';
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
      totalReplacements += plan.matchCount;
    }

    let result = `Modified ${plans.length} file${plans.length > 1 ? 's' : ''} (${totalReplacements} replacement${totalReplacements > 1 ? 's' : ''} total):\n`;
    for (const plan of plans) {
      const basename = plan.path.replace(/\\/g, '/').split('/').pop() || plan.path;
      result += `${basename}: ${plan.matchCount} replacement${plan.matchCount > 1 ? 's' : ''}\n`;
    }

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
