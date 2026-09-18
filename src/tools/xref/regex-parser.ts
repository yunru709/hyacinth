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
    // 再导出（桶文件透传）与动态 import：AST 解析器已支持，正则回退保持一致
    for (const m of content.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) {
      if (m[1].startsWith('.')) imports.push({ to_path: m[1], symbols: [], import_type: 'reexport' });
    }
    for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1].startsWith('.')) imports.push({ to_path: m[1], symbols: [], import_type: 'dynamic' });
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

    // ── 导入语句（PEP 328）──
    //
    // 修复三处：
    //   1) `from .pkg import x` 原先把 `.pkg` 原样当路径，解析侧拼成 `<dir>/.pkg.py`
    //      （带前导点的文件名）必然不命中 ⇒ Python 相对导入一条都进不了图；
    //   2) `from . import x` 因正则要求点后必须跟非空白字符而完全不匹配；
    //   3) `import a.b` / `from a.b import c`（Python 里的常态）压根不采集，反而把
    //      `import os` 伪造成一个名为 os 的 variable 符号塞进符号表，污染 defs/refs。
    // 现在：相对导入保留前导点（交给解析侧按 PEP 328 上跳），绝对导入记模块路径，
    // 两者都落成 import 边；不再为外部模块伪造符号。
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // from .pkg import a, b  /  from . import a  /  from a.b import c
      let m = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
      if (m) {
        const toPath = m[1];
        const syms = m[2]
          .replace(/[()]/g, '')
          .split(',')
          .map(s => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        if (/^\.+$/.test(toPath)) {
          // `from . import b`：点后没有模块名，导入的是**同级子模块** b（不是包本身），
          // 所以要按符号逐个成边，否则会退化成"导入当前包"从而丢边。
          for (const s of syms) imports.push({ to_path: `${toPath}${s}`, symbols: [], import_type: 'static' });
          if (syms.length === 0) imports.push({ to_path: toPath, symbols: [], import_type: 'static' });
        } else {
          imports.push({ to_path: toPath, symbols: syms, import_type: 'static' });
        }
        continue;
      }
      // import a.b  /  import a.b as c  /  import a, b
      m = trimmed.match(/^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)(?:\s+as\s+\w+)?\s*$/);
      if (m) {
        for (const part of m[1].split(',')) {
          const mod = part.trim();
          if (mod) imports.push({ to_path: mod, symbols: [], import_type: 'static' });
        }
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
      // 块式 import ( ... ) 的跨行状态
      let inImportBlock = false;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        // import 路径
        // 修复：原正则 `^"(\.\S+)"` 要求路径以点开头（Go 里极少），
        // 且随后 `.slice(1, -1)` 又削掉首尾各一个字符（`"./foo"` → `/fo`）——
        // 等于 Go 的依赖边既抓不到又抓错。现在按 GOPATH/模块路径原样记录。
        if (/^import\s*\($/.test(t)) { inImportBlock = true; continue; }
        if (inImportBlock && t === ')') { inImportBlock = false; continue; }
        if (inImportBlock) {
          const q = t.match(/^(?:[\w.]+\s+)?"([^"]+)"/);
          if (q) {
            imports.push({ to_path: q[1], symbols: [], import_type: 'static' });
            continue;
          }
        }
        let m = t.match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
        if (m) {
          imports.push({ to_path: m[1], symbols: [], import_type: 'static' });
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

        // use 声明（原实现完全没有采集 Rust 导入 ⇒ Rust 依赖图恒空）
        let m = t.match(/^(?:pub\s+)?use\s+([^;]+);/);
        if (m) {
          const raw = m[1].trim();
          const braceIdx = raw.indexOf('::{');
          const items = braceIdx >= 0 ? [raw.slice(0, braceIdx)] : raw.split(',').map((s) => s.trim());
          for (const item of items) {
            const spec = item.replace(/\s+as\s+\w+$/, '').replace(/[{};\s]/g, '').trim();
            if (spec) imports.push({ to_path: spec, symbols: [], import_type: 'static' });
          }
          continue;
        }

        // mod foo; → 同目录 foo.rs 或 foo/mod.rs
        m = t.match(/^(?:pub\s+)?mod\s+(\w+)\s*;/);
        if (m) {
          imports.push({ to_path: `mod:${m[1]}`, symbols: [], import_type: 'static' });
          continue;
        }

        m = t.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
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

        // #include (记录为 import；尖括号形式属系统头文件，不收)
        let m = t.match(/^#include\s+"([^"]+)"/);
        if (m) {
          imports.push({ to_path: m[1], symbols: [], import_type: 'include' });
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

        // import 声明（原实现完全没有采集 Java 导入）
        let m = t.match(/^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/);
        if (m) {
          imports.push({ to_path: m[1].replace(/\.\*$/, ''), symbols: [], import_type: 'static' });
          continue;
        }

        // class/interface
        m = t.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+|abstract\s+|final\s+)*(?:class|interface)\s+(\w+)/);
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

    // ── Kotlin ──
    // 原实现注册了 .kt 扩展名却没有任何分支：文件被计入"已索引"，
    // 实际符号/引用/导入全空 —— 典型的"声称支持、实际空转"。现补最小实现。
    if (ext === '.kt') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        let m = t.match(/^import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/);
        if (m) {
          imports.push({ to_path: m[1].replace(/\.\*$/, ''), symbols: [], import_type: 'static' });
          continue;
        }

        m = t.match(/^(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+|sealed\s+|data\s+|suspend\s+|override\s+)*fun\s+(?:<[^>]*>\s*)?(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: !t.startsWith('private') });
          continue;
        }

        m = t.match(/^(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|abstract\s+|sealed\s+|data\s+)*(?:class|interface|object)\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: !t.startsWith('private') });
          continue;
        }
      }
    }

    // ── Swift ──
    // Swift 无项目内 import（同 module 内直接可见），import 只指向外部 module/framework；
    // 这里采集导入仅为如实标注依赖，不产生项目内边；符号提取仍有价值。
    if (ext === '.swift') {
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const lineNum = i + 1;

        let m = t.match(/^import\s+([\w.]+)/);
        if (m) {
          imports.push({ to_path: m[1], symbols: [], import_type: 'static' });
          continue;
        }

        m = t.match(/^(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|final\s+|static\s+|class\s+|mutating\s+)*func\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'function', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: !t.startsWith('private') });
          continue;
        }

        m = t.match(/^(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol|actor)\s+(\w+)/);
        if (m) {
          symbols.push({ name: m[1], kind: 'class', line: lineNum, col: t.indexOf(m[1]), signature: t, is_exported: !t.startsWith('private') });
          continue;
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
