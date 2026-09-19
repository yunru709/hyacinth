/**
 * JavaTreeSitterParser — Java 语法树解析（精度链首选，generic-regex 为兜底）
 *
 * 相对基线（GenericParser）修掉的三类问题（探针实测）：
 *   ① 误报：字符串里的 `fakeCall()` 被正则当成调用；
 *   ② 假引用：声明行本身被当调用（`run` / `compute` 混进 refs）；
 *   ③ 结构性边缺失：`class Derived extends Base implements Runnable` 在基线里**一条都没抓**
 *      （inherit 0 条）—— 这正是验收④ 要的 extends / implements。
 * 另按 Java 语义修正：is_exported 看 **public**；方法给 parent_name（所在类）。
 *
 * 导入口径（验收⑤）：与 GenericParser **逐条一致** —— Java 的 import 本来就是类名，
 * 解析侧（resolveJavaLike）也按"包路径 → 源码根下的文件"消费它，故保持**整条点分路径**、
 * symbols 恒为空、import_type = 'static'（**不拆**，与 Rust 的情况不同：Rust 的 use 会引符号）。
 * 已知边界：`import static a.b.C.d;` 的 static 前缀、`*` 通配导入未特别处理（本夹具不含）。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParser } from '../parser.js';
import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol, SymbolKind } from '../schema.js';
import { loadGrammar } from './tree-sitter-loader.js';

function lineContext(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().slice(0, 120);
}

/**
 * 该节点是否带 public 修饰符（Java 的导出语义）。
 * 注意：tree-sitter-java 里 `modifiers` 是 `optional($.modifiers)` —— **可选子节点，不是 field**，
 * 用 childForFieldName('modifiers') 会恒返回 null（首版即错在此处，被验收用例抓住）。
 * 故按**节点类型**在 children 里找。
 */
function isPublic(node: Node): boolean {
  const mods = node.children.find((c) => c.type === 'modifiers');
  return !!mods && /\bpublic\b/.test(mods.text);
}

/** 沿树向上找最近的类/接口名（用于给方法定 parent_name） */
function enclosingTypeName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'class_declaration' || cur.type === 'interface_declaration' || cur.type === 'enum_declaration') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 沿树向上找最近的方法名（caller_name 来源） */
function enclosingMethodName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'method_declaration' || cur.type === 'constructor_declaration') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

export class JavaTreeSitterParser implements FileParser {
  readonly name = 'java-tree-sitter';
  readonly extensions = ['.java'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const language = await loadGrammar({ pkg: 'tree-sitter-java', wasm: 'tree-sitter-java.wasm' });
    if (!language) throw new Error('tree-sitter-java.wasm 不可用（dist/grammars 与 node_modules 均无）');

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
        case 'class_declaration':
        case 'interface_declaration':
        case 'enum_declaration': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const kind: SymbolKind =
              node.type === 'interface_declaration' ? 'interface' : node.type === 'enum_declaration' ? 'enum' : 'class';
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              is_exported: isPublic(node),
            });
          }
          break;
        }
        case 'method_declaration':
        case 'constructor_declaration': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const owner = enclosingTypeName(node);
            symbols.push({
              name,
              kind: 'method',
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: (lines[node.startPosition.row] ?? '').trim(),
              is_exported: isPublic(node),
              ...(owner ? { parent_name: owner } : {}),
            });
          }
          break;
        }
        case 'superclass':
        case 'super_interfaces': {
          // extends Base / implements Runnable[, Serializable] —— 基线一条都没抓
          for (const t of collectTypeNames(node)) {
            refs.push({
              symbol_name: t.name,
              line: t.line,
              col: t.col,
              kind: 'inherit',
              context: lineContext(lines, node.startPosition.row),
            });
          }
          break;
        }
        case 'method_invocation': {
          const name = node.childForFieldName('name')?.text;
          if (name && name.length > 1) {
            const caller = enclosingMethodName(node);
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
        case 'import_declaration': {
          // 与 GenericParser 逐条一致：整条点分路径、无符号、static
          const text = node.text
            .replace(/^import\s+/, '')
            .replace(/\s*;\s*$/, '')
            .replace(/^static\s+/, '')
            .trim();
          if (text) imports.push({ to_path: text, symbols: [], import_type: 'static' });
          break;
        }
        default:
          break;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    return { path: filePath, language: 'java', symbols, refs, imports, hash };
  }
}

/** 取 extends/implements 里的类型名（superclass 直接是类型；super_interfaces 里是 type_list） */
function collectTypeNames(node: Node): { name: string; line: number; col: number }[] {
  const out: { name: string; line: number; col: number }[] = [];
  const visit = (n: Node): void => {
    if (n.type === 'type_identifier' || n.type === 'identifier') {
      out.push({ name: n.text, line: n.startPosition.row + 1, col: n.startPosition.column });
      return; // 不再往里钻（泛型参数等）
    }
    for (const c of n.namedChildren) {
      // 泛型实参（type_arguments）不作为继承目标
      if (c.type === 'type_arguments') continue;
      visit(c);
    }
  };
  for (const c of node.namedChildren) visit(c);
  return out;
}
