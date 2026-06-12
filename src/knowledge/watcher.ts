/**
 * 知识库文件监控器
 *
 * 使用 chokidar 监听知识库 files/ 目录的文件变更，
 * 自动触发索引增/改/删，无需手动调用 kb_add。
 *
 * 启动时执行全量同步，确保索引与文件系统一致。
 */

import type { Retriever } from './retriever.js';
import { updateFile, removeFile, syncDirectory } from './indexer.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('kb-watcher');

export interface WatcherOptions {
  /** 知识库文件目录 */
  filesDir: string;
  /** 检索后端 */
  retriever: Retriever;
}

export class KnowledgeWatcher {
  private watcher: import('chokidar').FSWatcher | null = null;
  private filesDir: string;
  private retriever: Retriever;
  private _ready = false;

  constructor(opts: WatcherOptions) {
    this.filesDir = opts.filesDir;
    this.retriever = opts.retriever;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** 启动监控 + 初始同步 */
  async start(): Promise<void> {
    // 动态导入 chokidar（可选依赖，未安装时降级）
    let chokidar: typeof import('chokidar');
    try {
      chokidar = await import('chokidar');
    } catch {
      logger.warn(
        'chokidar not installed. File watching disabled. Install with: pnpm add chokidar',
      );
      return;
    }

    const fs = await import('node:fs');
    const nodePath = await import('node:path');

    // 确保目录存在
    fs.mkdirSync(this.filesDir, { recursive: true });

    // 启动时全量同步
    const { added, removed } = await syncDirectory(this.retriever, this.filesDir);
    if (added > 0 || removed > 0) {
      logger.info(`Startup sync: +${added} -${removed} files`);
    }

    // 防抖：短时间内同一文件的多次事件合并
    const pending = new Map<string, NodeJS.Timeout>();
    const DEBOUNCE_MS = 300;

    function debounce(filePath: string, fn: () => void) {
      const existing = pending.get(filePath);
      if (existing) clearTimeout(existing);
      pending.set(
        filePath,
        setTimeout(() => {
          pending.delete(filePath);
          fn();
        }, DEBOUNCE_MS),
      );
    }

    // 启动文件监控
    this.watcher = chokidar.watch(this.filesDir, {
      ignoreInitial: true,
      ignored: [/(^|[\/\\])\.\./, '**/node_modules/**'],
      persistent: true,
      depth: 99,
    });

    this.watcher.on('add', (filePath: string) => {
      if (!isTextFile(filePath)) return;
      debounce(filePath, () => {
        logger.debug(`File added: ${nodePath.basename(filePath)}`);
        updateFile(this.retriever, filePath);
      });
    });

    this.watcher.on('change', (filePath: string) => {
      if (!isTextFile(filePath)) return;
      debounce(filePath, () => {
        logger.debug(`File changed: ${nodePath.basename(filePath)}`);
        updateFile(this.retriever, filePath);
      });
    });

    this.watcher.on('unlink', (filePath: string) => {
      debounce(filePath, () => {
        logger.debug(`File removed: ${nodePath.basename(filePath)}`);
        removeFile(this.retriever, filePath);
      });
    });

    this.watcher.on('error', (err: unknown) => {
      logger.error(
        'Watcher error',
        err instanceof Error ? err : new Error(String(err)),
      );
    });

    this._ready = true;
    logger.info(`Watching ${this.filesDir}`);
  }

  /** 停止监控 */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this._ready = false;
    logger.info('Watcher stopped');
  }
}

// ── 工具函数（与 indexer.ts 保持一致）────────────────────────────────

const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.html', '.htm', '.xml',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less',
  '.c', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.rb', '.php',
  '.sh', '.bat', '.ps1', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.csv', '.log', '.sql', '.r', '.m', '.swift',
]);

function isTextFile(filePath: string): boolean {
  const ext = (filePath.match(/\.[a-zA-Z0-9]+$/) ?? [''])[0].toLowerCase();
  return TEXT_EXTS.has(ext);
}
