/**
 * 正则回退解析器 — 当 TypeScript 编译器 API 不可用时使用。
 *
 * 覆盖：
 *   - TsRegexParser: TypeScript/JavaScript (正则版)
 *   - PyParser:       Python
 *   - GenericParser:  通用括号匹配（C/Go/Rust/Java 等）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileParser } from './parser.js';
import type { ParsedFile, ParsedSymbol, ParsedRef, ParsedImport } from './schema.js';

// ── 通用工具 ──────────────────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'typeof', 'instanceof',
  'void', 'delete', 'in', 'of', 'async', 'await', 'yield', 'static', 'get', 'set',
  'import', 'export', 'from', 'as', 'class', 'function', 'const', 'let', 'var',
  'interface', 'type', 'extends', 'implements', 'abstract', 'override',
  'public', 'private', 'protected', 'readonly', 'declare',
  'true', 'false', 'null', 'undefined', 'this', 'super',
  'console', 'require', 'process', 'global',
  'parseInt', 'parseFloat', 'isNaN', 'JSON', 'Math',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set',
  'Error', 'Date', 'RegExp', 'Symbol', 'parseInt', 'setTimeout', 'setInterval',
]);

function isKeyword(name: string): boolean {
  return JS_KEYWORDS.has(name) || name.length <= 1;
}

// ── TsRegexParser: TS/JS 正则回退 ─────────────────────────────────────

export class TsRegexParser implements FileParser {
  readonly name = 'ts-regex';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();

    const symbols: ParsedSymbol[] = [];
    const refs: ParsedRef[] = [];
    const imports: ParsedImport[] = [];

    // ── 解析 import 语句 ──
    const importRegex = /import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
    for (const m of content.matchAll(importRegex)) {
      const modulePath = m[4];
      const syms: string[] = [];
      if (m[1]) syms.push(...m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
      if (m[2]) syms.push(m[2]);
      if (m[3]) syms.push(m[3]);
      if (modulePath.startsWith('.')) {
        imports.push({ to_path: modulePath, symbols: syms, import_type: 'static' });
      }
    }
    // require
    const requireRegex = /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of content.matchAll(requireRegex)) {
      const modulePath = m[3];
      const syms: string[] = [];
      if (m[1]) syms.push(...m[1].split(',').map(s => s.trim()).filter(Boolean));
      if (m[2]) syms.push(m[2]);
      if (modulePath.startsWith('.')) {
        imports.push({ to_path: modulePath, symbols: syms, import_type: 'require' });
      }
    }

    // ── 解析函数/类/变量定义 ──
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const trimmed = line.trim();

      // export function / async function / function
      let m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (m) {
        symbols.push({
          name: m[1], kind: 'function', line: lineNum, col: line.indexOf(m[1]),
          signature: trimmed, is_exported: trimmed.startsWith('export'),
        });
        continue;
      }

      // export class / class
      m = trimmed.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (m) {
        const extendsMatch = trimmed.match(/extends\s+([\w.,\s]+?)(?:\s*\{|\s*$)/);
        symbols.push({
          name: m[1], kind: 'class', line: lineNum, col: line.indexOf(m[1]),
          signature: trimmed, is_exported: trimmed.startsWith('export'),
        });
        if (extendsMatch) {
          for (const parent of extendsMatch[1].split(',')) {
            const pName = parent.trim();
            if (pName) refs.push({ symbol_name: pName, line: lineNum, col: line.indexOf(pName), kind: 'inherit', context: trimmed });
          }
        }
        continue;
      }

      // export interface
      m = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (m) {
        symbols.push({
          name: m[1], kind: 'interface', line: lineNum, col: line.indexOf(m[1]),
          signature: trimmed, is_exported: trimmed.startsWith('export'),
        });
        continue;
      }

      // export type
      m = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
      if (m) {
        symbols.push({
          name: m[1], kind: 'type', line: lineNum, col: line.indexOf(m[1]),
          signature: trimmed, is_exported: trimmed.startsWith('export'),
        });
        continue;
      }

      // export enum
      m = trimmed.match(/^(?:export\s+)?enum\s+(\w+)/);
      if (m) {
        symbols.push({
          name: m[1], kind: 'enum', line: lineNum, col: line.indexOf(m[1]),
          signature: trimmed, is_exported: trimmed.startsWith('export'),
        });
        continue;
      }

      // const/let/var with arrow function or function expression
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/);
      if (m) {
        const isArrow = /(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|=\s*(?:async\s+)?function\b)/.test(trimmed);
        const isExported = trimmed.startsWith('export');
        symbols.push({
          name: m[1],
          kind: isArrow ? 'arrow' : 'variable',
          line: lineNum,
          col: line.indexOf(m[1]),
          signature: trimmed,
          is_exported: isExported,
        });
        continue;
      }
    }

    // ── 解析调用引用 ──
    const callRegex = /(?:(\w+)\.)?(\w+)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*|\/\*|import|export)/.test(line.trim())) continue;
      for (const cm of line.matchAll(callRegex)) {
        const name = cm[2];
        if (isKeyword(name)) continue;
        refs.push({
          symbol_name: name,
          line: i + 1,
          col: cm.index ?? 0,
          kind: 'call',
          context: line.trim().slice(0, 120),
        });
      }
      // new expressions
      for (const nm of line.matchAll(/new\s+(\w+)/g)) {
        if (!isKeyword(nm[1])) {
          refs.push({
            symbol_name: nm[1],
            line: i + 1,
            col: nm.index ?? 0,
            kind: 'new',
            context: line.trim().slice(0, 120),
          });
        }
      }
    }

    return {
      path: filePath,
      language: ext === '.ts' || ext === '.tsx' ? 'typescript' : 'javascript',
      symbols, refs, imports, hash,
    };
  }
}

// ── PyParser: Python 正则解析 ─────────────────────────────────────────

export class PyParser implements FileParser {
  readonly name = 'py-regex';
  readonly extensions = ['.py', '.pyi', '.pyx'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    const lines = content.split('\n');

    const symbols: ParsedSymbol[] = [];
    const refs: ParsedRef[] = [];
    const imports: ParsedImport[] = [];

    // ── import 语句 ──
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // from .xxx import yyy
      let m = trimmed.match(/^from\s+(\.\S+)\s+import\s+(.+)/);
      if (m) {
        const toPath = m[1];
        const syms = m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        imports.push({ to_path: toPath, symbols: syms, import_type: 'static' });
        continue;
      }
      // import xxx (non-relative, record for symbol search)
      m = trimmed.match(/^import\s+(\S+)/);
      if (m && !m[1].startsWith('.')) {
        // 标准库或第三方，只记录符号
        const imported = m[1].split(',')[0].trim();
        symbols.push({
          name: imported, kind: 'variable', line: i + 1, col: 7,
          signature: trimmed, is_exported: false,
        });
        continue;
      }
    }

    // ── 函数/类定义 ──
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const lineNum = i + 1;

      // async def / def
      let m = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
      if (m) {
        symbols.push({
          name: m[1], kind: 'function', line: lineNum, col: trimmed.indexOf(m[1]),
          signature: trimmed.split(':')[0].trim(), is_exported: !trimmed.startsWith('_'),
        });
        continue;
      }

      // class
      m = trimmed.match(/^class\s+(\w+)/);
      if (m) {
        const extendsMatch = trimmed.match(/\(([^)]+)\)/);
        symbols.push({
          name: m[1], kind: 'class', line: lineNum, col: trimmed.indexOf(m[1]),
          signature: trimmed.split(':')[0].trim(), is_exported: !trimmed.startsWith('_'),
        });
        if (extendsMatch) {
          for (const parent of extendsMatch[1].split(',')) {
            const pName = parent.trim();
            if (pName && pName !== 'object') {
              refs.push({ symbol_name: pName, line: lineNum, col: trimmed.indexOf(pName), kind: 'inherit', context: trimmed });
            }
          }
        }
        continue;
      }
    }

    // ── 调用引用 ──
    const callRegex = /(?:(\w+)\.)?(\w+)\s*\(/g;
    const pyBuiltins = new Set([
      'print', 'len', 'range', 'type', 'int', 'str', 'float', 'bool', 'list', 'dict',
      'set', 'tuple', 'open', 'isinstance', 'hasattr', 'getattr', 'setattr', 'super',
      'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'any', 'all', 'sum',
      'min', 'max', 'abs', 'round', 'input', 'next', 'iter', 'id', 'dir', 'vars',
      'staticmethod', 'classmethod', 'property', 'Exception', 'ValueError', 'TypeError',
      'self', 'cls', 'True', 'False', 'None',
    ]);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:#|from\s|import\s)/.test(line.trim())) continue;
      for (const cm of line.matchAll(callRegex)) {
        const name = cm[2];
        if (pyBuiltins.has(name) || name.length <= 1 || name[0] === '_') continue;
        refs.push({
          symbol_name: name,
          line: i + 1,
          col: cm.index ?? 0,
          kind: 'call',
          context: line.trim().slice(0, 120),
        });
      }
    }

    return {
      path: filePath,
      language: 'python',
      symbols, refs, imports, hash,
    };
  }
}

// ── GenericParser: C/Go/Rust/Java 等 ──────────────────────────────────

export class GenericParser implements FileParser {
  readonly name = 'generic-regex';
  readonly extensions = ['.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.swift'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();

    const langMap: Record<string, string> = {
      '.go': 'go', '.rs': 'rust', '.c': 'c', '.h': 'c',
      '.cpp': 'cpp', '.hpp': 'cpp', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
    };
    const language = langMap[ext] ?? 'unknown';

    const symbols: ParsedSymbol[] = [];
    const refs: ParsedRef[] = [];
    const imports: ParsedImport[] = [];

    // ── Go ──
    if (ext === '.go') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        // import
        let m = t.match(/^"(\.\S+)"/);
        if (m) {
          imports.push({ to_path: m[1].slice(1, -1), symbols: [], import_type: 'static' });
          continue;
        }

        // func
        m = t.match(/^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: /^[A-Z]/.test(m[1]) });
          continue;
        }

        // type struct / interface
        m = t.match(/^type\s+(\w+)\s+(struct|interface)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: /^[A-Z]/.test(m[1]) });
          continue;
        }
      }

      // calls
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:\/\/|import)/.test(lines[i].trim())) continue;
        for (const cm of lines[i].matchAll(/(?:(\w+)\.)?(\w+)\s*\(/g)) {
          if (!isKeyword(cm[2])) {
            refs.push({ symbol_name: cm[2], line: i + 1, col: cm.index ?? 0, kind: 'call', context: lines[i].trim().slice(0, 120) });
          }
        }
      }
    }

    // ── Rust ──
    if (ext === '.rs') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        let m = t.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: t.startsWith('pub') });
          continue;
        }

        m = t.match(/^(?:pub\s+)?(?:async\s+)?unsafe\s+fn\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: t.startsWith('pub') });
          continue;
        }

        m = t.match(/^(?:pub\s+)?struct\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: t.startsWith('pub') });
          continue;
        }

        m = t.match(/^(?:pub\s+)?trait\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'interface', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: t.startsWith('pub') });
          continue;
        }
      }

      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:\/\/|\/\/!)/.test(lines[i].trim())) continue;
        for (const cm of lines[i].matchAll(/(?:(\w+)::)?(\w+)\s*[(!<]/g)) {
          if (!isKeyword(cm[2])) {
            refs.push({ symbol_name: cm[2], line: i + 1, col: cm.index ?? 0, kind: 'call', context: lines[i].trim().slice(0, 120) });
          }
        }
      }
    }

    // ── C/C++ ──
    if (ext === '.c' || ext === '.h' || ext === '.cpp' || ext === '.hpp') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        // #include (记录为 import)
        let m = t.match(/^#include\s+"([^"]+)"/);
        if (m) {
          imports.push({ to_path: m[1], symbols: [], import_type: 'static' });
          continue;
        }

        // function definition (return_type name(...))
        m = t.match(/^(?:static\s+|inline\s+|virtual\s+|extern\s+)*(?:\w+(?:\s*\*)*\s+)+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{?/);
        if (m && !['if', 'while', 'for', 'switch', 'return'].includes(m[1])) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t.split('{')[0]?.trim() ?? t, is_exported: false });
          continue;
        }

        // class/struct
        m = t.match(/^(?:class|struct)\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: false });
          continue;
        }
      }

      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:\/\/|\/\*|\*|#)/.test(lines[i].trim())) continue;
        for (const cm of lines[i].matchAll(/(?:(\w+)(?:->|\.))?(\w+)\s*\(/g)) {
          if (!isKeyword(cm[2])) {
            refs.push({ symbol_name: cm[2], line: i + 1, col: cm.index ?? 0, kind: 'call', context: lines[i].trim().slice(0, 120) });
          }
        }
      }
    }

    // ── Java ──
    if (ext === '.java') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        // class/interface
        let m = t.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+|abstract\s+|final\s+)*(?:class|interface)\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: t.startsWith('public') });
          continue;
        }

        // method
        m = t.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+|abstract\s+|final\s+|synchronized\s+)*(?:\w+(?:<[^>]*>)?\s+)+(\w+)\s*\(/);
        if (m && !['if', 'while', 'for', 'switch', 'return', 'throw', 'try', 'catch'].includes(m[1])) {
          symbols.push({
            name: m[1], kind: 'method', line: lineNum, col: t.indexOf(m[1]),
            signature: t.split('{')[0]?.trim() ?? t, is_exported: t.startsWith('public'),
          });
          continue;
        }
      }

      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(?:\/\/|\/\*|\*)/.test(lines[i].trim())) continue;
        for (const cm of lines[i].matchAll(/(?:(\w+)\.)?(\w+)\s*\(/g)) {
          if (!isKeyword(cm[2])) {
            refs.push({ symbol_name: cm[2], line: i + 1, col: cm.index ?? 0, kind: 'call', context: lines[i].trim().slice(0, 120) });
          }
        }
        for (const nm of lines[i].matchAll(/new\s+(\w+)/g)) {
          if (!isKeyword(nm[1])) {
            refs.push({ symbol_name: nm[1], line: i + 1, col: nm.index ?? 0, kind: 'new', context: lines[i].trim().slice(0, 120) });
          }
        }
      }
    }

    return {
      path: filePath,
      language,
      symbols, refs, imports, hash,
    };
  }
}
