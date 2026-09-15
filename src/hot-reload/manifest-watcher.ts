import path from 'node:path';
import os from 'node:os';
import { ManifestLoader } from '../context/manifest-loader.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

const loaderInstances = new Map<string, ManifestLoader>();

/**
 * 获取/缓存 ManifestLoader。
 * key 基于实际 manifest 文件路径（~/.agent/context-manifest.json）而非 cwd：
 * P-Config 收敛后 loader 只读全局文件，不同 cwd（或测试 mock homedir）必须
 * 各自持有独立实例，否则会读到上一个 homedir 的缓存 manifest。
 */
export function getManifestLoader(cwd: string): ManifestLoader {
  const key = path.join(os.homedir(), '.agent', 'context-manifest.json');
  let loader = loaderInstances.get(key);
  if (!loader) {
    loader = new ManifestLoader(key);
    loaderInstances.set(key, loader);
  }
  return loader;
}

export interface ManifestWatcherDeps {
  cwd: string;
  debounceMs: number;
}

/**
 * 监听全局 ~/.agent/context-manifest.json 变更 → loader.reload()。
 * P-Config 收敛：项目级已取消，只监听全局文件。
 */
export function watchContextManifest(deps: ManifestWatcherDeps): WatcherHandle[] {
  const loader = getManifestLoader(deps.cwd);
  loader.load();

  return createWatcher({
    name: 'manifest-watcher',
    debounceMs: deps.debounceMs,
    paths: () => [path.join(os.homedir(), '.agent', 'context-manifest.json')],
    reload: () => {
      loader.reload();
    },
  });
}
