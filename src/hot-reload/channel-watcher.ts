import path from 'node:path';
import os from 'node:os';
import type { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface ChannelWatcherDeps {
  channelRegistry: ModelChannelRegistry;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 .agent/model-channels.json 文件变化，自动热重载 ModelChannelRegistry。
 *
 * P-Config 收敛后只监听全局文件：
 *   - ~/.agent/model-channels.json（全局配置；项目级已取消）
 *
 * 文件变化时，debounce 后调用 channelRegistry.reload()。
 */
export function watchModelChannels(deps: ChannelWatcherDeps): WatcherHandle[] {
  return createWatcher({
    name: 'channels',
    debounceMs: deps.debounceMs,
    paths: () => [
      path.join(os.homedir(), '.agent', 'model-channels.json'),
    ],
    reload: () => {
      deps.channelRegistry.reload();
    },
  });
}
