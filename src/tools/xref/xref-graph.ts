/**
 * xref_graph — 可视化调用图/依赖图。
 *
 * 将交叉引用关系输出为：
 *   - text:    缩进文本树（├── └── 风格）
 *   - mermaid: Mermaid.js 流程图（可在 Markdown 中渲染）
 *   - graphviz: Graphviz DOT 格式
 *
 * 需要先运行 xref_build 构建索引。
 *
 * 注册链：
 *   factory.ts → new XrefGraphTool(manager) → toolRegistry.register()
 */

import type { Tool } from '../interface.js';
import type { XrefManager } from './manager.js';
import type { GraphFormat } from './schema.js';

const FORMATS: GraphFormat[] = ['text', 'mermaid', 'graphviz'];

export class XrefGraphTool implements Tool {
  readonly name = 'xref_graph';
  readonly description =
    'Visualize the cross-reference graph as a text tree, Mermaid.js diagram, or Graphviz DOT. ' +
    'Supports two modes:\n' +
    '  1. Symbol-centered call graph — who calls this function, and what does it call?\n' +
    '  2. File-centered dependency graph — what files import/depend on this file?\n\n' +
    'Output formats:\n' +
    '  - "text": indented tree (├── └──), readable directly in terminal\n' +
    '  - "mermaid": Mermaid graph LR/flowchart, renderable in Markdown viewers\n' +
    '  - "graphviz": DOT digraph format for Graphviz renderers\n\n' +
    'Use "max_depth" to limit traversal (default: 3). ' +
    'Use "direction" to control call graph traversal: "callers" (up), "callees" (down), or "both" (default).';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description:
          'Symbol (function/class) to center the call graph on. ' +
          'If provided, generates a call graph. ' +
          'Mutually exclusive with "file". At least one is required.',
      },
      file: {
        type: 'string',
        description:
          'File path to center the dependency graph on. ' +
          'If provided, generates a file dependency graph. ' +
          'Mutually exclusive with "symbol". At least one is required.',
      },
      format: {
        type: 'string',
        enum: FORMATS,
        description: 'Output format. Default: "mermaid" (renderable in Markdown). "text" for terminal trees. "graphviz" for DOT.',
      },
      max_depth: {
        type: 'number',
        description: 'Max traversal depth for the graph. Default: 3. WARNING: larger depth = more nodes exponentially.',
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees', 'both'],
        description:
          'For symbol call graphs: traverse callers (who calls it), callees (what it calls), or both. Default: "both".',
      },
    },
    required: [],
  };

  private manager: XrefManager;

  constructor(manager: XrefManager) {
    this.manager = manager;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    const file = args.file as string | undefined;
    const format = (args.format as GraphFormat) ?? 'mermaid';
    const maxDepth = (args.max_depth as number | undefined) ?? 3;
    const direction = (args.direction as 'callers' | 'callees' | 'both' | undefined) ?? 'both';

    if (!symbol && !file) {
      return 'Error: at least one of "symbol" or "file" is required.';
    }

    if (!FORMATS.includes(format)) {
      return `Unknown format: "${format}". Supported: ${FORMATS.join(', ')}`;
    }

    if (!this.manager.isReady()) {
      return 'Error: Xref index not built. Run xref_build first to index the project.';
    }

    const result = this.manager.graph({
      format,
      symbol,
      file,
      max_depth: maxDepth,
      direction,
    });

    return result;
  }
}
