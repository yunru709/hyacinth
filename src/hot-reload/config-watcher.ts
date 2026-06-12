import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { createLogger } from '../logging/logger.js';

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
 * diff 变更事件。
 */
export function watchConfigJson(deps: ConfigWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:config');
  const { configCenter, cwd, debounceMs } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;

  async function handleChange(): Promise<void> {
    try {
      // 跳过自身 save() 触发的文件变更，避免竞态覆盖
      if (configCenter.isSaving) {
        logger.debug('skipping reload: save in progress');
        return;
      }
      logger.info('config.json changed, reloading...');
      await configCenter.load();
      logger.info('config reloaded from disk');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to reload config', { error: msg });
    }
  }

  const configPaths = [
    path.join(os.homedir(), '.agent', 'config.json'),
    path.join(cwd, '.agent', 'config.json'),
  ];

  const watchers: fs.FSWatcher[] = [];
  for (const configPath of configPaths) {
    try {
      const watcher = fs.watch(configPath, (_event, _filename) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(handleChange, debounceMs);
      });
      watcher.on('error', (err) => {
        logger.warn('watcher error', { path: configPath, error: err.message });
      });
      watchers.push(watcher);
    } catch {
      // 文件不存在或无法监听，静默跳过
    }
  }

  return watchers;
}