import fs from 'node:fs';
import path from 'node:path';
import { ManifestLoader } from '../context/manifest-loader.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:manifest-watcher');

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

export function watchContextManifest(deps: ManifestWatcherDeps): fs.FSWatcher[] {
  const manifestPath = path.join(deps.cwd, '.agent', 'context-manifest.json');
  const loader = getManifestLoader(deps.cwd);
  loader.load();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        loader.reload();
        logger.info('context-manifest.json reloaded');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to reload context-manifest.json', { error: msg });
      }
    }, deps.debounceMs);
  };

  const watcher = fs.watch(manifestPath, handleChange);
  watcher.on('error', (err) => {
    logger.warn(`Manifest watcher error: ${err.message}`);
  });

  logger.info(`Watching context manifest: ${manifestPath}`);
  return [watcher];
}
