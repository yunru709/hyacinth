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
          '可选的 JSON 数组，目录路径（相对于项目根），用于限制扫描范围。' +
          '示例：["src/tools", "src/gateway"]。省略时扫描整个项目。' +
          '注意：设置后这些目录之外的文件保持不动（不会被摘除）。',
      },
      files: {
        type: 'string',
        description:
          '可选的 JSON 数组，要增量重新索引的文件路径。' +
          '省略时执行基于 mtime 的同步构建。' +
          '示例：["src/tools/xref.ts", "src/gateway/factory.ts"]',
      },
      clean: {
        type: 'boolean',
        description:
          '为 true 时，彻底删除当前项目的 xref 索引数据库。' +
          '可用于回收旧项目的磁盘空间，或强制全新重建。' +
          'clean 为 true 时不执行其他任何操作。',
      },
      force: {
        type: 'boolean',
        description:
          '为 true 时，忽略 mtime 重新解析每个扫描到的文件（全量重建语义）。' +
          '默认 false：仅解析变更/新增的文件，并摘除已删除的文件。',
      },
      project: {
        type: 'string',
        description:
          '可选，用于 "clean" 操作的项目路径。' +
          '与 clean=true 同时提供时，删除指定项目的 xref 数据库，而非当前项目。' +
          '可以是绝对路径，或项目名/项目键。',
      },
      batch_size: {
        type: 'number',
        description:
          '每批解析的文件数。数值越小内存占用越低，但速度越慢。' +
          '默认：50。最小：1，最大：500。仅适用于构建模式（clean 不适用）。',
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
