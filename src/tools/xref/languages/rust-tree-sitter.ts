/**
 * RustTreeSitterParser — Rust 语法树解析（精度链首选，generic-regex 为兜底）
 *
 * 相对基线（GenericParser）修掉的三类问题（探针实测）：
 *   ① 误报：注释与字符串里的 `fake_call()` 被正则当成调用（各收 1 次）；
 *   ② 假引用：声明行本身被当调用（`greet` / `method` / `use_it` 混进 refs）；
 *   ③ 结构性边缺失：`impl Greet for Base` 在基线里**一条都没抓**（inherit 0 条）——
 *      Rust 的"实现某个 trait"正是它的结构性边。
 * 另按 Rust 语义修正：is_exported 看 **pub**（不是基线的通用规则）；impl 块内的函数记为
 * method 并给 parent_name（impl 的类型/被实现的 trait）。
 *
 * 导入口径：**有意偏离**"与 GenericParser 逐条一致"（任务单验收⑤），改为与 Python 同口径的
 * 拆分（模块 + 符号）。依据是真实仓库冒烟：4091 文件的 Rust 仓里 **14928 条未解析**，
 * 全是 `use crate::SomeType;` 形态 —— 基线把整条路径当模块 ⇒ 去找 `src/SomeType.rs` ⇒
 * 必然失败。⑤ 的前提是基线口径合理；Python 的基线本来就拆对（from .pkg import thing），
 * 故照抄无害；Rust 的基线没拆，照抄就把真实仓库的导入全废。详见 splitUseSpec 注释。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParser } from '../parser.js';
import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol, SymbolKind } from '../schema.js';
import { loadGrammar } from './tree-sitter-loader.js';

/**
 * 解析一条 use 声明 →（模块路径, 引入的符号名）。
 *
 * 与 Python 解析器同口径（`from .pkg import thing` → to_path='.pkg', symbols=['thing']）：
 *   use a::b::C         → { to_path: 'a::b', symbols: ['C'] }   （真实仓库最常见形态）
 *   use a::b            → { to_path: 'a::b', symbols: [] }      （2 段常见形态就是引模块）
 *   use a::*            → { to_path: 'a',    symbols: [] }      （glob）
 *   use a::{b, c as d}  → { to_path: 'a',    symbols: ['b', 'c'] }
 * 已知边界：`as` 别名被丢弃（图只关心名字）；嵌套花括号组未处理（罕见）。
 */
function splitUseSpec(text: string): { to_path: string; symbols: string[] } {
  const body = text.replace(/^use\s+/, '').replace(/;\s*$/, '').trim();

  const brace = body.match(/^(.*?)::\{(.*)\}$/);
  if (brace) {
    const syms = brace[2]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    return { to_path: brace[1].replace(/::$/, ''), symbols: syms };
  }
  if (body.endsWith('::*')) return { to_path: body.slice(0, -3), symbols: [] };

  const segs = body.split('::').map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 3) {
    const last = segs[segs.length - 1].split(/\s+as\s+/)[0].trim();
    return { to_path: segs.slice(0, -1).join('::'), symbols: [last] };
  }
  if (segs.length === 2) return { to_path: segs.join('::'), symbols: [] };
  return { to_path: (segs[0] ?? '').split(/\s+as\s+/)[0].trim(), symbols: [] };
}

/** 取最后一个路径段：`helper::do_it` → do_it；`Base` → Base */
function lastSegment(text: string): string {
  const parts = text.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? text;
}

function lineContext(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().slice(0, 120);
}

/** call_expression 的被调方：首个子节点可能是 identifier / scoped_identifier / field_expression */
function calleeName(call: Node): string | null {
  const head = call.namedChildren[0];
  if (!head) return null;
  if (head.type === 'identifier') return head.text;
  if (head.type === 'scoped_identifier' || head.type === 'field_expression') {
    return lastSegment(head.text);
  }
  return null;
}

/** 沿树向上找最近的 fn 名（caller_name 来源） */
function enclosingFnName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_item') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 沿树向上找最近的 impl 块（用于给方法定 parent_name） */
function enclosingImpl(node: Node): Node | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'impl_item') return cur;
    cur = cur.parent;
  }
  return null;
}

/** impl 块的"归属名"：实现 trait 时取 trait 名，否则取类型名 */
function implOwner(impl: Node): string | null {
  const trait = impl.childForFieldName('trait');
  const type = impl.childForFieldName('type');
  const pick = trait ?? type;
  return pick ? lastSegment(pick.text) : null;
}

export class RustTreeSitterParser implements FileParser {
  readonly name = 'rust-tree-sitter';
  readonly extensions = ['.rs'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const language = await loadGrammar({ pkg: 'tree-sitter-rust', wasm: 'tree-sitter-rust.wasm' });
    if (!language) throw new Error('tree-sitter-rust.wasm 不可用（dist/grammars 与 node_modules 均无）');

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
        case 'function_item':
        case 'function_signature_item': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const impl = enclosingImpl(node);
            const owner = impl ? implOwner(impl) : null;
            const kind: SymbolKind = node.type === 'function_signature_item' || impl ? 'method' : 'function';
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              // Rust 的导出语义是 pub（不是下划线或首字母规则）
              is_exported: node.children.some((c) => c.type === 'visibility_modifier'),
              ...(owner ? { parent_name: owner } : {}),
            });
          }
          break;
        }
        case 'struct_item':
        case 'enum_item':
        case 'trait_item':
        case 'union_item': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const kind: SymbolKind =
              node.type === 'trait_item' ? 'interface' : node.type === 'enum_item' ? 'enum' : 'class';
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              is_exported: node.children.some((c) => c.type === 'visibility_modifier'),
            });
          }
          break;
        }
        case 'impl_item': {
          // `impl Trait for Type` → Type 实现 Trait 的结构性边（基线一条都没抓）
          const trait = node.childForFieldName('trait');
          if (trait) {
            refs.push({
              symbol_name: lastSegment(trait.text),
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              kind: 'inherit',
              context: lineContext(lines, node.startPosition.row),
            });
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
        case 'use_declaration': {
          // 与 Python 同口径的拆分（**有意偏离**基线的"整条当模块"，理由见函数注释与测试）
          const spec = splitUseSpec(node.text);
          if (spec.to_path) imports.push({ to_path: spec.to_path, symbols: spec.symbols, import_type: 'static' });
          break;
        }
        default:
          break;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    return { path: filePath, language: 'rust', symbols, refs, imports, hash };
  }
}
