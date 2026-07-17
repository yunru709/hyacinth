/**
 * xref_query — 查询交叉引用索引。
 *
 * 支持 9 种查询操作：
 *   refs       — 查符号被哪些地方引用
 *   defs       — 查符号的定义位置
 *   callers    — 谁调用了该函数
 *   callees    — 该函数调用了谁
 *   deps       — 文件依赖了哪些模块
 *   dependents — 哪些文件依赖了该文件
 *   hierarchy  — 类的继承关系树
 *   impact     — 修改文件的影响面分析（BFS）
 *   trace      — 变量在文件内的数据流追踪
 *
 * 需要先运行 xref_build 构建索引。
 *
 * 注册链：
 *   factory.ts → new XrefQueryTool(manager) → toolRegistry.register()
 */

import type { Tool } from '../interface.js';
import type { XrefManager } from './manager.js';
import type { QueryAction, SymbolKind } from './schema.js';

const ACTIONS: QueryAction[] = [
  'refs', 'defs', 'callers', 'callees',
  'deps', 'dependents', 'hierarchy', 'impact', 'trace',
  'symbol_search',
];

export class XrefQueryTool implements Tool {
  readonly name = 'xref_query';
  readonly description =
    'Query the cross-reference index (built by xref_build). Supports 10 actions:\n\n' +
    'L1 — Symbol queries:\n' +
    '  - "refs": find all references to a symbol across the project\n' +
    '  - "defs": find where a symbol is defined (with signature)\n' +
    '  - "callers": who calls this function?\n' +
    '  - "callees": what does this function call? (supports depth for call chain)\n\n' +
    'L2 — File dependency queries:\n' +
    '  - "deps": what modules does this file import?\n' +
    '  - "dependents": what files import this file?\n' +
    '  - "symbol_search": which files import a given symbol? (across all imports)\n\n' +
    'L3 — Structural queries:\n' +
    '  - "hierarchy": class inheritance tree (parents & children)\n' +
    '  - "impact": BFS — what files are affected if I change X? (supports depth)\n' +
    '  - "trace": data flow for a variable within a file (declaration, assignments, reads)\n\n' +
    'IMPORTANT: Run xref_build first before querying. ' +
    'Use "depth" to control traversal depth (default: 1-2). ' +
    'For callees/impact, larger depth = exponential growth — start small.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description:
          'Query action:\n' +
          'L1: "refs" | "defs" | "callers" | "callees"\n' +
          'L2: "deps" | "dependents"\n' +
          'L3: "hierarchy" | "impact" | "trace"',
      },
      symbol: {
        type: 'string',
        description:
          'Symbol name (function, class, variable, etc.). ' +
          'Required for: refs, defs, callers, callees, hierarchy, trace. ' +
          'Optional for: impact (filters by symbol).',
      },
      file: {
        type: 'string',
        description:
          'File path (relative to project root or absolute). ' +
          'Required for: deps, dependents, impact, trace. ' +
          'Optional for: refs, defs, callers, callees (narrows search scope).',
      },
      depth: {
        type: 'number',
        description:
          'Max traversal depth. Default: 1-2 depending on action. ' +
          'WARNING: larger depth = more results exponentially. ' +
          'Applies to: callees, impact.',
      },
      kind: {
        type: 'string',
        enum: ['function', 'method', 'arrow', 'class', 'interface', 'type', 'enum', 'variable', 'parameter', 'property'],
        description: 'Filter symbols by kind. Useful with "defs" when a name is overloaded.',
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: 'Output format. Default: "text" (human-readable). Use "json" for structured data.',
      },
    },
    required: ['action'],
  };

  private manager: XrefManager;

  constructor(manager: XrefManager) {
    this.manager = manager;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as QueryAction;
    const symbol = args.symbol as string | undefined;
    const file = args.file as string | undefined;
    const depth = args.depth as number | undefined;
    const kind = args.kind as SymbolKind | undefined;
    const format = (args.format as string | undefined) ?? 'text';

    if (!ACTIONS.includes(action)) {
      return `Unknown action: "${action}". Supported: ${ACTIONS.join(', ')}`;
    }

    // 验证必需参数
    const requiresSymbol = ['refs', 'defs', 'callers', 'callees', 'hierarchy', 'trace'];
    const requiresFile = ['deps', 'dependents', 'impact', 'trace'];

    if (requiresSymbol.includes(action) && !symbol) {
      return `Error: "symbol" is required for action "${action}".`;
    }
    if (requiresFile.includes(action) && !file) {
      return `Error: "file" is required for action "${action}".`;
    }

    if (!this.manager.isReady()) {
      return 'Error: Xref index not built. Run xref_build first to index the project.';
    }

    const result = this.manager.query({
      action,
      symbol,
      file,
      depth,
      kind,
      format: format as 'text' | 'json',
    });

    return result;
  }
}
