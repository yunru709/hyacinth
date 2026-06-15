import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { createLogger } from '../logging/logger.js';

interface ChannelWatcherDeps {
  channelRegistry: ModelChannelRegistry;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 .agent/model-channels.json 文件变化，自动热重载 ModelChannelRegistry。
 *
 * 监听两个文件：
 *   - ~/.agent/model-channels.json（全局配置）
 *   - <cwd>/.agent/model-channels.json（项目配置）
 *
 * 任一文件发生变化时，debounce 后调用 channelRegistry.reload()。
 */
export function watchModelChannels(deps: ChannelWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:channels');
  const { channelRegistry, cwd, debounceMs } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleChange(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        logger.info('model-channels.json changed, reloading...');
        channelRegistry.reload();
        logger.info('model channels reloaded');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('failed to reload model channels', { error: msg });
      }
    }, debounceMs);
  }

  const configPaths = [
    path.join(os.homedir(), '.agent', 'model-channels.json'),
    path.join(cwd, '.agent', 'model-channels.json'),
  ];

  const watchers: fs.FSWatcher[] = [];
  for (const configPath of configPaths) {
    try {
      const watcher = fs.watch(configPath, (_event, _filename) => {
        handleChange();
      });
      watcher.on('error', (err) => {
        logger.warn('watcher error', { path: configPath, error: err.message });
      });
      watchers.push(watcher);
    } catch {
      // 文件不存在或无法监听，静默跳过（首次保存时会自动创建）
    }
  }

  return watchers;
}
