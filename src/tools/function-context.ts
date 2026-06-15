import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Tool } from './interface.js';

interface FunctionRange {
  name: string;
  startLine: number;
  endLine: number;
  code: string;
}

export class FunctionContextTool implements Tool {
  readonly name = 'function_context';
  readonly description =
    'Return the full source code of functions/methods referencing a symbol. Use instead of reading the entire file.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file',
      },
      symbol: {
        type: 'string',
        description: 'The variable/function name to search for',
      },
    },
    required: ['file_path', 'symbol'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const symbol = args.symbol as string;

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();

    const { findFunctions, type: langType } = this.getParser(ext);
    if (!findFunctions) {
      throw new Error(
        `Unsupported file type: ${ext}. ` +
        `Supported types: .ts, .tsx, .js, .jsx, .py, .go, .rs, .c, .h, .java`
      );
    }

    const lines = content.split('\n');
    const hitLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(symbol)) {
        hitLines.push(i);
      }
    }

    if (hitLines.length === 0) {
      return `No functions referencing "${symbol}" found in ${path.basename(filePath)}.`;
    }

    const functions = findFunctions(lines, hitLines, langType);
    const totalLines = lines.length;

    if (functions.length === 0) {
      return `No functions referencing "${symbol}" found in ${path.basename(filePath)}.`;
    }

    let output = `Found ${functions.length} function${functions.length > 1 ? 's' : ''} in ${path.basename(filePath)} referencing "${symbol}":\n\n`;

    let totalFunctionLines = 0;
    for (const fn of functions) {
      const lineRange = fn.startLine === fn.endLine
        ? `${fn.startLine}`
        : `${fn.startLine}-${fn.endLine}`;
      output += `── ${fn.name} (${path.basename(filePath)}:${lineRange}) ──\n`;

      for (let i = fn.startLine - 1; i < fn.endLine; i++) {
        const lineNum = i + 1;
        const pad = String(lineNum).padStart(String(fn.endLine).length, ' ');
        output += `${pad}: ${lines[i]}\n`;
      }
      output += '\n';

      totalFunctionLines += fn.endLine - fn.startLine + 1;
    }

    output += `(${functions.length} function${functions.length > 1 ? 's' : ''}, ${totalFunctionLines} lines total; file has ${totalLines} lines)`;

    return output;
  }

  private getParser(ext: string): {
    findFunctions: ((lines: string[], hitLines: number[], langType: string) => FunctionRange[]) | null;
    type: string;
  } {
    switch (ext) {
      case '.ts':
      case '.tsx':
        return { findFunctions: this.findBracketFunctions, type: 'ts' };
      case '.js':
      case '.jsx':
        return { findFunctions: this.findBracketFunctions, type: 'js' };
      case '.py':
        return { findFunctions: this.findPythonFunctions, type: 'py' };
      case '.go':
        return { findFunctions: this.findBracketFunctions, type: 'go' };
      case '.rs':
        return { findFunctions: this.findBracketFunctions, type: 'rs' };
      case '.c':
      case '.h':
        return { findFunctions: this.findBracketFunctions, type: 'c' };
      case '.java':
        return { findFunctions: this.findBracketFunctions, type: 'java' };
      default:
        return { findFunctions: null, type: '' };
    }
  }

  private getFunctionHeaderRegex(langType: string): RegExp {
    switch (langType) {
      case 'ts':
      case 'js':
        return /(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|[\w$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|[\w$]+\s*\([^)]*\)\s*\{)/;
      case 'go':
        return /func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?\w+/;
      case 'rs':
        return /(?:pub\s+)?(?:async\s+)?fn\s+\w+/;
      case 'c':
        return /\w+\s+\w+\s*\([^)]*\)\s*\{/;
      case 'java':
        return /(?:public|private|protected)\s+(?:static\s+)?\w+\s+\w+\s*\(/;
      default:
        return /^$/;
    }
  }

  private extractFunctionName(headerLine: string, langType: string): string {
    switch (langType) {
      case 'ts':
      case 'js': {
        const match = headerLine.match(/(?:function\s+(\w+)|const\s+(\w+)|(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*\([^)]*\)\s*\{)/);
        return match?.[1] || match?.[2] || match?.[3] || match?.[4] || 'anonymous';
      }
      case 'go': {
        const match = headerLine.match(/func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?(\w+)/);
        return match?.[1] || 'anonymous';
      }
      case 'rs': {
        const match = headerLine.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
        return match?.[1] || 'anonymous';
      }
      case 'c': {
        const match = headerLine.match(/\w+\s+(\w+)\s*\(/);
        return match?.[1] || 'anonymous';
      }
      case 'java': {
        const match = headerLine.match(/(?:public|private|protected)\s+(?:static\s+)?\w+\s+(\w+)\s*\(/);
        return match?.[1] || 'anonymous';
      }
      default:
        return 'anonymous';
    }
  }

  private findBracketFunctions(lines: string[], hitLines: number[], langType: string): FunctionRange[] {
    const headerRegex = this.getFunctionHeaderRegex(langType);
    const results: FunctionRange[] = [];
    const processedHits = new Set<number>();

    for (const hitLineIdx of hitLines) {
      if (processedHits.has(hitLineIdx)) continue;

      let headerLineIdx = -1;
      for (let i = hitLineIdx; i >= 0; i--) {
        if (headerRegex.test(lines[i])) {
          headerLineIdx = i;
          break;
        }
      }

      if (headerLineIdx === -1) continue;

      const headerLine = lines[headerLineIdx];

      let bracePos = headerLine.indexOf('{');
      if (bracePos === -1) {
        bracePos = headerLine.length - 1;
      }

      let depth = 0;
      let started = false;
      let endLineIdx = headerLineIdx;

      for (let i = headerLineIdx; i < lines.length; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
          if (line[j] === '"' || line[j] === "'" || line[j] === '`') {
            const quote = line[j];
            j++;
            while (j < line.length && line[j] !== quote) {
              if (line[j] === '\\') j++;
              j++;
            }
            continue;
          }

          if (line[j] === '{') {
            depth++;
            started = true;
          } else if (line[j] === '}') {
            depth--;
          }
        }

        if (started && depth === 0) {
          endLineIdx = i;
          break;
        }

        if (i === lines.length - 1) {
          endLineIdx = i;
        }
      }

      const funcName = this.extractFunctionName(headerLine, langType);

      const code = lines.slice(headerLineIdx, endLineIdx + 1).join('\n');

      for (let i = headerLineIdx; i <= endLineIdx; i++) {
        if (hitLines.includes(i)) {
          processedHits.add(i);
        }
      }

      if (!results.some(r => r.startLine === headerLineIdx + 1)) {
        results.push({
          name: funcName,
          startLine: headerLineIdx + 1,
          endLine: endLineIdx + 1,
          code,
        });
      }
    }

    return results;
  }

  private findPythonFunctions(lines: string[], hitLines: number[], _langType: string): FunctionRange[] {
    const results: FunctionRange[] = [];
    const processedHits = new Set<number>();

    for (const hitLineIdx of hitLines) {
      if (processedHits.has(hitLineIdx)) continue;

      let headerLineIdx = -1;
      for (let i = hitLineIdx; i >= 0; i--) {
        if (/(?:async\s+)?def\s/.test(lines[i])) {
          headerLineIdx = i;
          break;
        }
      }

      if (headerLineIdx === -1) continue;

      const headerMatch = lines[headerLineIdx].match(/(?:async\s+)?def\s+(\w+)/);
      const funcName = headerMatch?.[1] || 'anonymous';

      let bodyLineIdx = headerLineIdx + 1;
      while (bodyLineIdx < lines.length && lines[bodyLineIdx].trim() === '') {
        bodyLineIdx++;
      }

      if (bodyLineIdx >= lines.length) {
        if (!results.some(r => r.startLine === headerLineIdx + 1)) {
          results.push({
            name: funcName,
            startLine: headerLineIdx + 1,
            endLine: headerLineIdx + 1,
            code: lines[headerLineIdx],
          });
        }
        continue;
      }

      const indentLevel = lines[bodyLineIdx].length - lines[bodyLineIdx].trimStart().length;
      let endLineIdx = bodyLineIdx;

      for (let i = bodyLineIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed === '') continue;

        const currentIndent = lines[i].length - lines[i].trimStart().length;
        if (currentIndent <= indentLevel) {
          endLineIdx = i - 1;
          break;
        }
        endLineIdx = i;
      }

      if (endLineIdx < bodyLineIdx) endLineIdx = bodyLineIdx;

      for (let i = headerLineIdx; i <= endLineIdx; i++) {
        if (hitLines.includes(i)) {
          processedHits.add(i);
        }
      }

      if (!results.some(r => r.startLine === headerLineIdx + 1)) {
        results.push({
          name: funcName,
          startLine: headerLineIdx + 1,
          endLine: endLineIdx + 1,
          code: lines.slice(headerLineIdx, endLineIdx + 1).join('\n'),
        });
      }
    }

    return results;
  }
}
