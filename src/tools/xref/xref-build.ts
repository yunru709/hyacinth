/**
 * xref_build — 构建/清理交叉引用索引。
 *
 * 扫描项目源码，使用 AST 解析器解析，存入 SQLite 索引数据库。
 * 支持全量构建、增量更新、目录过滤、数据库删除。
 *
 * 注册链：
 *   factory.ts → new XrefBuildTool(manager) → toolRegistry.register()
 */

import type { Tool } from '../interface.js';
import type { XrefManager } from './manager.js';

export class XrefBuildTool implements Tool {
  readonly name = 'xref_build';
  readonly description =
    '构建或管理项目的交叉引用索引。使用 AST 解析器扫描源码，将符号定义、引用和导入依赖存入 SQLite 数据库。' +
    '使用 xref_query 或 xref_graph 之前必须先执行一次。\n\n' +
    '四种模式：\n' +
    '  1. 同步构建（默认）：扫描项目，只重新解析 mtime 变更的文件，并摘除已删除的文件。' +
    '重复调用代价极低，可以放心在每次会话开始时调用以保持索引新鲜\n' +
    '  2. 目录过滤构建：传 "directories" 限制扫描范围\n' +
    '  3. 增量更新：传 "files" 仅重新索引指定文件\n' +
    '  4. 清理：传 clean=true 删除索引库（下次查询需重建）\n\n' +
    '传 force=true 可忽略 mtime 强制全量重解析（改了解析器或怀疑索引损坏时用）。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      directories: {
        type: 'string',
        description:
          'Optional JSON array of directory paths (relative to project root) to limit the scan. ' +
          'Example: ["src/tools", "src/gateway"]. If omitted, scans the entire project. ' +
          'Note: when set, files outside these directories are left untouched (not pruned).',
      },
      files: {
        type: 'string',
        description:
          'Optional JSON array of file paths to incrementally re-index. ' +
          'If omitted, performs a mtime-based sync build. ' +
          'Example: ["src/tools/xref.ts", "src/gateway/factory.ts"]',
      },
      clean: {
        type: 'boolean',
        description:
          'If true, deletes the current project\'s xref index database entirely. ' +
          'Use this to reclaim disk space for old projects or force a fresh rebuild. ' +
          'No other action is performed when clean is true.',
      },
      force: {
        type: 'boolean',
        description:
          'If true, re-parse every scanned file regardless of mtime (full rebuild semantics). ' +
          'Default false: only changed/new files are parsed, deleted files are pruned.',
      },
      project: {
        type: 'string',
        description:
          'Optional project path for "clean" action. ' +
          'If provided with clean=true, deletes the xref database for the specified project instead of the current one. ' +
          'Can be an absolute path or a project name/key.',
      },
      batch_size: {
        type: 'number',
        description:
          'Number of files to parse per batch. Lower values use less memory but slower. ' +
          'Default: 50. Min: 1, Max: 500. Only applies to build mode (not clean).',
      },
    },
    required: [],
  };

  private manager: XrefManager;

  constructor(manager: XrefManager) {
    this.manager = manager;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const clean = args.clean as boolean | undefined;
    const project = args.project as string | undefined;

    // ── clean 模式：删除数据库（await：删除已完成再回话，不再"发射即忘"）──
    if (clean) {
      return await this.manager.deleteDatabase(project);
    }

    // ── build 模式 ──
    if (!this.manager.isReady()) {
      return 'Error: XrefManager not initialized. The session may not have a project directory.';
    }

    // 解析 directories 参数
    const dirsRaw = args.directories as string | undefined;
    let dirs: string[] | undefined;
    if (dirsRaw) {
      try {
        dirs = JSON.parse(dirsRaw);
        if (!Array.isArray(dirs)) {
          return 'Error: "directories" must be a JSON array of directory paths.';
        }
      } catch {
        return 'Error: "directories" must be a valid JSON array string.';
      }
    }

    // 解析 files 参数
    const filesRaw = args.files as string | undefined;
    let changedFiles: string[] | undefined;
    if (filesRaw) {
      try {
        changedFiles = JSON.parse(filesRaw);
        if (!Array.isArray(changedFiles)) {
          return 'Error: "files" must be a JSON array of file paths.';
        }
      } catch {
        return 'Error: "files" must be a valid JSON array string.';
      }
    }

    const force = args.force === true;
    const isIncremental = changedFiles && changedFiles.length > 0;
    const isFiltered = dirs && dirs.length > 0;
    let modeLabel: string;
    if (isIncremental) {
      modeLabel = `incremental (${changedFiles!.length} files)`;
    } else if (force) {
      modeLabel = 'force full rebuild';
    } else if (isFiltered) {
      modeLabel = `sync, filtered (${dirs!.length} dirs: ${dirs!.join(', ')})`;
    } else {
      modeLabel = 'sync (mtime-based)';
    }

    // 解析 batch_size（默认 50，范围 1-500）
    const batchSize = typeof args.batch_size === 'number' ? args.batch_size : 50;

    try {
      const stats = await this.manager.build(changedFiles, dirs, batchSize, { force });
      const lines: string[] = [];
      lines.push(`✅ Cross-reference index built successfully (${modeLabel}).`);
      lines.push('');
      lines.push(`  Files indexed:   ${stats.files}`);
      if (stats.parsed_files !== undefined) lines.push(`  Parsed now:      ${stats.parsed_files}`);
      if (stats.unchanged_files) lines.push(`  Unchanged:       ${stats.unchanged_files} (mtime 未变，跳过解析)`);
      // 解析器分布：库里哪些数据出自 AST、哪些出自正则兜底（降级可查）
      if (stats.parser_breakdown && Object.keys(stats.parser_breakdown).length > 0) {
        const parts = Object.entries(stats.parser_breakdown).map(([k, v]) => `${k}: ${v}`).join(', ');
        lines.push(`  Parser:          ${parts}`);
      }
      if (stats.removed_files) lines.push(`  Removed:         ${stats.removed_files} (已从磁盘消失，摘除索引)`);
      if (stats.failed_files) lines.push(`  Failed to parse: ${stats.failed_files}`);
      lines.push(`  Symbols found:   ${stats.symbols}`);
      lines.push(`  References:      ${stats.refs}`);
      lines.push(`  Import edges:    ${stats.imports}`);
      if (stats.unresolved_imports) {
        lines.push(`  Unresolved imports: ${stats.unresolved_imports}  ← 项目内说明符未解析到文件，依赖图会缺这些边`);
        for (const s of stats.unresolved_samples ?? []) lines.push(`      · ${s}`);
      }
      if (stats.external_imports) lines.push(`  External imports:   ${stats.external_imports} (npm/标准库，设计上不入图)`);
      lines.push(`  Duration:        ${stats.duration_ms}ms`);
      if (Object.keys(stats.language_breakdown).length > 0) {
        lines.push('  Language breakdown:');
        for (const [lang, count] of Object.entries(stats.language_breakdown)) {
          lines.push(`    ${lang}: ${count} files`);
        }
      }
      return lines.join('\n');
    } catch (err) {
      return `Error building index: ${(err as Error).message}`;
    }
  }
}
