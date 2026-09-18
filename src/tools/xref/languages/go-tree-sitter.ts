/**
 * GoTreeSitterParser — Go 语法树解析（精度链首选，generic-regex 为兜底）
 *
 * 相对基线（GenericParser）修掉的三类问题（探针实测）：
 *   ① 误报：字符串里的 `fakeCall()` 被正则当成调用（语法树不会 —— 它不是 call_expression）；
 *   ② 假引用：声明行本身被正则当调用（`func` / `Method` 混进 refs）；
 *   ③ 缺 caller_name：正则给不出，callers/callees/trace 因此基本为空。
 * 另按 Go 语义修正两处：is_exported = **首字母大写**（不是下划线规则）；方法给 parent_name
 * （接收者类型），类型按 struct→class / interface→interface / 其它→type 分类。
 *
 * 结构性边（验收④）：Go 没有继承，等价物是**嵌入**——`field_declaration` **没有 name 字段**
 * 即嵌入字段（`Base` / `fmt.Stringer`），产出 inherit 引用。
 *
 * 导入口径（验收⑤）：与 GenericParser **逐条一致** —— to_path = 去引号的模块路径、
 * symbols 恒为空、import_type = 'static'。
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';
import type { FileParser } from '../parser.js';
import type { ParsedFile, ParsedImport, ParsedRef, ParsedSymbol, SymbolKind } from '../schema.js';
import { loadGrammar } from './tree-sitter-loader.js';

/** Go 预声明函数 —— 不计入引用图（与 py 版同一用意：别让内建淹没真实调用） */
const GO_BUILTINS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
]);

/** 显示用：把节点所在行裁剪成 context */
function lineContext(lines: string[], row: number): string {
  return (lines[row] ?? '').trim().slice(0, 120);
}

/** 定义行的签名 = 该行整行（与 GenericParser 口径一致：`func Helper() int {`） */
function signatureOf(lines: string[], row: number): string {
  return (lines[row] ?? '').trim();
}

/** 沿树向上找最近的函数/方法名 —— caller_name 的来源 */
function enclosingName(node: Node): string | null {
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'function_declaration' || cur.type === 'method_declaration') {
      const n = cur.childForFieldName('name');
      if (n) return n.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** 取"最后一个名字段"：`fmt.Stringer` → Stringer；`Base` → Base（与正则捕获末节的口径一致） */
function lastSegment(text: string): string {
  const parts = text.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? text;
}

/** call_expression 的被调方名字：首个子节点是 identifier 或 selector_expression */
function calleeName(call: Node): string | null {
  const head = call.namedChildren[0];
  if (!head) return null;
  if (head.type === 'identifier') return head.text;
  if (head.type === 'selector_expression') {
    const last = head.namedChildren[head.namedChildren.length - 1];
    return last ? last.text : null;
  }
  return null;
}

/** 方法的接收者类型名：`func (d *Derived) Method()` → Derived */
function receiverTypeName(method: Node): string | null {
  for (const child of method.children) {
    if (child.type === 'parameter_list') {
      const param = child.namedChildren[0];
      if (!param) return null;
      const t = param.childForFieldName('type') ?? param.namedChildren[param.namedChildren.length - 1];
      if (!t) return null;
      // 接收者可能是 `*Derived` / `Derived` / `pkg.Derived`：直接读 .text 会把指针记号
      // 一起带上（首版即错在此处，被本文件的验收用例抓住）→ 递归取第一个类型标识符。
      const findTypeIdent = (n: Node): string | null => {
        if (n.type === 'type_identifier') return n.text;
        for (const c of n.namedChildren) {
          const hit = findTypeIdent(c);
          if (hit) return hit;
        }
        return null;
      };
      return findTypeIdent(t);
    }
    if (child.type === 'block' || child.type === 'block_comment') break;
  }
  return null;
}

/** 类型定义的 kind：struct → class（与基线一致）；interface → interface；其余 → type */
function typeKind(spec: Node): SymbolKind {
  const t = spec.childForFieldName('type');
  if (!t) return 'type';
  if (t.type === 'struct_type') return 'class';
  if (t.type === 'interface_type') return 'interface';
  return 'type';
}

export class GoTreeSitterParser implements FileParser {
  readonly name = 'go-tree-sitter';
  readonly extensions = ['.go'];

  async parseFile(filePath: string): Promise<ParsedFile> {
    const language = await loadGrammar({ pkg: 'tree-sitter-go', wasm: 'tree-sitter-go.wasm' });
    if (!language) {
      // 抛错而非静默降级：交由精度链退到 generic-regex，且出处会如实记成 generic-regex
      throw new Error('tree-sitter-go.wasm 不可用（dist/grammars 与 node_modules 均无）');
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

    const walk = (node: Node): void => {
      switch (node.type) {
        case 'function_declaration':
        case 'method_declaration':
        case 'type_spec': {
          const name = node.childForFieldName('name')?.text;
          if (name) {
            const kind: SymbolKind =
              node.type === 'type_spec' ? typeKind(node) : node.type === 'method_declaration' ? 'method' : 'function';
            const parent = node.type === 'method_declaration' ? receiverTypeName(node) : null;
            symbols.push({
              name,
              kind,
              line: node.startPosition.row + 1,
              col: node.startPosition.column,
              signature: signatureOf(lines, node.startPosition.row),
              // Go 的导出规则是**首字母大写**（与 Python 的下划线规则不同）
              is_exported: /^[A-Z]/.test(name),
              ...(parent ? { parent_name: parent } : {}),
            });
          }
          break;
        }
        case 'call_expression': {
          const name = calleeName(node);
          if (name && name.length > 1 && !GO_BUILTINS.has(name)) {
            const caller = enclosingName(node);
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
        case 'field_declaration': {
          // 嵌入字段 = 没有 name 字段（`Base` / `fmt.Stringer`）→ Go 的结构性边
          if (!node.childForFieldName('name')) {
            const t = node.childForFieldName('type');
            if (t) {
              refs.push({
                symbol_name: lastSegment(t.text),
                line: node.startPosition.row + 1,
                col: node.startPosition.column,
                kind: 'inherit',
                context: lineContext(lines, node.startPosition.row),
              });
            }
          }
          break;
        }
        case 'import_spec': {
          // 取字符串字面量（兼容 `foo "x"` / `. "x"` / `_ "x"` 别名形式），去掉引号
          const strNode =
            node.children.find((c) => c.type === 'interpreted_string_literal' || c.type === 'raw_string_literal') ??
            null;
          if (strNode) {
            const toPath = strNode.text.replace(/^["`]|["`]$/g, '');
            // 与 GenericParser 逐条一致：无符号、static
            imports.push({ to_path: toPath, symbols: [], import_type: 'static' });
          }
          break;
        }
        default:
          break;
      }
      for (const child of node.children) walk(child);
    };
    walk(tree.rootNode);

    return { path: filePath, language: 'go', symbols, refs, imports, hash };
  }
}
