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

/**
 * 监听 models-catalog.json 文件变化，自动重载模型目录并同步 maxContext。
 *
 * 使用 fs.watchFile（原因同 provider-watcher）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watchModelCatalogConfig(deps: ModelCatalogWatcherDeps): any[] {
  const logger = createLogger('hot-reload:model-catalog');
  const { cwd } = deps;

  const watchPath = path.join(cwd, '.agent', 'models-catalog.json');
  const POLL_INTERVAL_MS = 5_000; // 5s — 轻量 stat，对性能几乎无影响

  let lastMtime = 0;
  try {
    const stat = fs.statSync(watchPath);
    lastMtime = stat.mtimeMs;
  } catch {
    // 文件不存在
  }

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

  const watcher = fs.watchFile(watchPath, { interval: POLL_INTERVAL_MS }, (curr) => {
    if (curr.mtimeMs === lastMtime) return;
    lastMtime = curr.mtimeMs;
    handleChange();
  });

  return [watcher];
}
