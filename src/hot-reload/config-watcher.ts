import path from 'node:path';
import os from 'node:os';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface ConfigWatcherDeps {
  configCenter: RuntimeConfigCenter;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 config.json 文件变化，自动重载运行时配置。
 *
 * 监听两个文件：
 *   - ~/.agent/config.json（全局配置）
 *   - <cwd>/.agent/config.json（项目配置）
 *
 * 任一文件发生变化时，debounce 后调用 configCenter.load() 重新加载并
 * diff 变更事件。shouldSkip 跳过自身 save() 触发的文件变更，避免竞态覆盖。
 */
export function watchConfigJson(deps: ConfigWatcherDeps): WatcherHandle[] {
  return createWatcher({
    name: 'config',
    debounceMs: deps.debounceMs,
    paths: () => [
      path.join(os.homedir(), '.agent', 'config.json'),
      path.join(deps.cwd, '.agent', 'config.json'),
    ],
    shouldSkip: () => deps.configCenter.isSaving,
    reload: async () => {
      await deps.configCenter.load();
    },
  });
}
