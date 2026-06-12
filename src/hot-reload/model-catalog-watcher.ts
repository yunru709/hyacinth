import fs from 'node:fs';
import path from 'node:path';
import { modelCatalog } from '../provider/catalog.js';
import { createLogger } from '../logging/logger.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';

interface ModelCatalogWatcherDeps {
  cwd: string;
  debounceMs: number;
  configCenter: RuntimeConfigCenter;
  currentModel: () => { provider: string; model: string } | undefined;
}

export function watchModelCatalogConfig(deps: ModelCatalogWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:model-catalog');
  const { cwd, debounceMs } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleChange(): void {
    try {
      modelCatalog.reload();
      logger.info('model catalog reloaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to reload model catalog', { error: msg });
      return;
    }

    try {
      const current = deps.currentModel();
      if (!current) return;
      const newMaxContext = getModelContextWindow(current.provider, current.model);
      // 仅当当前值超过新模型上限时才裁剪，不覆盖用户自定义的更小值
      const currentMaxContext = deps.configCenter.get<number>('session.maxContext');
      if (currentMaxContext && currentMaxContext <= newMaxContext) {
        logger.info('session.maxContext kept (user value within new model limit)', { current: currentMaxContext, newLimit: newMaxContext });
        return;
      }
      deps.configCenter.set('session.maxContext', newMaxContext);
      logger.info('session.maxContext synced after catalog reload', { maxContext: newMaxContext });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to sync session.maxContext after catalog reload', { error: msg });
    }
  }

  const watchDir = path.join(cwd, '.agent');
  const targetFile = 'models-catalog.json';

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