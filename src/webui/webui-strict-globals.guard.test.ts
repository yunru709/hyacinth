/**
 * WebUI 前端脚本「隐式全局变量」守卫。
 *
 * 真实事故（2026-11-19，孑遗实报「打开过去的会话，UI 只显示『开始对话』」）：
 *   `app.js` 第一行的 IIFE 里是 `'use strict'`。2026-11-11 重写聊天跟随逻辑时，
 *   声明 `let _chatScrollOwned` 被删掉，但 `clearChat()` 与「回到底部」按钮里的
 *   两句 `_chatScrollOwned = false;` 留在原地 ⇒ 严格模式下给未声明变量赋值
 *   抛 ReferenceError ⇒ `clearChat()` 一抛，`loadHistory()` 整段被
 *   `catch {}`（当时是**空** catch）吞掉 ⇒ 后端 138 条消息完好、
 *   连接正常、界面却是空状态，且**没有任何日志**。
 *
 * 为什么必须用守卫而不是靠人眼：删声明与删赋值是两次独立编辑，行号相隔 2700 行，
 * 代码评审看不出来；唯一能暴露它的是运行期，而运行期恰好被静默 catch 挡住。
 * 判据：**严格模式下，赋值目标的标识符必须在文件内被声明过**（本文件自包含 IIFE，
 * 不依赖其它脚本的全局）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** 被检查的脚本：全部是自包含 classic script（无 import/export），严格模式 IIFE。 */
const FILES = ['src/webui/app.js', 'src/webui/markdown.js'];

/** 浏览器 / 宿主环境本来就有的名字：可以赋值而不声明。 */
const ENV_GLOBALS = new Set([
  'window', 'self', 'document', 'location', 'history', 'navigator', 'screen',
  'console', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Image', 'Audio',
  'FileReader', 'Blob', 'File', 'FormData', 'URL', 'URLSearchParams',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DragEvent',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt',
  'atob', 'btoa', 'structuredClone', 'performance',
  'undefined', 'NaN', 'Infinity', 'globalThis',
]);

interface Finding { file: string; line: number; name: string }

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** 收集文件内所有「声明出来的名字」（不区分作用域 —— 见文件头注释：只要不是完全消失就放行）。 */
function collectDeclaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const addBinding = (node: ts.Node | undefined): void => {
    if (!node) return;
    if (ts.isIdentifier(node)) { names.add(node.text); return; }
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      for (const el of node.elements) {
        if (ts.isBindingElement(el)) addBinding(el.name);
      }
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) addBinding(node.name);
    else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) addBinding(node.name);
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) addBinding(node.name);
    else if (ts.isParameter(node)) addBinding(node.name);
    else if (ts.isCatchClause(node) && node.variableDeclaration) addBinding(node.variableDeclaration.name);
    else if (ts.isImportClause(node)) addBinding(node.name);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return names;
}

function findImplicitGlobals(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declared = collectDeclaredNames(sf);
  const out: Finding[] = [];
  const maybeReport = (name: string, pos: number): void => {
    if (declared.has(name) || ENV_GLOBALS.has(name)) return;
    out.push({ file, line: lineOf(sf, pos), name });
  };
  const walk = (node: ts.Node): void => {
    // `x = ...` / `x += ...`：只认裸标识符目标（成员赋值 obj.x 合法）
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
      const op = node.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        maybeReport(node.left.text, node.left.getStart(sf));
      }
    }
    // `x++` / `--x`
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && ts.isIdentifier(node.operand)) {
      const kind = node.kind;
      if (kind === ts.SyntaxKind.PostfixUnaryExpression || kind === ts.SyntaxKind.PrefixUnaryExpression) {
        const op = (ts.isPostfixUnaryExpression(node) ? node.operator : node.operator);
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
          maybeReport((node.operand as ts.Identifier).text, node.operand.getStart(sf));
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}

describe('WebUI 脚本不得给未声明变量赋值（严格模式隐式全局）', () => {
  it.each(FILES)('%s 无隐式全局赋值', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    const findings = findImplicitGlobals(rel, src);
    const msg = findings
      .map((f) => `${f.file}:${f.line} 给未声明的 "${f.name}" 赋值（'use strict' 下会抛 ReferenceError）`)
      .join('\n');
    expect(msg).toBe('');
  });

  it('守卫自身有效：能抓到「只有赋值、没有声明」的形态', () => {
    const bad = "(function(){ 'use strict';\nfunction f(){ _ghost = false; }\n})();";
    const findings = findImplicitGlobals('fixture.js', bad);
    expect(findings.map((f) => f.name)).toEqual(['_ghost']);
  });
});
