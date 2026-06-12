import fs from 'node:fs/promises';

export interface FunctionDef {
  name: string;
  file: string;
  line: number;
  kind: 'function' | 'method' | 'arrow' | 'class' | 'interface' | 'type';
  signature: string;
  isAsync: boolean;
  isExported: boolean;
}

export interface CallSite {
  name: string;
  file: string;
  line: number;
  text: string;
  receiver?: string;
  isNew: boolean;
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'class', 'function', 'const',
  'let', 'var', 'import', 'export', 'from', 'as', 'type', 'interface', 'extends',
  'implements', 'new', 'typeof', 'instanceof', 'void', 'delete', 'in', 'of',
  'async', 'await', 'yield', 'static', 'get', 'set', 'public', 'private',
  'protected', 'readonly', 'abstract', 'override', 'declare', 'module',
  'require', 'console', 'process', 'Math', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set', 'Error',
  'true', 'false', 'null', 'undefined', 'this', 'super',
]);

export class FunctionParser {
  async findDefinitions(symbol: string, files: string[]): Promise<FunctionDef[]> {
    const results: FunctionDef[] = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const def = this.parseLineForDefinition(lines[i], file, i + 1);
          if (def && def.name === symbol) {
            results.push(def);
          }
        }
      } catch {
        // skip unreadable files
      }
    }
    return results;
  }

  async findCallees(functionName: string, file: string): Promise<CallSite[]> {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');

      let startLine = -1;
      for (let i = 0; i < lines.length; i++) {
        const def = this.parseLineForDefinition(lines[i], file, i + 1);
        if (def && def.name === functionName) {
          startLine = i;
          break;
        }
      }

      if (startLine === -1) return [];

      const block = this.extractBlock(lines, startLine);
      if (!block) return [];

      const calls: CallSite[] = [];
      const seen = new Set<string>();

      for (let i = block.startLine; i <= block.endLine; i++) {
        const lineCalls = this.parseLineForCalls(lines[i], file, i + 1);
        for (const call of lineCalls) {
          const key = `${call.name}:${call.line}`;
          if (!seen.has(key)) {
            seen.add(key);
            calls.push(call);
          }
        }
      }

      return calls;
    } catch {
      return [];
    }
  }

  async findFunctionBodyRange(functionName: string, file: string): Promise<{ startLine: number; endLine: number } | null> {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const def = this.parseLineForDefinition(lines[i], file, i + 1);
        if (def && def.name === functionName) {
          return this.extractBlock(lines, i);
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private parseLineForDefinition(line: string, file: string, lineNum: number): FunctionDef | null {
    let match: RegExpMatchArray | null;

    match = line.match(/^(export\s+)?(async\s+)?function\s+(\w+)/);
    if (match) {
      return {
        name: match[3],
        file,
        line: lineNum,
        kind: 'function',
        signature: line.trim(),
        isAsync: !!match[2],
        isExported: !!match[1],
      };
    }

    match = line.match(/^(export\s+)?(abstract\s+)?class\s+(\w+)/);
    if (match) {
      return {
        name: match[3],
        file,
        line: lineNum,
        kind: 'class',
        signature: line.trim(),
        isAsync: false,
        isExported: !!match[1],
      };
    }

    match = line.match(/^(export\s+)?interface\s+(\w+)/);
    if (match) {
      return {
        name: match[2],
        file,
        line: lineNum,
        kind: 'interface',
        signature: line.trim(),
        isAsync: false,
        isExported: !!match[1],
      };
    }

    match = line.match(/^(export\s+)?type\s+(\w+)/);
    if (match) {
      return {
        name: match[2],
        file,
        line: lineNum,
        kind: 'type',
        signature: line.trim(),
        isAsync: false,
        isExported: !!match[1],
      };
    }

    match = line.match(/^(export\s+)?(const|let|var)\s+(\w+)[^=]*=\s*(async\s+)?(?:function\b|\([^)]*\)\s*=>)/);
    if (match) {
      return {
        name: match[3],
        file,
        line: lineNum,
        kind: 'arrow',
        signature: line.trim(),
        isAsync: !!match[4],
        isExported: !!match[1],
      };
    }

    match = line.match(/^\s+(?:(?:public|private|protected|static|async|abstract|override|readonly)\s+)+(\w+)\s*[<(]/);
    if (match && !KEYWORDS.has(match[1])) {
      return {
        name: match[1],
        file,
        line: lineNum,
        kind: 'method',
        signature: line.trim(),
        isAsync: /\basync\b/.test(line),
        isExported: false,
      };
    }

    return null;
  }

  extractBlock(lines: string[], startLine: number): { startLine: number; endLine: number } | null {
    let braceLine = -1;
    let braceCol = -1;

    for (let i = startLine; i < lines.length && i <= startLine + 5; i++) {
      const col = this.findFirstBrace(lines[i], i === startLine ? 0 : 0);
      if (col !== -1) {
        braceLine = i;
        braceCol = col;
        break;
      }
    }

    if (braceCol === -1) return null;

    let depth = 0;
    let inString: string | null = null;
    let inTemplate = false;

    for (let i = braceLine; i < lines.length; i++) {
      const line = lines[i];
      const startCol = (i === braceLine) ? braceCol : 0;

      for (let j = startCol; j < line.length; j++) {
        const ch = line[j];
        const next = line[j + 1];

        if (inString) {
          if (ch === '\\') { j++; continue; }
          if (inTemplate && ch === '$' && next === '{') { depth++; j++; continue; }
          if (ch === inString) {
            if (inTemplate && ch === '`') inTemplate = false;
            inString = null;
          }
          continue;
        }

        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') { j = this.skipBlockComment(line, j + 1) - 1; continue; }

        if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
          if (ch === '`') inTemplate = true;
          continue;
        }

        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) return { startLine: braceLine, endLine: i };
        }
      }
    }

    return null;
  }

  private findFirstBrace(line: string, startCol: number): number {
    let inString: string | null = null;
    for (let j = startCol; j < line.length; j++) {
      const ch = line[j];
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
      if (ch === '/' && line[j + 1] === '/') return -1;
      if (ch === '{') return j;
    }
    return -1;
  }

  private skipBlockComment(line: string, start: number): number {
    for (let j = start; j < line.length - 1; j++) {
      if (line[j] === '*' && line[j + 1] === '/') return j + 2;
    }
    return line.length;
  }

  private parseLineForCalls(line: string, file: string, lineNum: number): CallSite[] {
    const calls: CallSite[] = [];
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return calls;
    if (/^(export\s+)?(async\s+)?function\s+\w/.test(trimmed)) return calls;
    if (/^(export\s+)?(abstract\s+)?class\s+\w/.test(trimmed)) return calls;

    const callRegex = /(?:(\w+)\.)?(\w+)\s*\(/g;
    let match;
    while ((match = callRegex.exec(line)) !== null) {
      const receiver = match[1];
      const name = match[2];
      if (KEYWORDS.has(name)) continue;
      if (receiver && KEYWORDS.has(receiver)) continue;
      calls.push({
        name,
        file,
        line: lineNum,
        text: trimmed,
        receiver: receiver || undefined,
        isNew: false,
      });
    }

    const newRegex = /new\s+(\w+)\s*[\(<]/g;
    while ((match = newRegex.exec(line)) !== null) {
      if (KEYWORDS.has(match[1])) continue;
      calls.push({
        name: match[1],
        file,
        line: lineNum,
        text: trimmed,
        isNew: true,
      });
    }

    return calls;
  }
}
