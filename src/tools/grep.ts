import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

const MAX_FILE_SIZE = 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 2000; // ToolResultBuffer handles context protection

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
        description: 'The regular expression pattern to search for in file contents.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in. REQUIRED — always pass the project root directory (where package.json/tsconfig.json/etc. lives). Searches recursively.',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}"). Only files matching this pattern will be searched.',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
      },
      '-i': {
        type: 'boolean',
        description: 'Case insensitive search. Default: false.',
      },
      '-n': {
        type: 'boolean',
        description: 'Show line numbers in output. Default: true for content mode.',
      },
      '-A': {
        type: 'number',
        description: 'Number of lines to show after each match.',
      },
      '-B': {
        type: 'number',
        description: 'Number of lines to show before each match.',
      },
      '-C': {
        type: 'number',
        description: 'Number of lines to show before and after each match. Shorthand for -A N -B N.',
      },
      head_limit: {
        type: 'number',
        description: 'Limit output to first N lines/entries.',
      },
      multiline: {
        type: 'boolean',
        description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.',
      },
    },
    required: ['pattern', 'path'],
  };

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
    const headLimit = (args.head_limit as number | undefined) ?? DEFAULT_HEAD_LIMIT;
    const multiline = (args.multiline as boolean | undefined) ?? false;

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
      return 'No files matched the search criteria';
    }

    const results: FileMatchResult[] = [];

    for (const relativePath of files) {
      const fullPath = path.join(searchPath, relativePath);

      try {
        const fileStat = await fs.stat(fullPath);
        if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE) continue;
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

  private globToRegex(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/');
    let regexStr = '';
    let i = 0;

    while (i < normalized.length) {
      const c = normalized[i];

      if (c === '*') {
        if (normalized[i + 1] === '*') {
          if (normalized[i + 2] === '/') {
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

    return new RegExp('^' + regexStr + '$');
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
