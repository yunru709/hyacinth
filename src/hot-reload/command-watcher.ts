/**
 * Slash Commands 热重载监听器
 *
 * 监听项目根目录的 commands.json 变动，
 * 文件修改后自动重新加载命令配置到 CommandRegistry。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:command-watcher');

interface CommandWatcherDeps {
  cwd: string;
  debounceMs?: number;
}

export function watchCommandsJson(deps: CommandWatcherDeps): fs.FSWatcher {
  const filePath = path.join(deps.cwd, 'commands.json');
  const debounceMs = deps.debounceMs ?? 300;

  if (!fs.existsSync(filePath)) {
    logger.debug('commands.json not found, watcher will activate if created');
  }

  const watcher = fs.watch(filePath, { persistent: false }, () => {
    setTimeout(() => {
      logger.info('commands.json changed, reloading...');
      try {
        // 延迟加载避免循环依赖
        const { CommandRegistry } = require('../ui/command-registry.js');
        CommandRegistry.getInstance().reload();
        logger.info('Slash commands reloaded from commands.json');
      } catch (err) {
        logger.warn('Failed to reload commands.json', { error: (err as Error).message });
      }
    }, debounceMs);
  });

  watcher.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Command watcher error', { error: err.message });
    }
  });

  watcher.on('rename', () => {
    // 文件被删除/重命名后重新添加监听
    setTimeout(() => {
      if (fs.existsSync(filePath)) {
        logger.info('commands.json recreated, reloading...');
        try {
          const { CommandRegistry } = require('../ui/command-registry.js');
          CommandRegistry.getInstance().reload();
        } catch (err) {
          logger.warn('Failed to reload commands.json', { error: (err as Error).message });
        }
      }
    }, debounceMs);
  });

  logger.debug(`Watching ${filePath}`);

  return watcher;
}