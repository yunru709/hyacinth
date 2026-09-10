import path from 'node:path';
import { ManifestLoader } from '../context/manifest-loader.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

const loaderInstances = new Map<string, ManifestLoader>();

export function getManifestLoader(cwd: string): ManifestLoader {
  const key = path.resolve(cwd);
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
 * 监听 .agent/context-manifest.json 变更 → loader.reload()。
 */
export function watchContextManifest(deps: ManifestWatcherDeps): WatcherHandle[] {
  const loader = getManifestLoader(deps.cwd);
  loader.load();

  return createWatcher({
    name: 'manifest-watcher',
    debounceMs: deps.debounceMs,
    paths: () => [path.join(deps.cwd, '.agent', 'context-manifest.json')],
    reload: () => {
      loader.reload();
    },
  });
}
