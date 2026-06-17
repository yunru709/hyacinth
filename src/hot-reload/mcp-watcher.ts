import fs from 'node:fs';
import path from 'node:path';
import type { MCPSystem } from '../mcp/system.js';
import { createLogger } from '../logging/logger.js';

interface McpWatcherDeps {
  mcpSystem: MCPSystem;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 MCP 配置文件变化，自动增/删/改 MCP Server 连接。
 *
 * 监听两个文件：.agent/mcp.json 和 .mcp.json。
 *
 * 使用 fs.watchFile（原因同 provider-watcher）：
 *   .agent/ 目录下文件变更频繁，fs.watch 会产生大量无效回调。
 *   fs.watchFile 以固定间隔 stat 轮询，对极少变更的配置文件开销更低。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watchMcpConfig(deps: McpWatcherDeps): any[] {
  const logger = createLogger('hot-reload:mcp');
  const { mcpSystem, cwd } = deps;

  const watchPaths = [
    path.join(cwd, '.agent', 'mcp.json'),
    path.join(cwd, '.mcp.json'),
  ];
  const POLL_INTERVAL_MS = 5_000; // 5s — 轻量 stat，对性能几乎无影响

  let handleLock = false;
  const lastMtimes = new Map<string, number>();

  for (const watchPath of watchPaths) {
    try {
      const stat = fs.statSync(watchPath);
      lastMtimes.set(watchPath, stat.mtimeMs);
    } catch {
      // 文件不存在
    }
  }

  async function handleChange(): Promise<void> {
    if (handleLock) return;
    handleLock = true;

    try {
      await mcpSystem.reload();
      logger.info('MCP configs reloaded via MCPSystem');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('failed to reload MCP configs', { error: msg });
    } finally {
      handleLock = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const watchers: any[] = [];

  for (const watchPath of watchPaths) {
    const watcher = fs.watchFile(watchPath, { interval: POLL_INTERVAL_MS }, (curr) => {
      const prev = lastMtimes.get(watchPath) ?? 0;
      if (curr.mtimeMs === prev) return;
      lastMtimes.set(watchPath, curr.mtimeMs);
      handleChange();
    });
    watchers.push(watcher);
  }

  return watchers;
}
