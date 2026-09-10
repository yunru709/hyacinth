import type { MCPSystem } from '../mcp/system.js';
import { getMCPConfigPaths } from '../mcp/config.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface McpWatcherDeps {
  mcpSystem: MCPSystem;
  cwd: string;
  debounceMs: number;
}

/**
 * 监听 MCP 配置文件变化，自动增/删/改 MCP Server 连接。
 *
 * 监听三处来源（顺序即优先级，后者覆盖同名项）：
 *   ~/.agent/mcp.json、<cwd>/.mcp.json、<cwd>/.agent/mcp.json
 *
 * 使用 poll 模式（fs.watchFile stat 轮询）：.agent/ 目录下文件变更频繁
 * （session、SQLite、scheduler），fs.watch 会产生大量无效回调；固定间隔
 * 轻量 stat，仅在 mtime 变化时触发，对极少变更的配置文件开销更低。
 * 骨架自带异步 reload 防重入（原 handleLock 语义）。
 */
export function watchMcpConfig(deps: McpWatcherDeps): WatcherHandle[] {
  // 与 MCPConfigLoader 共用同一份路径定义，避免两边漂移
  const watchPaths = getMCPConfigPaths(deps.cwd).map((p) => p.file);

  return createWatcher({
    name: 'mcp',
    mode: 'poll',
    paths: () => watchPaths,
    reload: async () => {
      await deps.mcpSystem.reload();
    },
  });
}
