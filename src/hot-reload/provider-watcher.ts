import os from 'node:os';
import path from 'node:path';
import { getProviderConfigLoader } from '../provider/config.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface ProviderWatcherDeps {
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 providers.json 文件变化，自动重载 Provider 配置。
 *
 * 使用 poll 模式（原因同 mcp-watcher）：providers.json 位于 .agent/ 目录，
 * 该目录下还有其他频繁写入的文件（sessions、kb.sqlite、scheduler 等），
 * fs.watch 会收到大量无效回调；固定间隔 stat 轮询仅在 mtime 变化时触发，
 * 对极少变更的配置文件开销更低。
 */
export function watchProviderConfig(deps: ProviderWatcherDeps): WatcherHandle[] {
  const watchPath = path.join(os.homedir(), '.agent', 'providers.json');

  return createWatcher({
    name: 'provider',
    mode: 'poll',
    paths: () => [watchPath],
    reload: async () => {
      await getProviderConfigLoader().reload();
    },
  });
}
