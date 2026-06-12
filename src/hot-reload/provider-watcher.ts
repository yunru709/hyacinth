import fs from 'node:fs';
import path from 'node:path';
import { getProviderConfigLoader } from '../provider/config.js';
import { createLogger } from '../logging/logger.js';

interface ProviderWatcherDeps {
  cwd: string;
  debounceMs: number;
}

export function watchProviderConfig(deps: ProviderWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:provider');
  const { cwd, debounceMs } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;

  async function handleChange(): Promise<void> {
    try {
      const loader = getProviderConfigLoader();
      await loader.reload();
      logger.info('provider config reloaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to reload provider config', { error: msg });
    }
  }

  const watchDir = path.join(cwd, '.agent');
  const targetFile = 'providers.json';

  const watchers: fs.FSWatcher[] = [];

  try {
    const watcher = fs.watch(watchDir, (_event, filename) => {
      if (!filename || (filename !== targetFile && !filename.endsWith(path.sep + targetFile))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(handleChange, debounceMs);
    });
    watcher.on('error', (err) => {
      logger.warn('watcher error', { dir: watchDir, error: err.message });
    });
    watchers.push(watcher);
  } catch {
  }

  return watchers;
}