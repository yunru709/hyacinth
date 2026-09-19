/**
 * CCppTreeSitterParser — C / C++ 语法树解析（精度链首选，generic-regex 为兜底）
 *
 * 一份实现、两个语法包：`.c` / `.h` → tree-sitter-c；`.cpp` / `.hpp` → tree-sitter-cpp
 * （两套语法的节点结构差异不大，但 C 没有 class / base_class_clause，故按后缀选包最稳）。
 *
 * 相对基线（GenericParser）修掉的三类问题（探针实测）：
 *   ① 误报：**声明行**被当调用（`helper_fn` / `fake_call` / `use_it` 各混进一次），
 *      注释与字符串里的 `fake_call()` 也被收（C 夹具里 fake_call 共 3 次，真调用只有 1 次）；
 *   ② 结构性边缺失：C++ 的 `class Derived : public Base` 在基线里**一条都没抓**（inherit 0）；
 *   ③ caller_name 缺失。
 * 另按 C/C++ 语义修正：`is_exported` 看 **static**（C 里 static 就是"本翻译单元可见"，
 * 是 private 的对应物）；类内函数记为 method 并给 parent_name。
 *
 * 导入口径（验收⑤）：与 GenericParser **逐条一致** —— 只采**引号形式** `#include "x.h"`
 * （尖括号是系统头文件，基线也不收）、to_path 取引号内的内容、import_type = **'include'**。
 *
 * 已知边界：`function_definition` 的名字要沿 declarator 链下钻（C/C++ 都不放在 field 上），
 * 函数指针 / 复杂声明符（如 `int (*fp)(void)`）可能取不到名字 —— 取不到就不记符号，不猜。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Parser, Language } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParser } from '../parser.js';
import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol, SymbolKind } from '../schema.js';
import { loadGrammar } from './tree-sitter-loader.js';

const C_EXTS = ['.c', '.h'];
const CPP_EXTS = ['.cpp', '.hpp'];

function lineContext(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().slice(0, 120);
}

function lastSegment(text: string): string {
  const parts = text.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? text;
}

/**
 * 从 function_definition 取函数名。
 * C/C++ 的 function_definition **没有 name field** —— 名字在 declarator 链末端
 *（function_declarator → declarator → identifier / field_identifier），故逐层下钻。
 */
function functionName(fn: Node): string | null {
  let cur: Node | null = fn.childForFieldName('declarator');
  for (let depth = 0; cur && depth < 8; depth++) {
    if (cur.type === 'identifier' || cur.type === 'field_identifier') return cur.text;
    if (cur.type === 'qualified_identifier') return lastSegment(cur.text);
    cur = cur.childForFieldName('declarator');
  }
  return null;
}

/** call_expression 的被调方 */
function calleeName(call: Node): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'field_expression' || fn.type === 'qualified_identifier') return lastSegment(fn.text);
  return null;
}

/** 沿树向上找最近的函数名（caller_name 来源） */
function enclosingFnName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_definition') return functionName(cur);
    cur = cur.parent;
  }
  return null;
}

/** 沿树向上找最近的类/结构体名（C++ 的方法 parent_name 来源） */
function enclosingTypeName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'class_specifier' || cur.type === 'struct_specifier' || cur.type === 'union_specifier') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 是否带 static 存储类（C 的"本翻译单元可见"= 非导出） */
function hasStatic(node: Node): boolean {
  return node.children.some((c) => c.type === 'storage_class_specifier' && c.text === 'static');
}

export class CCppTreeSitterParser implements FileParser {
  readonly name = 'ccpp-tree-sitter';
  readonly extensions = [...C_EXTS, ...CPP_EXTS];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const lower = filePath.toLowerCase();
    const isCpp = CPP_EXTS.some((e) => lower.endsWith(e));
    const spec = isCpp
      ? { pkg: 'tree-sitter-cpp', wasm: 'tree-sitter-cpp.wasm' }
      : { pkg: 'tree-sitter-c', wasm: 'tree-sitter-c.wasm' };
    const language: Language | null = await loadGrammar(spec);
    if (!language) throw new Error(`${spec.wasm} 不可用（dist/grammars 与 node_modules 均无）`);

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

    const walk = (node: Node): void => {
      switch (node.type) {
        case 'function_definition': {
          const name = functionName(node);
          if (name) {
            const owner = isCpp ? enclosingTypeName(node) : null;
            const kind: SymbolKind = owner ? 'method' : 'function';
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              // static = 本翻译单元可见（C/C++ 里 private 的对应物）
              is_exported: !hasStatic(node),
              ...(owner ? { parent_name: owner } : {}),
            });
          }
          break;
        }
        case 'struct_specifier':
        case 'class_specifier':
        case 'union_specifier': {
          const name = node.childForFieldName('name')?.text;
          // 只有带名字的定义才记（`struct { } x;` 匿名结构体没有名字可记）
          if (name) {
            symbols.push({
              name,
              kind: 'class',
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              is_exported: true,
            });
          }
          break;
        }
        case 'base_class_clause': {
          // C++ 的继承：`class Derived : public Base` —— 基线一条都没抓
          for (const t of node.namedChildren) {
            if (t.type === 'access_specifier' || t.type === 'virtual') continue;
            const typeId = t.type === 'type_identifier' ? t : t.namedChildren.find((c) => c.type === 'type_identifier');
            if (typeId) {
              refs.push({
                symbol_name: lastSegment(typeId.text),
                line: typeId.startPosition.row + 1,
                col: typeId.startPosition.column,
                kind: 'inherit',
                context: lineContext(lines, node.startPosition.row),
              });
            }
          }
          break;
        }
        case 'call_expression': {
          const name = calleeName(node);
          if (name && name.length > 1) {
            const caller = enclosingFnName(node);
            refs.push({
              symbol_name: name,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              kind: 'call',
              context: lineContext(lines, node.startPosition.row),
              ...(caller ? { caller_name: caller } : {}),
            });
          }
          break;
        }
        case 'preproc_include': {
          // 与 GenericParser 逐条一致：**只采引号形式**（尖括号是系统头文件，基线也不收），
          // to_path = 引号内内容，import_type = 'include'
          const str = node.namedChildren.find((c) => c.type === 'string_literal');
          if (str) {
            const inner = str.namedChildren.find((c) => c.type === 'string_content') ?? str;
            const toPath = (inner.type === 'string_content' ? inner.text : str.text).replace(/^"|"$/g, '');
            if (toPath) imports.push({ to_path: toPath, symbols: [], import_type: 'include' });
          }
          break;
        }
        default:
          break;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    return { path: filePath, language: isCpp ? 'cpp' : 'c', symbols, refs, imports, hash };
  }
}

export { C_EXTS, CPP_EXTS };
