import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';
import { getAnyReadTime, recordFileWrite } from './file-tracker.js';
import { refuseEditUnread } from './read-gate.js';
import { maybeRunDiagnostics } from './diagnostics.js';
import { detectEol, applyEol } from '../utils/eol.js';

// ── 目录遍历 + glob 匹配（**有意内联复制自 glob.ts**，2026-09-19）──────────────
// 为什么不 import GlobTool、也不抽公共模块：工具是动态的、会一个一个地变动，
// 每个工具应当是**独立个体**（用户立的架构原则）。抽共享模块同样是耦合（改它影响两个），
// 而"重复"的代价（修 bug 要改两处）在工具粒度上被判定为可接受。
// 附带收益：原实现要 `new GlobTool()` 再**字符串比对它的返回值**
// （`globResult.trim() === 'No files matched the pattern'`）—— GlobTool 改一句提示语，
// multi_edit 就静默失效；内联后这个脆弱点消失。
// ⚠️ 维护者：**不要**为了"消除重复"把它们再合并回去 —— 见 verify-layers 规则 6。

/** 递归遍历目录，返回相对 posix 路径 */
async function walkDir(dir: string, basePath = ''): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const relativePath = basePath ? path.posix.join(basePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await walkDir(path.join(dir, entry.name), relativePath)));
    } else if (entry.isFile()) {
      results.push(relativePath);
    }
  }
  return results;
}

/** glob 模式 → 正则表达式（支持 `**`、`*`、`?`） */
function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let regex = '';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i]!;
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') { regex += '(?:[^/]*/)*'; i += 3; }  // **/ 匹配零或多层
        else { regex += '.*'; i += 2; }                                     // ** 含分隔符
      } else { regex += '[^/]*'; i++; }                                     // * 单层内
    } else if (c === '?') { regex += '[^/]'; i++; }
    else if (c === '/') { regex += '/'; i++; }
    else if ('.+^${}()|[]\\'.includes(c)) { regex += '\\' + c; i++; }        // 转义正则特殊字符
    else { regex += c; i++; }
  }
  return new RegExp('^' + regex + '$');
}

/**
 * 按 glob 模式匹配 root 下的文件，返回**绝对路径**。
 * 路径不存在时抛错（与内联前由 glob.ts 抛 "Directory not found" 的行为一致）。
 *
 * 注：**不做 mtime 排序**。排序只在"命中数超过上限"时才有意义决定留哪几个，
 * 而本工具一旦超过 max_files 就直接抛错（见 execute），故排序无实际作用 ——
 * 省掉对全部命中文件的一次 stat。
 */
async function matchFiles(pattern: string, root: string): Promise<string[]> {
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) throw new Error(`Path is not a directory: ${root}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Path is not a directory')) throw err;
    throw new Error(`Directory not found: ${root}`);
  }
  const regex = globToRegex(pattern);
  const matched = (await walkDir(root)).filter((f) => regex.test(f));
  return matched.map((rel) => path.join(root, rel));
}

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

    // 内联的目录遍历 + glob 匹配（**有意不依赖 GlobTool**，见文件末尾 helpers 的说明）
    const filePaths = await matchFiles(pattern, searchPath);

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
