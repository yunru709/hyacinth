import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:bundle-watcher');

export interface BundleWatcherDeps {
  registry: ToolBundleRegistry;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 .agent/tool-bundles.json 变更 → registry.reload()
 */
export function watchBundles(deps: BundleWatcherDeps): fs.FSWatcher {
  const { registry, cwd, debounceMs } = deps;
  const filePath = path.join(os.homedir(), '.agent', 'tool-bundles.json');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  logger.info(`Watching bundle config: ${filePath}`);

  // Use fs.watch on the directory (more reliable cross-platform than watching a single file)
  const watcher = fs.watch(path.dirname(filePath), (_eventType, filename) => {
    if (filename !== 'tool-bundles.json') return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        registry.reload();
        logger.info('Bundle config reloaded');
      } catch (err) {
        logger.warn(`Bundle reload failed: ${(err as Error).message}`);
      }
    }, debounceMs);
  });

  watcher.on('error', (err) => {
    logger.warn(`Bundle watcher error: ${err.message}`);
  });

  return watcher;
}
