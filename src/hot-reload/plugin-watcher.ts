import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginManager } from '../plugins/manager.js';
import { createLogger } from '../logging/logger.js';

interface PluginWatcherDeps {
  pluginManager: PluginManager;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听插件目录变化，自动重载插件。
 *
 * 监听两个目录：
 *   - .agent/plugins/
 *   - plugins/
 *
 * 任一目录发生变化时，debounce 后调用 pluginManager.loadAll() 重新扫描并协调。
 * loadAll() 是幂等的（内部检查 this.plugins.has(manifest.id)）。
 */
export function watchPluginsDir(deps: PluginWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:plugins');
  const userPluginsDir = path.join(os.homedir(), '.agent', 'plugins');
  try { fs.mkdirSync(userPluginsDir, { recursive: true }); } catch { /* ignore */ }

  const dirs: string[] = [userPluginsDir];
  const projectPluginsDir = path.join(deps.cwd, 'plugins');
  if (fs.existsSync(projectPluginsDir)) {
    dirs.push(projectPluginsDir);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  const watchers: fs.FSWatcher[] = [];
  for (const dir of dirs) {
    try {
      const watcher = fs.watch(dir, { recursive: false }, (_event, filename) => {
        if (!filename) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            logger.info('plugins directory changed, reloading...');
            await deps.pluginManager.loadAll();
            logger.info('plugins reloaded');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('plugin reload failed', { error: msg });
          }
        }, deps.debounceMs);
      });
      watchers.push(watcher);
    } catch {
      // 目录不存在或无法监听，静默跳过
    }
  }

  return watchers;
}