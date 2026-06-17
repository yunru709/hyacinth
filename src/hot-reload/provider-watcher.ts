import fs from 'node:fs';
import path from 'node:path';
import { getProviderConfigLoader } from '../provider/config.js';
import { createLogger } from '../logging/logger.js';

interface ProviderWatcherDeps {
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 providers.json 文件变化，自动重载 Provider 配置。
 *
 * 使用 fs.watchFile 而非 fs.watch：
 *   providers.json 位于 .agent/ 目录中，该目录下还有其他频繁写入的文件
 *   （sessions、kb.sqlite、scheduler 等）。fs.watch 会收到所有这些文件的变更事件，
 *   导致大量无效回调。fs.watchFile 以固定间隔 stat 轮询，仅在文件 mtime 变化时触发，
 *   对于极少变更的配置文件来说开销更低。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watchProviderConfig(deps: ProviderWatcherDeps): any[] {
  const logger = createLogger('hot-reload:provider');
  const { cwd } = deps;

  const watchPath = path.join(cwd, '.agent', 'providers.json');
  const POLL_INTERVAL_MS = 5_000; // 5s — 轻量 stat，对性能几乎无影响

  let lastMtime = 0;
  try {
    const stat = fs.statSync(watchPath);
    lastMtime = stat.mtimeMs;
  } catch {
    // 文件不存在，下次创建时会触发
  }

  const watcher = fs.watchFile(watchPath, { interval: POLL_INTERVAL_MS }, async (curr) => {
    if (curr.mtimeMs === lastMtime) return;
    lastMtime = curr.mtimeMs;

    try {
      const loader = getProviderConfigLoader();
      await loader.reload();
      logger.info('provider config reloaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to reload provider config', { error: msg });
    }
  });

  return [watcher];
}
