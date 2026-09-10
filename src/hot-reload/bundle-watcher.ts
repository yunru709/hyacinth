import path from 'node:path';
import os from 'node:os';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

export interface BundleWatcherDeps {
  registry: ToolBundleRegistry;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 .agent/tool-bundles.json 变更 → registry.reload()
 *
 * 监听父目录（跨平台比监听单文件可靠），按 filename 过滤。
 */
export function watchBundles(deps: BundleWatcherDeps): WatcherHandle[] {
  const filePath = path.join(os.homedir(), '.agent', 'tool-bundles.json');

  return createWatcher({
    name: 'bundle-watcher',
    debounceMs: deps.debounceMs,
    paths: () => [path.dirname(filePath)],
    filter: (filename) => filename === 'tool-bundles.json',
    reload: () => {
      deps.registry.reload();
    },
  });
}
