/**
 * TypeScript/JavaScript AST 解析器。
 *
 * 使用 TypeScript 编译器 API（ts.createSourceFile + 递归 AST 遍历）
 * 提取：函数/类/接口/类型/变量定义、调用/实例化/读取引用、导入依赖。
 *
 * 注册链：ParserRegistry → TsParser → ts.createSourceFile → AST walk
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FileParser } from './parser.js';
import type { ParsedFile, ParsedSymbol, ParsedRef, ParsedImport, SymbolKind, RefKind } from './schema.js';

// 动态加载 typescript（它是 devDependency，运行时可能不可用）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tsModule: any = null;
async function loadTs(): Promise<any> {
  if (tsModule) return tsModule;
  try {
    tsModule = await import('typescript');
    return tsModule;
  } catch {
    return null;
  }
}

// 类型别名 — 避免在代码中出现 ts.Node / ts.SourceFile 等命名空间引用
type TsNode = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type TsSourceFile = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export class TsParser implements FileParser {
  readonly name = 'ts-ast';
  readonly extensions = TS_EXTS;

  async parseFile(filePath: string): Promise<ParsedFile> {
    const ts = await loadTs();
    if (!ts) {
      // 回退：TypeScript compiler 不可用，返回空结果
      return this.emptyResult(filePath, 'typescript');
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    const ext = path.extname(filePath).toLowerCase();

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      ext === '.tsx' || ext === '.jsx'
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

    const symbols: ParsedSymbol[] = [];
    const refs: ParsedRef[] = [];
    const imports: ParsedImport[] = [];

    // 当前遍历所在的函数/方法上下文（用于记录 caller_name）
    const contextStack: string[] = [];
    // 声明处标识符节点集合 —— 只跳过「声明语句里的那个标识符」本身
    // （避免 `const x = 0` / `function foo()` 的名字本身被记为一次 read）。
    //
    // 修复：原实现按「名字」过滤（declaredNames 累计本文件全部声明名），
    // 于是本文件内**所有**同名标识符的 write/read 引用被整体丢弃 ——
    // 导致 xref_query 的 trace 对「同文件声明的局部变量」结构性查不到数据流
    // （而 trace 又按 file_id 限定在本文件，等于该能力完全失效）。
    const declNameNodes = new Set<unknown>();

    // 辅助：记录一个引用
    const recordRef = (name: string, node: any, kind: RefKind) => {
      if (this.isBuiltin(name) || declNameNodes.has(node)) return;
      const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
      const callerName = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
      refs.push({
        symbol_name: name,
        line: pos.line + 1,
        col: pos.character,
        kind,
        context: node.getText(sourceFile).slice(0, 120),
        caller_name: callerName,
      });
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any): void => {
      // ── 导入声明 ──
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const modulePath = moduleSpecifier.text;
          const symbols_list: string[] = [];
          const importClause = node.importClause;
          if (importClause) {
            if (importClause.name) {
              symbols_list.push(importClause.name.text);
            }
            if (importClause.namedBindings) {
              if (ts.isNamedImports(importClause.namedBindings)) {
                for (const el of importClause.namedBindings.elements) {
                  // `import { a as b }` 里被导入的符号名是 a（propertyName），
                  // b 只是本地别名；symbol_search 要匹配的是目标文件里的 a。
                  symbols_list.push((el.propertyName ?? el.name).text);
                }
              } else if (ts.isNamespaceImport(importClause.namedBindings)) {
                symbols_list.push(importClause.namedBindings.name.text);
              }
            }
          }
          if (modulePath.startsWith('.')) {
            imports.push({
              to_path: modulePath,
              symbols: symbols_list,
              import_type: 'static',
            });
          }
        }
      }

      // ── 再导出声明（export * from / export { a } from）──
      // 旧实现只处理 ImportDeclaration，于是桶文件（index.ts）的透传边全部丢失，
      // dependents 会漏掉「经 barrel 间接依赖」的那一批文件。
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const modulePath = node.moduleSpecifier.text;
        if (modulePath.startsWith('.')) {
          const names: string[] = [];
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              names.push((el.propertyName ?? el.name).text);
            }
          }
          imports.push({ to_path: modulePath, symbols: names, import_type: 'reexport' });
        }
      }

      // ── 动态 import('./x.js') ──
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg) && arg.text.startsWith('.')) {
          imports.push({ to_path: arg.text, symbols: [], import_type: 'dynamic' });
        }
      }

      // ── 函数声明 ──
      if (ts.isFunctionDeclaration(node) && node.name) {
        declNameNodes.add(node.name);
        const isExported = this.hasExportModifier(node, tsModule);
        symbols.push({
          name: node.name.text,
          kind: 'function',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          signature: node.getText(sourceFile).split('{')[0]?.trim() ?? undefined,
          is_exported: isExported,
        });

        // 进入函数体上下文
        contextStack.push(node.name.text);
        ts.forEachChild(node, visit);
        contextStack.pop();
        return; // 已递归处理子节点
      }

      // ── 类声明 ──
      if (ts.isClassDeclaration(node) && node.name) {
        declNameNodes.add(node.name);
        const isExported = this.hasExportModifier(node, tsModule);
        const parentName = node.heritageClauses
          ?.flatMap((h: any) => h.types)
          .map((t: any) => t.expression.getText(sourceFile))
          .join(', ') || undefined;

        symbols.push({
          name: node.name.text,
          kind: 'class',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          signature: `class ${node.name.text}${parentName ? ` extends ${parentName}` : ''}`,
          is_exported: isExported,
        });

        // 记录继承引用
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const refName = type.expression.getText(sourceFile);
              const pos = ts.getLineAndCharacterOfPosition(sourceFile, type.expression.getStart(sourceFile));
              refs.push({
                symbol_name: refName,
                line: pos.line + 1,
                col: pos.character,
                kind: 'inherit',
                context: type.getText(sourceFile),
                caller_name: node.name.text,
              });
            }
          }
        }

        contextStack.push(node.name.text);
        ts.forEachChild(node, visit);
        contextStack.pop();
        return;
      }

      // ── 方法 / 属性声明 ──
      if (ts.isMethodDeclaration(node) && node.name) {
        const methodName = ts.isIdentifier(node.name) ? node.name.text : '[computed]';
        if (methodName !== '[computed]') {
          declNameNodes.add(node.name);
          symbols.push({
            name: methodName,
            kind: 'method',
            line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
            col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
            signature: node.getText(sourceFile).split('{')[0]?.trim() ?? undefined,
            is_exported: false,
            parent_name: contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined,
          });
        }

        contextStack.push(methodName);
        ts.forEachChild(node, visit);
        contextStack.pop();
        return;
      }

      // ── 属性声明（类成员变量） ──
      if (ts.isPropertyDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        declNameNodes.add(node.name);
        symbols.push({
          name: node.name.text,
          kind: 'property',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          is_exported: false,
          parent_name: contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined,
        });
      }

      // ── 变量声明（含箭头函数、函数表达式） ──
      if (ts.isVariableStatement(node)) {
        const isExported = this.hasExportModifier(node, tsModule);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            declNameNodes.add(decl.name);
            let kind: SymbolKind = 'variable';

            if (decl.initializer) {
              if (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)) {
                kind = 'arrow';
              } else if (ts.isClassExpression(decl.initializer)) {
                kind = 'class';
              }
            }

            symbols.push({
              name: varName,
              kind,
              line: ts.getLineAndCharacterOfPosition(sourceFile, decl.name.getStart(sourceFile)).line + 1,
              col: ts.getLineAndCharacterOfPosition(sourceFile, decl.name.getStart(sourceFile)).character,
              signature: decl.getText(sourceFile).split('=')[0]?.trim() ?? undefined,
              is_exported: isExported,
            });

            // 对箭头函数/函数表达式，进入函数体上下文
            if (kind === 'arrow' && decl.initializer) {
              contextStack.push(varName);
              ts.forEachChild(decl.initializer, visit);
              contextStack.pop();
              // 跳过默认的递归遍历（避免重复）
              // 继续处理其他声明
              continue;
            }
          }
        }
      }

      // ── 接口声明 ──
      if (ts.isInterfaceDeclaration(node) && node.name) {
        declNameNodes.add(node.name);
        const isExported = this.hasExportModifier(node, tsModule);
        const extendsList = node.heritageClauses
          ?.flatMap((h: any) => h.types)
          .map((t: any) => t.expression.getText(sourceFile))
          .join(', ');

        symbols.push({
          name: node.name.text,
          kind: 'interface',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          signature: `interface ${node.name.text}${extendsList ? ` extends ${extendsList}` : ''}`,
          is_exported: isExported,
        });

        // 继承引用
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const refName = type.expression.getText(sourceFile);
              const pos = ts.getLineAndCharacterOfPosition(sourceFile, type.expression.getStart(sourceFile));
              refs.push({
                symbol_name: refName,
                line: pos.line + 1,
                col: pos.character,
                kind: 'inherit',
                context: type.getText(sourceFile),
                caller_name: node.name.text,
              });
            }
          }
        }

        return; // 接口体内没有可执行代码
      }

      // ── 类型别名 ──
      if (ts.isTypeAliasDeclaration(node) && node.name) {
        declNameNodes.add(node.name);
        const isExported = this.hasExportModifier(node, tsModule);
        symbols.push({
          name: node.name.text,
          kind: 'type',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          signature: `type ${node.name.text}`,
          is_exported: isExported,
        });
        return;
      }

      // ── 枚举声明 ──
      if (ts.isEnumDeclaration(node) && node.name) {
        declNameNodes.add(node.name);
        const isExported = this.hasExportModifier(node, tsModule);
        symbols.push({
          name: node.name.text,
          kind: 'enum',
          line: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).line + 1,
          col: ts.getLineAndCharacterOfPosition(sourceFile, node.name.getStart(sourceFile)).character,
          signature: `enum ${node.name.text}`,
          is_exported: isExported,
        });
        return;
      }

      // ── 调用表达式 ──
      if (ts.isCallExpression(node)) {
        const callee = this.resolveCallee(node.expression, sourceFile);
        if (callee && !this.isBuiltin(callee)) {
          const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.expression.getStart(sourceFile));
          const callerName = contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
          refs.push({
            symbol_name: callee,
            line: pos.line + 1,
            col: pos.character,
            kind: 'call',
            context: node.getText(sourceFile).slice(0, 120),
            caller_name: callerName,
          });
        }
      }

      // ── new 表达式 ──
      if (ts.isNewExpression(node) && node.expression) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
        if (callee && !this.isBuiltin(callee)) {
          const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.expression.getStart(sourceFile));
          refs.push({
            symbol_name: callee,
            line: pos.line + 1,
            col: pos.character,
            kind: 'new',
            context: node.getText(sourceFile).slice(0, 120),
            caller_name: contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined,
          });
        }
      }

      // ── 赋值表达式（写变量）──
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken?.kind;
        // = , += , -= , *= , /= 等赋值操作符
        if (op === ts.SyntaxKind.EqualsToken ||
            op === ts.SyntaxKind.PlusEqualsToken ||
            op === ts.SyntaxKind.MinusEqualsToken ||
            op === ts.SyntaxKind.AsteriskEqualsToken ||
            op === ts.SyntaxKind.SlashEqualsToken) {
          if (ts.isIdentifier(node.left)) {
            recordRef(node.left.text, node, 'write');
          }
        }
      }

      // ── 前缀/后缀自增自减（写变量）──
      if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken) {
          if (ts.isIdentifier(node.operand)) {
            recordRef(node.operand.text, node, 'write');
          }
        }
      }

      // ── 标识符引用（读变量）──
      // 放在所有声明/特殊节点处理后，只记录在表达式位置出现的纯标识符
      if (ts.isIdentifier(node)) {
        recordRef(node.text, node, 'read');
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return {
      path: filePath,
      language: ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts' ? 'typescript' : 'javascript',
      symbols,
      refs,
      imports,
      hash,
    };
  }

  // ── 辅助方法 ──

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveCallee(expr: any, _sourceFile: any): string | undefined {
    if (!tsModule) return undefined;
    if (tsModule.isIdentifier(expr)) {
      return expr.text;
    }
    if (tsModule.isPropertyAccessExpression(expr)) {
      // obj.method() → method
      return expr.name.text;
    }
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private hasExportModifier(node: any, tsApi: any): boolean {
    if (!tsApi.canHaveModifiers(node)) return false;
    const modifiers = tsApi.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some((m: any) => m.kind === tsApi.SyntaxKind.ExportKeyword
      || m.kind === tsApi.SyntaxKind.DefaultKeyword
      || m.kind === tsApi.SyntaxKind.DeclareKeyword);
  }

  private isBuiltin(name: string): boolean {
    const builtins = new Set([
      'console', 'require', 'setTimeout', 'setInterval', 'clearTimeout',
      'clearInterval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
      'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean',
      'Promise', 'Map', 'Set', 'Error', 'Date', 'RegExp', 'Symbol',
      'Reflect', 'Proxy', 'Buffer', 'process', 'global', 'globalThis',
      'undefined', 'eval', 'decodeURI', 'encodeURI', 'decodeURIComponent',
      'encodeURIComponent',
    ]);
    return builtins.has(name) || name.startsWith('_') || name.length <= 1;
  }

  private emptyResult(filePath: string, language: string): ParsedFile {
    return {
      path: filePath,
      language,
      symbols: [],
      refs: [],
      imports: [],
      hash: '',
    };
  }
}
