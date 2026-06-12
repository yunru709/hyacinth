import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from '../tools/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createLogger } from '../logging/logger.js';
import { PythonToolBridge } from '../tools/python-bridge/index.js';

const logger = createLogger('hot-reload:tool-watcher');

export interface ToolWatcherDeps {
  toolRegistry: ToolRegistry;
  cwd: string;
  debounceMs: number;
}

/**
 * 监视 .agent/tools/ 目录，三轨扫描：
 *
 *   BasicTool  — flat .js files (dynamic import)
 *   ModuleTool — subdir dist/index.js
 *   PythonTool — flat .py files (PythonToolBridge)
 */
export function watchTools(deps: ToolWatcherDeps): fs.FSWatcher {
  const { toolRegistry, cwd, debounceMs } = deps;
  const toolsDir = path.join(cwd, '.agent', 'tools');

  try { fs.mkdirSync(toolsDir, { recursive: true }); } catch { /* ignore */ }

  const fileMap = new Map<string, string>();
  scanAndSync(toolsDir, toolRegistry, fileMap);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  logger.info(`Watching tools directory: ${toolsDir}`);

  const watcher = fs.watch(toolsDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith('.js') && !filename.endsWith('.py')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scanAndSync(toolsDir, toolRegistry, fileMap), debounceMs);
  });

  watcher.on('error', (err) => {
    logger.warn(`Tool watcher error: ${err.message}`, { error: err.message });
  });

  return watcher;
}

// ── Resolved entry ──────────────────────────────────────────────────

interface ResolvedEntry {
  trackingKey: string;
  filePath: string;
  label: string;
  /** 非 JS 工具的工厂函数 */
  factory?: () => Tool | null;
}

async function scanAndSync(
  dir: string,
  registry: ToolRegistry,
  fileMap: Map<string, string>,
): Promise<void> {
  const resolved = resolveToolEntries(dir);
  const currentKeys = new Set(resolved.map((r) => r.trackingKey));

  for (const entry of resolved) {
    const knownToolName = fileMap.get(entry.trackingKey);

    if (knownToolName !== undefined) {
      // 已跟踪 → 重新加载
      if (entry.factory) {
        // Python 工具：不再解析
        const tool = entry.factory();
        if (tool) {
          registry.unregister(knownToolName);
          registry.register(tool);
          registry.markHotAdded(tool.name);
          fileMap.set(entry.trackingKey, tool.name);
          logger.info(`Tool reloaded: ${tool.name} (${entry.label})`);
        }
      } else {
        // JS 工具：dynamic import
        try {
          const fileUrl = pathToFileURL(entry.filePath).href;
          const imported = await import(`${fileUrl}?t=${Date.now()}`);
          const tool = (imported.default ?? imported) as Tool;
          if (tool && typeof tool.name === 'string' && typeof tool.execute === 'function') {
            registry.unregister(knownToolName);
            registry.register(tool);
            registry.markHotAdded(tool.name);
            fileMap.set(entry.trackingKey, tool.name);
            logger.info(`Tool reloaded: ${tool.name} (${entry.label})`);
          }
        } catch (err) {
          logger.warn(`Failed to reload tool ${entry.label}: ${(err as Error).message}`);
        }
      }
    } else {
      await loadAndRegister(entry, registry, fileMap);
    }
  }

  for (const [key, toolName] of fileMap.entries()) {
    if (!currentKeys.has(key)) {
      registry.unregister(toolName);
      fileMap.delete(key);
      logger.info(`Tool unregistered: ${toolName} (${key})`);
    }
  }
}

function resolveToolEntries(dir: string): ResolvedEntry[] {
  const entries: ResolvedEntry[] = [];

  let fsEntries: fs.Dirent[];
  try { fsEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return entries; }

  // ① ModuleTool：子目录的 dist/index.js
  for (const entry of fsEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const distIndex = path.join(dir, entry.name, 'dist', 'index.js');
    try { fs.accessSync(distIndex);
      entries.push({ trackingKey: entry.name, filePath: distIndex, label: `${entry.name}/dist/index.js` });
    } catch { /* 无编译产物 */ }
  }

  // ② BasicTool：扁平 .js 文件
  for (const entry of fsEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const fp = path.join(dir, entry.name);
    if (entries.some((e) => e.trackingKey === entry.name.replace(/\.js$/, ''))) continue;
    entries.push({ trackingKey: entry.name, filePath: fp, label: entry.name });
  }

  // ③ PythonTool：扁平 .py 文件
  for (const entry of fsEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
    const fp = path.join(dir, entry.name);
    const key = `py:${entry.name}`;
    if (entries.some((e) => e.trackingKey === key)) continue;
    entries.push({
      trackingKey: key,
      filePath: fp,
      label: `${entry.name} (python)`,
      factory: () => PythonToolBridge.fromFile(fp),
    });
  }

  return entries;
}

async function loadAndRegister(
  entry: ResolvedEntry,
  registry: ToolRegistry,
  fileMap: Map<string, string>,
): Promise<void> {
  try {
    let tool: Tool | null;
    if (entry.factory) {
      tool = entry.factory();
    } else {
      const fileUrl = pathToFileURL(entry.filePath).href;
      const imported = await import(fileUrl);
      tool = (imported.default ?? imported) as Tool;
    }

    if (!tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') {
      logger.warn(`Tool file ${entry.label} does not export a valid Tool (need name, execute, inputSchema)`);
      return;
    }

    registry.register(tool);
    registry.markHotAdded(tool.name);
    fileMap.set(entry.trackingKey, tool.name);
    logger.info(`Tool registered: ${tool.name} (${entry.label})`);
  } catch (err) {
    logger.warn(`Failed to load tool ${entry.label}: ${(err as Error).message}`);
  }
}
