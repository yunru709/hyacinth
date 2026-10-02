import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';
import { getToolConfig } from './tool-config.js';
import { detectLang, findEnclosingDecl } from '../utils/code-structure.js';

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export class GrepTool implements Tool {
  readonly name = 'grep';
  readonly description =
    '用正则表达式搜索文件内容（ripgrep）。支持文件类型过滤（glob）、上下文行（-A/-B/-C）、多行模式（multiline）。path 参数必填——始终传入项目根目录。output_mode 可选 content（匹配行）/ files_with_matches（文件路径）/ count（计数）。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '在文件内容中搜索的正则表达式模式。',
      },
      path: {
        type: 'string',
        description: '要搜索的目录或文件。必填 —— 始终传入项目根目录（package.json/tsconfig.json 等所在处）。递归搜索。',
      },
      glob: {
        type: 'string',
        description: '用于过滤文件的 glob 模式（例如 "*.js"、"*.{ts,tsx}"）。只搜索匹配该模式的文件。',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: '输出模式："content" 显示匹配行（支持 -A/-B/-C 上下文、-n 行号、head_limit），"files_with_matches" 显示文件路径（支持 head_limit），"count" 显示匹配计数（支持 head_limit）。默认 "files_with_matches"。',
      },
      '-i': {
        type: 'boolean',
        description: '不区分大小写搜索。默认：false。',
      },
      '-n': {
        type: 'boolean',
        description: '在输出中显示行号。content 模式默认：true。',
      },
      '-A': {
        type: 'number',
        description: '每个匹配之后显示的行数。',
      },
      '-B': {
        type: 'number',
        description: '每个匹配之前显示的行数。',
      },
      '-C': {
        type: 'number',
        description: '每个匹配前后显示的行数。等价于 -A N -B N。',
      },
      head_limit: {
        type: 'number',
        description: '输出限制为前 N 行/条目。',
      },
      multiline: {
        type: 'boolean',
        description: '启用多行模式，此时 . 匹配换行符，模式可以跨行。默认：false。',
      },
      structure: {
        type: 'boolean',
        description: '用纯文本回溯为每个内容匹配标注其最近的所属声明（函数/类/方法）—— 无需索引，永不"过期"。仅影响 output_mode 为 "content" 时。默认：false。',
      },
    },
    required: ['pattern', 'path'],
  };

  /**
   * structure 模式开关。用实例字段而非层层传参 —— formatResults 已有 6 个位置参数，
   * 再加第 7 个会让两处调用点都变吵。execute() 每次进入即赋值，无跨调用残留。
   */
  private structureMode = false;

  async execute(args: Record<string, unknown>): Promise<string> {
    const pattern = args.pattern as string;
    if (!pattern) return '错误：缺少 pattern 参数。请提供正则表达式搜索模式。';
    const searchPath = args.path as string;
    const glob = args.glob as string | undefined;
    const outputMode: GrepOutputMode = (args.output_mode as GrepOutputMode | undefined) ?? 'files_with_matches';
    const caseInsensitive = (args['-i'] as boolean | undefined) ?? false;
    const showLineNumbers = (args['-n'] as boolean | undefined) ?? true;
    const contextAfter = (args['-A'] as number | undefined) ?? (args['-C'] as number | undefined) ?? 0;
    const contextBefore = (args['-B'] as number | undefined) ?? (args['-C'] as number | undefined) ?? 0;
    // ToolResultBuffer handles context protection（tools.grep.headLimit，默认 2000）
    const headLimit = (args.head_limit as number | undefined) ?? getToolConfig('grep.headLimit', 2000);
    const multiline = (args.multiline as boolean | undefined) ?? false;
    this.structureMode = (args.structure as boolean | undefined) ?? false;

    let flags = 'g';
    if (caseInsensitive) flags += 'i';
    if (multiline) flags += 's';

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (err: unknown) {
      throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
    }

    let stat;
    try {
      stat = await fs.stat(searchPath);
    } catch {
      throw new Error(`Path not found: ${searchPath}`);
    }

    if (stat.isFile()) {
      return await this.searchInFile(searchPath, regex, outputMode, showLineNumbers, contextBefore, contextAfter, headLimit);
    }

    if (!stat.isDirectory()) {
      throw new Error(`Path is not a file or directory: ${searchPath}`);
    }

    const allFiles = await this.walkDir(searchPath);
    const files = glob ? allFiles.filter((f) => this.globToRegex(glob).test(f)) : allFiles;

    if (files.length === 0) {
      // 给了 glob 却零命中 ⇒ 几乎总是 glob 写窄/写错，而不是"目录里真的没有"。
      // 明确回报（含扫描到的文件数），别让它长得像正常空结果 —— 静默假绿是老毛病。
      return glob
        ? `No files matched glob "${glob}" under ${searchPath} (scanned ${allFiles.length} file(s)). `
          + 'Note: a glob without "/" matches at any depth ("*.ts" ≙ "**/*.ts"); "{a,b}" alternation is supported.'
        : 'No files matched the search criteria';
    }

    const results: FileMatchResult[] = [];

    for (const relativePath of files) {
      const fullPath = path.join(searchPath, relativePath);

      try {
        const fileStat = await fs.stat(fullPath);
        if (!fileStat.isFile() || fileStat.size > getToolConfig('grep.maxFileSizeBytes', 1024 * 1024)) continue;
      } catch {
        continue;
      }

      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const allLines = content.split('\n');

        const matches: LineMatch[] = [];
        allLines.forEach((line, idx) => {
          let match;
          regex.lastIndex = 0;
          while ((match = regex.exec(line)) !== null) {
            matches.push({
              lineNumber: idx + 1,
              matchIndex: match.index,
              matchLength: match[0].length,
            });
            if (match[0].length === 0) regex.lastIndex++;
          }
        });

        if (matches.length > 0) {
          results.push({ filePath: fullPath, matches, allLines });
        }
      } catch {
        continue;
      }
    }

    return this.formatResults(results, outputMode, showLineNumbers, contextBefore, contextAfter, headLimit);
  }

  private async searchInFile(
    filePath: string,
    regex: RegExp,
    outputMode: GrepOutputMode,
    showLineNumbers: boolean,
    contextBefore: number,
    contextAfter: number,
    headLimit: number,
  ): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const allLines = content.split('\n');

      const matches: LineMatch[] = [];
      allLines.forEach((line, idx) => {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(line)) !== null) {
          matches.push({
            lineNumber: idx + 1,
            matchIndex: match.index,
            matchLength: match[0].length,
          });
          if (match[0].length === 0) regex.lastIndex++;
        }
      });

      if (matches.length === 0) {
        return `No matches found for pattern in ${filePath}`;
      }

      return this.formatResults(
        [{ filePath, matches, allLines }],
        outputMode,
        showLineNumbers,
        contextBefore,
        contextAfter,
        headLimit,
      );
    } catch (err: unknown) {
      throw new Error(`Error searching file ${filePath}: ${(err as Error).message}`);
    }
  }

  private formatResults(
    results: FileMatchResult[],
    outputMode: GrepOutputMode,
    showLineNumbers: boolean,
    contextBefore: number,
    contextAfter: number,
    headLimit: number,
  ): string {
    if (results.length === 0) {
      return 'No matches found';
    }

    if (outputMode === 'count') {
      const lines: string[] = [];
      let entryCount = 0;
      for (const r of results) {
        entryCount++;
        if (entryCount > headLimit) break;
        lines.push(`${r.filePath}:${r.matches.length}`);
      }
      if (results.length > headLimit) {
        lines.push(`... (${results.length - headLimit} more files)`);
      }
      return lines.join('\n');
    }

    if (outputMode === 'files_with_matches') {
      const lines: string[] = [];
      let entryCount = 0;
      for (const r of results) {
        entryCount++;
        if (entryCount > headLimit) break;
        lines.push(r.filePath);
      }
      if (results.length > headLimit) {
        lines.push(`... (${results.length - headLimit} more files)`);
      }
      return lines.join('\n');
    }

    const parts: string[] = [];
    let totalLines = 0;

    for (const result of results) {
      if (totalLines >= headLimit) break;

      const multiFile = results.length > 1;
      if (multiFile) {
        parts.push(`--- ${result.filePath}`);
        totalLines++;
      }

      const seenLines = new Set<number>();
      const maxLineNum = Math.max(...result.matches.map((m) => m.lineNumber + contextAfter));
      const width = String(maxLineNum).length;

      for (const match of result.matches) {
        if (totalLines >= headLimit) break;
        if (seenLines.has(match.lineNumber)) continue;
        seenLines.add(match.lineNumber);

        const startLine = Math.max(1, match.lineNumber - contextBefore);
        const endLine = Math.min(result.allLines.length, match.lineNumber + contextAfter);

        // structure 模式：给这条命中附上"它属于哪个函数/类"。
        // 用纯文本回溯（code-structure.ts），不依赖 xref 索引，因此永远不会"过期"。
        if (this.structureMode) {
          const decl = findEnclosingDecl(result.allLines, match.lineNumber - 1, detectLang(result.filePath));
          parts.push(decl
            ? `  ↳ in ${decl.kind} ${decl.name} (line ${decl.line})`
            : '  ↳ (top level — no enclosing declaration found)');
          totalLines++;
        }

        if (startLine > 1 && contextBefore > 0) {
          parts.push('---');
          totalLines++;
        }

        for (let l = startLine; l <= endLine; l++) {
          if (totalLines >= headLimit) {
            if (parts[parts.length - 1] !== '... (output truncated)') {
              parts.push('... (output truncated)');
            }
            break;
          }

          const lineContent = result.allLines[l - 1] ?? '';
          const prefix = showLineNumbers
            ? `${String(l).padStart(width)}${l === match.lineNumber ? ':' : '-'}`
            : '';

          parts.push(`${prefix}${lineContent}`);
          totalLines++;
        }
      }
    }

    return parts.join('\n');
  }

  private async walkDir(dir: string, basePath: string = ''): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;

      const relativePath = basePath ? path.posix.join(basePath, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
        const subResults = await this.walkDir(fullPath, relativePath);
        results.push(...subResults);
      } else if (entry.isFile()) {
        if (this.isBinaryExtension(entry.name)) continue;
        results.push(relativePath);
      }
    }

    return results;
  }

  private isBinaryExtension(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    const binaryExts = new Set([
      '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
      '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
      '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
      '.ttf', '.otf', '.woff', '.woff2',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx',
      '.pyc', '.class', '.wasm', '.min.js',
    ]);
    return binaryExts.has(ext);
  }

  /**
   * glob → 正则。两条规则（2026-10-02 修正，此前会**静默零命中**）：
   *   1. **不含 '/' 的 glob 按"任意深度"理解**：`*.ts` ≙ `**\/*.ts`。
   *      旧行为编译成 `^[^\/]*\.ts$`，只认顶层文件 ⇒ 对 `src/`（全是嵌套文件）
   *      一律回 "No matches"，长得像正常空结果，实为假绿。
   *   2. **支持 `{a,b}` 花括号展开**（描述里一直宣称支持，实际把 `{`/`}` 当字面量转义了）。
   */
  private globToRegex(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/');
    const scoped = normalized.includes('/') ? normalized : `**/${normalized}`;
    return new RegExp('^' + this.globBodyToRegex(scoped) + '$');
  }

  /** glob 片段 → 正则源码；处理 `**` / `*` / `?` / `{a,b}`（花括号不嵌套） */
  private globBodyToRegex(glob: string): string {
    let regexStr = '';
    let i = 0;

    while (i < glob.length) {
      const c = glob[i];

      if (c === '{') {
        const close = glob.indexOf('}', i + 1);
        if (close === -1) {
          regexStr += '\\{';
          i++;
          continue;
        }
        const alts = glob.slice(i + 1, close).split(',');
        regexStr += '(?:' + alts.map((a) => this.globBodyToRegex(a)).join('|') + ')';
        i = close + 1;
      } else if (c === '*') {
        if (glob[i + 1] === '*') {
          if (glob[i + 2] === '/') {
            regexStr += '(?:.+/)?';
            i += 3;
          } else {
            regexStr += '.*';
            i += 2;
          }
        } else {
          regexStr += '[^/]*';
          i++;
        }
      } else if (c === '?') {
        regexStr += '[^/]';
        i++;
      } else if (c === '/') {
        regexStr += '/';
        i++;
      } else if ('.+^${}()|[]\\'.includes(c)) {
        regexStr += '\\' + c;
        i++;
      } else {
        regexStr += c;
        i++;
      }
    }

    return regexStr;
  }
}

interface LineMatch {
  lineNumber: number;
  matchIndex: number;
  matchLength: number;
}

interface FileMatchResult {
  filePath: string;
  matches: LineMatch[];
  allLines: string[];
}
