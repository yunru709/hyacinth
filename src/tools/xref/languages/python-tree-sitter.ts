/**
 * PyTreeSitterParser — Python 语法树解析（精度链首选，py-regex 为兜底）
 *
 * 为什么需要它（设计稿 §2.3）：正则解析的误报三兄弟是**注释 / 字符串 / 同名**，
 * 语法树天然解决前两道；更重要的是它能给出**调用者是谁** —— refs.caller_name 让
 * callers / callees / trace 从"基本为空"变为可用（这是本阶段验收的核心判据）。
 *
 * 数据出处：wasm 来自 tree-sitter-python（精确锁版本）里随包分发的
 * tree-sitter-python.wasm，经 scripts/copy-grammars.cjs 校验 sha256 后入库到
 * dist/grammars/（哈希清单 scripts/grammars.sha256.json）。运行时优先用入库那份，
 * 开发/测试期退回 node_modules；两条都载不到就抛错 → 构建循环按精度链降级到 py-regex，
 * 且 files.parser 会如实记成 'py-regex'（降级必须可查，而不是假装没降级）。
 *
 * 契约口径与 PyParser 对齐：hash = md5(content) 前 12 位、language = 'python'、
 * line 从 1 起、is_exported = 不以 _ 开头、import 的 to_path 含义见下方"导入"段。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParser } from '../parser.js';
import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol } from '../schema.js';
import { loadGrammar } from './tree-sitter-loader.js';

/** Python 内建/关键字 —— 与 py-regex 同一份名单，避免把 print/len 之类灌进引用图 */
const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'type', 'int', 'str', 'float', 'bool', 'list', 'dict',
  'set', 'tuple', 'open', 'isinstance', 'hasattr', 'getattr', 'setattr', 'super',
  'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'any', 'all', 'sum',
  'min', 'max', 'abs', 'round', 'input', 'next', 'iter', 'id', 'dir', 'vars',
  'staticmethod', 'classmethod', 'property', 'Exception', 'ValueError', 'TypeError',
  'self', 'cls', 'True', 'False', 'None',
]);

/** 显示用：把节点所在行裁剪成 context */
function lineContext(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().slice(0, 120);
}

/** 定义行的签名 = 该行第一个冒号之前的文本（与 py-regex 同口径） */
function signatureOf(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().split(':')[0].trim();
}

/** 沿树向上找最近的 def/class 名字 —— 即 caller_name 的来源（正则做不到这一点） */
function enclosingName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'class_definition') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 沿树向上找最近的 class 名字（用于方法的 parent_name） */
function enclosingClassName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'class_definition') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 调用的被调方名字：`f()` → f；`obj.m()` → m（与 py-regex 捕获最后一节的口径一致） */
function calleeName(fn: Node | null): string | null {
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') {
    const last = fn.namedChildren[fn.namedChildren.length - 1];
    return last?.type === 'identifier' ? last.text : null;
  }
  return null;
}

export class PyTreeSitterParser implements FileParser {
  readonly name = 'py-tree-sitter';
  readonly extensions = ['.py', '.pyi', '.pyx'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const language = await loadGrammar({ pkg: 'tree-sitter-python', wasm: 'tree-sitter-python.wasm' });
    if (!language) {
      // 抛错而非静默降级：让构建循环按精度链退到 py-regex，并把出处如实记成 py-regex
      throw new Error('tree-sitter-python.wasm 不可用（dist/grammars 与 node_modules 均无）');
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    const lines = content.split('\n');

    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    if (!tree) throw new Error('tree-sitter 解析返回 null');

    const symbols: ParsedSymbol[] = [];
    const refs: ParsedRef[] = [];
    const imports: ParsedImport[] = [];

    // ── 导入：仍走已由 37 例 resolve 测试钉死的行正则 ──
    // 导入语句本身就是"行形状"的，语法树在此没有增量价值；而 to_path 的口径
    //（`from . import a` 要按符号逐个成边为 `.a`）是解析侧依赖的契约，
    // 换实现只会引入风险。此段**有意与 PyParser 重复**（二者互不依赖）。
    for (const raw of lines) {
      const trimmed = raw.trim();
      let m = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
      if (m) {
        const toPath = m[1];
        const syms = m[2]
          .replace(/[()]/g, '')
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        if (/^\.+$/.test(toPath)) {
          // `from . import b`：导入的是**同级子模块** b，须按符号逐个成边
          for (const s of syms) imports.push({ to_path: `${toPath}${s}`, symbols: [], import_type: 'static' });
          if (syms.length === 0) imports.push({ to_path: toPath, symbols: [], import_type: 'static' });
        } else {
          imports.push({ to_path: toPath, symbols: syms, import_type: 'static' });
        }
        continue;
      }
      m = trimmed.match(/^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)(?:\s+as\s+\w+)?\s*$/);
      if (m) {
        for (const part of m[1].split(',')) {
          const mod = part.trim();
          if (mod) imports.push({ to_path: mod, symbols: [], import_type: 'static' });
        }
      }
    }

    // ── 符号 / 引用：走语法树 ──
    const walk = (node: Node): void => {
      switch (node.type) {
        case 'function_definition':
        case 'class_definition': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const parent = node.type === 'function_definition' ? enclosingClassName(node) : null;
            symbols.push({
              name,
              kind: node.type === 'class_definition' ? 'class' : 'function',
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: signatureOf(lines, node.startPosition.row),
              is_exported: !name.startsWith('_'),
              ...(parent ? { parent_name: parent } : {}),
            });
          }
          if (node.type === 'class_definition') {
            const sup = node.childForFieldName('superclasses');
            if (sup) {
              for (const arg of sup.namedChildren) {
                if (!arg.text || arg.text === 'object') continue;
                refs.push({
                  symbol_name: arg.text,
                  line: arg.startPosition.row + 1,
                  col: arg.startPosition.column,
                  kind: 'inherit',
                  context: lineContext(lines, arg.startPosition.row),
                });
              }
            }
          }
          break;
        }
        case 'call': {
          const name = calleeName(node.childForFieldName('function'));
          if (name && name.length > 1 && name[0] !== '_' && !PY_BUILTINS.has(name)) {
            refs.push({
              symbol_name: name,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              kind: 'call',
              context: lineContext(lines, node.startPosition.row),
              // 本阶段的核心增量：调用者是谁（沿树向上找最近的 def/class）
              ...(enclosingName(node) ? { caller_name: enclosingName(node)! } : {}),
            });
          }
          break;
        }
        default:
          break;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    return { path: filePath, language: 'python', symbols, refs, imports, hash };
  }
}
