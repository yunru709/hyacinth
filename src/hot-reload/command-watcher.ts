/**
 * Slash Commands 热重载监听器
 *
 * 监听项目根目录的 commands.json 变动，
 * 文件修改后自动重新加载命令配置到 CommandRegistry。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface CommandWatcherDeps {
  cwd: string;
  debounceMs?: number;
}

async function reloadCommands(): Promise<void> {
  // 动态 import 避免循环依赖（修复：原 require() 在 ESM 下运行时必然抛错）
  const { CommandRegistry } = await import('../ui/command-registry.js');
  CommandRegistry.getInstance().reload();
}

/**
 * 监听 commands.json：change 触发 reload；文件被删除/重建（rename）后，
 * 重建的变更同样进入 reload 路径，reload 前检查文件存在性即可覆盖原
 * rename 重监听分支的语义。
 */
export function watchCommandsJson(deps: CommandWatcherDeps): WatcherHandle[] {
  const filePath = path.join(deps.cwd, 'commands.json');

  if (!fs.existsSync(filePath)) {
    // commands.json 是模型可写的外部配置，可能尚不存在；watch 单文件
    // 在 Windows 上对不存在路径会抛错，故监听父目录 + filename 过滤
  }

  return createWatcher({
    name: 'command-watcher',
    debounceMs: deps.debounceMs ?? 300,
    paths: () => [path.dirname(filePath)],
    filter: (filename) => filename === 'commands.json',
    reload: () => {
      if (!fs.existsSync(filePath)) return; // rename 删除场景：跳过
      return reloadCommands();
    },
  });
}
