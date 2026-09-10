import os from 'node:os';
import path from 'node:path';
import { modelCatalog } from '../provider/catalog.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface ModelCatalogWatcherDeps {
  cwd: string;
  debounceMs: number;
  configCenter: RuntimeConfigCenter;
  currentModel: () => { provider: string; model: string } | undefined;
}

/**
 * 监听 providers.json 文件变化，自动重载模型目录并同步 maxContext。
 *
 * 模型数据源已统一到 providers.json（原 models-catalog.json 已并入）：
 *  - provider-watcher 负责 ProviderConfigLoader.reload()
 *  - 本 watcher 负责 ModelCatalog.reload() + session.maxContext 同步
 *
 * 使用 poll 模式（原因同 provider-watcher）。
 */
export function watchModelCatalogConfig(deps: ModelCatalogWatcherDeps): WatcherHandle[] {
  const watchPath = path.join(os.homedir(), '.agent', 'providers.json');

  return createWatcher({
    name: 'model-catalog',
    mode: 'poll',
    paths: () => [watchPath],
    reload: () => {
      modelCatalog.reload();

      // 目录重载成功后同步 session.maxContext（同步失败不影响下次监听）
      try {
        const current = deps.currentModel();
        if (!current) return;
        const newMaxContext = getModelContextWindow(current.provider, current.model);
        const currentMaxContext = deps.configCenter.get<number>('session.maxContext');
        if (currentMaxContext && currentMaxContext <= newMaxContext) {
          return; // 用户值在新模型上限内，保留
        }
        deps.configCenter.set('session.maxContext', newMaxContext);
      } catch {
        // maxContext 同步失败不影响目录已重载的结果
      }
    },
  });
}
