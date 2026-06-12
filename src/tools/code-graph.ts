import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from './interface.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import { FunctionParser } from '../dependency/function-parser.js';
import { DataFlowTracker } from '../dependency/data-flow-tracker.js';

const MAX_CALLER_CONTEXT = 3;
const MAX_CALLER_RESULTS = 30;
const MAX_CALLEES_DEPTH_RESULTS = 80;

export class CodeGraphTool implements Tool {
  readonly name = 'code_graph_query';
  readonly description =
    'Query the project dependency graph to navigate code structure without reading entire files. ' +
    'Supports 8 actions across 3 layers:\n\n' +
    'L1 (File layer — import graph):\n' +
    '- "impact": BFS — what files are affected if I change X?\n' +
    '- "deps": what does file X import?\n' +
    '- "dependents": what files import file X?\n' +
    '- "symbol_search": which files import symbol Y?\n\n' +
    'L2 (Function layer — call graph):\n' +
    '- "definition": where is symbol Y defined? (file:line + signature)\n' +
    '- "callers": which functions call Y? (file:line with context)\n' +
    '- "callees": what does function Y call? (with depth control for chain tracing)\n\n' +
    'L3 (Data flow layer — variable tracing):\n' +
    '- "trace": where is variable Y declared/assigned/read/returned?\n\n' +
    'IMPORTANT: Use "depth" parameter to control traversal depth. ' +
    'WARNING: Each additional depth layer can cause EXPONENTIAL growth in results. ' +
    'Best practice: start with depth=1, review results, then selectively trace deeper only on relevant paths. ' +
    'Do NOT use large depth values blindly.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['impact', 'deps', 'dependents', 'symbol_search', 'callers', 'definition', 'callees', 'trace'],
        description:
          'Query action:\n' +
          'L1: "impact" | "deps" | "dependents" | "symbol_search"\n' +
          'L2: "definition" | "callers" | "callees"\n' +
          'L3: "trace"',
      },
      file: {
        type: 'string',
        description:
          'Target file path (relative to project root or absolute). ' +
          'Required for: impact, deps, dependents, callees, trace. ' +
          'Optional for: definition (searches all candidate files if omitted), callers (narrows search scope).',
      },
      symbol: {
        type: 'string',
        description:
          'Symbol/variable name. Required for: symbol_search, callers, definition, trace. ' +
          'Optional for: impact (filters by symbol), callees (defaults to searching all functions in file).',
      },
      depth: {
        type: 'number',
        description:
          'Max traversal depth. Default: 1 (single layer). ' +
          'WARNING: each additional layer can cause EXPONENTIAL growth in results. ' +
          'Recommended: start with depth=1, review results, then selectively trace deeper. ' +
          'Applies to: impact, callees.',
      },
    },
    required: ['action'],
  };

  private analyzer: DependencyAnalyzer;
  private funcParser: FunctionParser;
  private flowTracker: DataFlowTracker;
  private rootDir: string;

  constructor(analyzer: DependencyAnalyzer) {
    this.analyzer = analyzer;
    this.funcParser = new FunctionParser();
    this.flowTracker = new DataFlowTracker();
    const graph = analyzer.getGraph();
    this.rootDir = graph?.rootDir ?? '';
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const graph = this.analyzer.getGraph();

    if (!graph) {
      return 'Dependency graph not available. The analyzer has not been initialized for this project.';
    }

    switch (action) {
      case 'impact':
        return this.handleImpact(args);
      case 'deps':
        return this.handleDeps(args);
      case 'dependents':
        return this.handleDependents(args);
      case 'symbol_search':
        return this.handleSymbolSearch(args);
      case 'callers':
        return await this.handleCallers(args);
      case 'definition':
        return await this.handleDefinition(args);
      case 'callees':
        return await this.handleCallees(args);
      case 'trace':
        return await this.handleTrace(args);
      default:
        return `Unknown action: "${action}". Supported: impact, deps, dependents, symbol_search, callers, definition, callees, trace`;
    }
  }

  // ─── L1: File Layer ──────────────────────────────────────────────

  private handleImpact(args: Record<string, unknown>): string {
    const file = args.file as string | undefined;
    if (!file) return 'Missing required parameter: file';

    const resolved = this.resolveFilePath(file);
    const symbol = args.symbol as string | undefined;
    const maxDepth = (args.depth as number | undefined) ?? undefined;
    const graph = this.analyzer.getGraph()!;

    const normalizedFile = resolved.replace(/\\/g, '/');
    const visited = new Set<string>();
    const queue: { file: string; depth: number }[] = [{ file: normalizedFile, depth: 0 }];
    visited.add(normalizedFile);

    const layers: Map<number, string[]> = new Map();

    while (queue.length > 0) {
      const { file: current, depth } = queue.shift()!;
      const dependees = graph.dependees.get(current) ?? [];

      for (const dep of dependees) {
        const normalizedDep = dep.replace(/\\/g, '/');
        if (visited.has(normalizedDep)) continue;
        visited.add(normalizedDep);

        if (symbol) {
          const relevantDeps = graph.dependencies.filter(
            d => d.from.replace(/\\/g, '/') === normalizedDep && d.symbols.includes(symbol),
          );
          if (relevantDeps.length === 0) continue;
        }

        const nextDepth = depth + 1;
        if (maxDepth !== undefined && nextDepth > maxDepth) continue;

        const layer = layers.get(nextDepth) ?? [];
        layer.push(normalizedDep);
        layers.set(nextDepth, layer);

        if (maxDepth === undefined || nextDepth < maxDepth) {
          queue.push({ file: normalizedDep, depth: nextDepth });
        }
      }
    }

    if (layers.size === 0) {
      const suffix = symbol ? ` (symbol: ${symbol})` : '';
      return `No files are affected by changing ${this.toRelative(resolved)}${suffix}`;
    }

    const lines: string[] = [];
    const suffix = symbol ? ` (symbol: ${symbol})` : '';
    const depthInfo = maxDepth !== undefined ? ` (max depth: ${maxDepth})` : ' (full traversal)';
    lines.push(`Impact of changing ${this.toRelative(resolved)}${suffix}${depthInfo}:`);

    const sortedDepths = [...layers.keys()].sort((a, b) => a - b);
    for (const d of sortedDepths) {
      const files = layers.get(d)!;
      lines.push(`  Layer ${d} (${files.length} files):`);
      for (const f of files) {
        lines.push(`    - ${this.toRelative(f)}`);
      }
    }

    const total = [...layers.values()].reduce((sum, arr) => sum + arr.length, 0);
    lines.push(`  Total: ${total} files across ${layers.size} layers`);

    if (maxDepth !== undefined) {
      lines.push(`  Tip: call impact again with file=<path> and depth=1 to trace deeper from specific files`);
    }

    return lines.join('\n');
  }

  private handleDeps(args: Record<string, unknown>): string {
    const file = args.file as string | undefined;
    if (!file) return 'Missing required parameter: file';

    const resolved = this.resolveFilePath(file);
    const graph = this.analyzer.getGraph()!;
    const deps = graph.dependents.get(resolved.replace(/\\/g, '/'));

    if (!deps || deps.length === 0) {
      return `${this.toRelative(resolved)} has no dependencies`;
    }

    const lines: string[] = [];
    lines.push(`${this.toRelative(resolved)} depends on (${deps.length}):`);

    const edges = graph.dependencies.filter(
      d => d.from.replace(/\\/g, '/') === resolved.replace(/\\/g, '/'),
    );

    for (const dep of deps) {
      const edge = edges.find(e => e.to.replace(/\\/g, '/') === dep.replace(/\\/g, '/'));
      const symbols = edge?.symbols.length ? ` {${edge.symbols.join(', ')}}` : '';
      const importType = edge ? ` [${edge.importType}]` : '';
      lines.push(`  - ${this.toRelative(dep)}${importType}${symbols}`);
    }

    return lines.join('\n');
  }

  private handleDependents(args: Record<string, unknown>): string {
    const file = args.file as string | undefined;
    if (!file) return 'Missing required parameter: file';

    const resolved = this.resolveFilePath(file);
    const graph = this.analyzer.getGraph()!;
    const dependees = graph.dependees.get(resolved.replace(/\\/g, '/'));

    if (!dependees || dependees.length === 0) {
      return `No files depend on ${this.toRelative(resolved)}`;
    }

    const lines: string[] = [];
    lines.push(`Files that depend on ${this.toRelative(resolved)} (${dependees.length}):`);

    const edges = graph.dependencies.filter(
      d => d.to.replace(/\\/g, '/') === resolved.replace(/\\/g, '/'),
    );

    for (const dep of dependees) {
      const edge = edges.find(e => e.from.replace(/\\/g, '/') === dep.replace(/\\/g, '/'));
      const symbols = edge?.symbols.length ? ` {${edge.symbols.join(', ')}}` : '';
      lines.push(`  - ${this.toRelative(dep)}${symbols}`);
    }

    return lines.join('\n');
  }

  private handleSymbolSearch(args: Record<string, unknown>): string {
    const symbol = args.symbol as string | undefined;
    if (!symbol) return 'Missing required parameter: symbol';

    const graph = this.analyzer.getGraph()!;
    const matches = graph.dependencies.filter(d => d.symbols.includes(symbol));

    if (matches.length === 0) {
      return `No files import symbol "${symbol}"`;
    }

    const lines: string[] = [];
    lines.push(`Files importing "${symbol}" (${matches.length} edges):`);

    for (const dep of matches) {
      lines.push(`  - ${this.toRelative(dep.from)} → ${this.toRelative(dep.to)} [${dep.importType}]`);
    }

    return lines.join('\n');
  }

  // ─── L2: Function Layer ──────────────────────────────────────────

  private async handleCallers(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    if (!symbol) return 'Missing required parameter: symbol';

    const graph = this.analyzer.getGraph()!;

    const importEdges = graph.dependencies.filter(d => d.symbols.includes(symbol));
    const candidateFiles = new Set(importEdges.map(d => d.from.replace(/\\/g, '/')));
    for (const edge of importEdges) {
      candidateFiles.add(edge.to.replace(/\\/g, '/'));
    }

    const fileHint = args.file as string | undefined;
    if (fileHint) {
      const resolved = this.resolveFilePath(fileHint);
      const dependees = graph.dependees.get(resolved.replace(/\\/g, '/')) ?? [];
      for (const d of dependees) candidateFiles.add(d.replace(/\\/g, '/'));
      candidateFiles.add(resolved.replace(/\\/g, '/'));
    }

    if (candidateFiles.size === 0) {
      candidateFiles.add(this.rootDir.replace(/\\/g, '/'));
    }

    const callPatterns = this.buildCallPatterns(symbol);
    const results: { file: string; line: number; text: string; context: string[] }[] = [];

    for (const filePath of candidateFiles) {
      if (results.length >= MAX_CALLER_RESULTS) break;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_CALLER_RESULTS) break;

          for (const pattern of callPatterns) {
            if (pattern.test(lines[i])) {
              results.push({
                file: filePath,
                line: i + 1,
                text: lines[i].trim(),
                context: this.extractContext(lines, i),
              });
              break;
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (results.length === 0) {
      return `No callers found for "${symbol}" in ${candidateFiles.size} candidate files. ` +
        `Try using grep tool with pattern "${symbol}\\(" for a broader search.`;
    }

    const lines: string[] = [];
    lines.push(`Callers of "${symbol}" (${results.length} found in ${candidateFiles.size} candidate files):`);

    for (const r of results) {
      lines.push(`  ${this.toRelative(r.file)}:${r.line}`);
      lines.push(`    ${r.text}`);
      for (const ctx of r.context) {
        lines.push(`    ${ctx}`);
      }
    }

    lines.push(`Tip: use "callers" with the calling function name to trace the call chain further`);

    return lines.join('\n');
  }

  private async handleDefinition(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    if (!symbol) return 'Missing required parameter: symbol';

    const graph = this.analyzer.getGraph()!;

    const candidateFiles = new Set<string>();
    const importEdges = graph.dependencies.filter(d => d.symbols.includes(symbol));
    for (const edge of importEdges) {
      candidateFiles.add(edge.to.replace(/\\/g, '/'));
      candidateFiles.add(edge.from.replace(/\\/g, '/'));
    }

    const fileHint = args.file as string | undefined;
    if (fileHint) {
      candidateFiles.add(this.resolveFilePath(fileHint).replace(/\\/g, '/'));
    }

    if (candidateFiles.size === 0) {
      for (const f of graph.files) {
        candidateFiles.add(f.replace(/\\/g, '/'));
      }
    }

    const defs = await this.funcParser.findDefinitions(symbol, [...candidateFiles]);

    if (defs.length === 0) {
      return `No definition found for "${symbol}" in ${candidateFiles.size} candidate files. ` +
        `The symbol may be defined in node_modules or external packages.`;
    }

    const lines: string[] = [];
    lines.push(`Definition(s) of "${symbol}" (${defs.length}):`);

    for (const def of defs) {
      lines.push(`  [${def.kind}] ${this.toRelative(def.file)}:${def.line}`);
      lines.push(`    ${def.signature}`);
      const flags: string[] = [];
      if (def.isExported) flags.push('exported');
      if (def.isAsync) flags.push('async');
      if (flags.length) lines.push(`    (${flags.join(', ')})`);
    }

    lines.push(`Tip: use "callees" to see what ${symbol} calls, or "callers" to see who calls it`);

    return lines.join('\n');
  }

  private async handleCallees(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    const file = args.file as string | undefined;
    const maxDepth = (args.depth as number | undefined) ?? 1;

    if (!symbol && !file) return 'Missing required parameter: provide symbol (function name) or file';

    const targetFunc = symbol;
    const targetFile = file ? this.resolveFilePath(file) : undefined;

    if (!targetFunc) {
      return 'Missing required parameter: symbol (function name to analyze)';
    }
    if (!targetFile) {
      return 'Missing required parameter: file (where the function is defined)';
    }

    const lines: string[] = [];
    lines.push(`Callees of "${targetFunc}" in ${this.toRelative(targetFile)} (max depth: ${maxDepth}):`);

    const totalResults = await this.traceCallees(targetFunc, targetFile, maxDepth, lines, new Set(), 1);

    if (totalResults === 0) {
      return `Function "${targetFunc}" not found or has no calls in ${this.toRelative(targetFile)}`;
    }

    lines.push(`Tip: use "callers" to trace who calls these functions, or increase depth to trace deeper`);

    return lines.join('\n');
  }

  private async traceCallees(
    funcName: string,
    file: string,
    maxDepth: number,
    output: string[],
    visited: Set<string>,
    currentDepth: number,
  ): Promise<number> {
    const key = `${funcName}@${file}`;
    if (visited.has(key)) return 0;
    visited.add(key);

    const callees = await this.funcParser.findCallees(funcName, file);
    if (callees.length === 0) return 0;

    let count = 0;
    const indent = '  '.repeat(currentDepth);

    for (const call of callees) {
      if (count >= MAX_CALLEES_DEPTH_RESULTS) break;

      const prefix = call.isNew ? 'new ' : '';
      const receiver = call.receiver ? `${call.receiver}.` : '';
      output.push(`${indent}- ${prefix}${receiver}${call.name} (${this.toRelative(call.file)}:${call.line})`);
      count++;

      if (currentDepth < maxDepth) {
        const graph = this.analyzer.getGraph()!;
        const importEdges = graph.dependencies.filter(
          d => d.from.replace(/\\/g, '/') === call.file.replace(/\\/g, '/') && d.symbols.includes(call.name),
        );

        if (importEdges.length > 0) {
          const defFile = importEdges[0].to.replace(/\\/g, '/');
          const subCount = await this.traceCallees(call.name, defFile, maxDepth, output, visited, currentDepth + 1);
          count += subCount;
        }
      }
    }

    return count;
  }

  // ─── L3: Data Flow Layer ─────────────────────────────────────────

  private async handleTrace(args: Record<string, unknown>): Promise<string> {
    const symbol = args.symbol as string | undefined;
    if (!symbol) return 'Missing required parameter: symbol (variable name to trace)';

    const file = args.file as string | undefined;
    if (!file) return 'Missing required parameter: file (where the variable is used)';

    const resolved = this.resolveFilePath(file);
    const points = await this.flowTracker.trace(symbol, resolved);

    if (points.length === 0) {
      return `No data flow found for variable "${symbol}" in ${this.toRelative(resolved)}. ` +
        `The variable may not exist in this file or may use a different name.`;
    }

    const lines: string[] = [];
    lines.push(`Data flow for "${symbol}" in ${this.toRelative(resolved)} (${points.length} points):`);

    const kindOrder: Record<string, number> = {
      declaration: 0,
      destructuring: 1,
      assignment: 2,
      read: 3,
      argument: 4,
      return: 5,
    };

    const sorted = [...points].sort((a, b) => {
      const ka = kindOrder[a.kind] ?? 99;
      const kb = kindOrder[b.kind] ?? 99;
      if (ka !== kb) return ka - kb;
      return a.line - b.line;
    });

    let currentKind = '';
    for (const p of sorted) {
      if (p.kind !== currentKind) {
        currentKind = p.kind;
        const kindLabel = {
          declaration: 'Declaration',
          destructuring: 'Destructuring',
          assignment: 'Assignment',
          read: 'Read',
          argument: 'Passed as argument',
          return: 'Returned',
        }[p.kind] ?? p.kind;
        const kindPoints = sorted.filter(pp => pp.kind === p.kind).length;
        lines.push(`  ${kindLabel} (${kindPoints}):`);
      }

      lines.push(`    L${p.line}: ${p.text}`);
      for (const ctx of p.context) {
        lines.push(`      ${ctx}`);
      }
    }

    lines.push(`Tip: use "trace" on related variables or "callers" on functions that use this variable to trace further`);

    return lines.join('\n');
  }

  // ─── Utilities ───────────────────────────────────────────────────

  private buildCallPatterns(symbol: string): RegExp[] {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      new RegExp(`\\b${escaped}\\s*\\(`),
      new RegExp(`\\b${escaped}\\s*<`),
      new RegExp(`\\.${escaped}\\s*\\(`),
    ];
  }

  private extractContext(lines: string[], matchIndex: number): string[] {
    const context: string[] = [];
    const start = Math.max(0, matchIndex - MAX_CALLER_CONTEXT);
    const end = Math.min(lines.length - 1, matchIndex + MAX_CALLER_CONTEXT);

    for (let i = start; i <= end; i++) {
      if (i === matchIndex) continue;
      context.push(`  ${i + 1}: ${lines[i].trimEnd()}`);
    }

    return context;
  }

  private resolveFilePath(file: string): string {
    if (path.isAbsolute(file)) return file.replace(/\\/g, '/');
    return path.resolve(this.rootDir, file).replace(/\\/g, '/');
  }

  private toRelative(absPath: string): string {
    const normalized = absPath.replace(/\\/g, '/');
    const rootNormalized = this.rootDir.replace(/\\/g, '/');
    if (normalized.startsWith(rootNormalized + '/')) {
      return normalized.slice(rootNormalized.length + 1);
    }
    if (normalized.startsWith(rootNormalized)) {
      return normalized.slice(rootNormalized.length) || '.';
    }
    return normalized;
  }
}
