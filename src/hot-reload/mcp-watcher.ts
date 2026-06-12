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
 * 监听两个文件：
 *   - .agent/mcp.json
 *   - .mcp.json
 *
 * 任一文件发生变化时，debounce 后通过 MCPSystem.reload() 重新加载配置。
 */
export function watchMcpConfig(deps: McpWatcherDeps): fs.FSWatcher[] {
  const logger = createLogger('hot-reload:mcp');
  const { mcpSystem, cwd, debounceMs } = deps;

  // ── 配置变更处理（含 debounce） ──
  let timer: ReturnType<typeof setTimeout> | null = null;
  let handleLock = false;

  async function handleChange(): Promise<void> {
    if (handleLock) {
      logger.info('handleChange already running, skipping');
      return;
    }
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

  // ── 监听配置文件（目录级别，支持文件被创建后触发） ──
  const configWatchTargets = [
    { dir: path.join(cwd, '.agent'), file: 'mcp.json' },
    { dir: cwd, file: '.mcp.json' },
  ];

  const watchers: fs.FSWatcher[] = [];
  const watchedDirs = new Set<string>();

  for (const { dir, file } of configWatchTargets) {
    if (watchedDirs.has(dir)) continue;
    watchedDirs.add(dir);

    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || !isTargetFile(filename, configWatchTargets)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(handleChange, debounceMs);
      });
      watcher.on('error', (err) => {
        logger.warn('watcher error', { dir, error: err.message });
      });
      watchers.push(watcher);
    } catch {
    }
  }

  return watchers;
}

// ── 检查目录变更事件是否命中目标文件 ──
function isTargetFile(filename: string, targets: Array<{ dir: string; file: string }>): boolean {
  return targets.some((t) => filename === t.file || filename.endsWith(path.sep + t.file));
}
