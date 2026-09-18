/**
 * xref_query — 查询交叉引用索引。
 *
 * 支持 10 种查询操作：
 *   refs          — 查符号被哪些地方引用
 *   defs          — 查符号的定义位置
 *   callers       — 谁调用了该函数
 *   callees       — 该函数调用了谁
 *   deps          — 文件依赖了哪些模块
 *   dependents    — 哪些文件依赖了该文件
 *   symbol_search — 哪些文件导入了指定符号
 *   hierarchy     — 类的继承关系树
 *   impact        — 修改文件的影响面分析（BFS）
 *   trace         — 变量在文件内的数据流追踪
 *
 * 输出一律为人类可读文本（无 JSON 模式 —— 原 schema 曾声明 format: json
 * 但实现从未支持，属空承诺，已移除；需要结构化输出请在上层解析或另立需求）。
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
    '查询交叉引用索引（需先执行 xref_build）。支持 10 种查询：\n\n' +
    'L1 — 符号查询：\n' +
    '  - "refs": 查找项目中某符号的所有引用\n' +
    '  - "defs": 查找符号定义位置（含签名）\n' +
    '  - "callers": 谁调用了此函数？结果分「已确认」（调用者文件经导入链可到达定义文件）与\n' +
    '    「仅同名」（无导入关系，可能是同名异实体）两组——请优先采信前者；\n' +
    '    重名符号（如 build/get/init）请用 file 指定定义所在文件来消歧\n' +
    '  - "callees": 此函数调用了什么？（支持 depth 控制调用链深度）\n\n' +
    'L2 — 文件依赖查询：\n' +
    '  - "deps": 此文件导入了哪些模块？\n' +
    '  - "dependents": 哪些文件导入了此文件？\n' +
    '  - "symbol_search": 哪些文件导入了指定符号？\n\n' +
    'L3 — 结构查询：\n' +
    '  - "hierarchy": 类继承树（父类和子类）\n' +
    '  - "impact": BFS 影响面分析——修改 X 会影响哪些文件？\n' +
    '  - "trace": 变量在文件内的数据流（声明、赋值、读取）\n\n' +
    '重要提示：查询前必须先运行 xref_build。用 depth 控制遍历深度（默认 1-2）。callees/impact 查询深度越大结果指数增长——由浅入深。';
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
          'For "impact": optional — annotates which affected files actually reference the symbol ' +
          '(it does not filter: the impact set is determined by file imports).',
      },
      file: {
        type: 'string',
        description:
          'File path (relative to project root or absolute). ' +
          'Required for: deps, dependents, impact, trace. ' +
          'Optional for: refs, defs — restricts results to that file. ' +
          'For callers/callees — pins the symbol definition to that file, which is the only ' +
          'reliable way to disambiguate overloaded names (e.g. "build" is defined in dozens of files).',
      },
      depth: {
        type: 'number',
        description:
          'Max traversal depth. Default: 1-2 depending on action. ' +
          'WARNING: larger depth = more results exponentially. ' +
          'Applies to: callees (callee chain), impact (BFS layers), ' +
          'callers (how many import hops still count as "confirmed caller", default 2).',
      },
      kind: {
        type: 'string',
        enum: ['function', 'method', 'arrow', 'class', 'interface', 'type', 'enum', 'variable', 'parameter', 'property'],
        description: 'Filter symbols by kind. Useful with "defs" when a name is overloaded.',
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
    });

    return result;
  }
}
