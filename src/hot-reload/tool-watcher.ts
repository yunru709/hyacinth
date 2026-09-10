import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from '../tools/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createLogger } from '../logging/logger.js';
import { PythonToolBridge } from '../tools/python-bridge/index.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

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
export function watchTools(deps: ToolWatcherDeps): WatcherHandle[] {
  const { toolRegistry, debounceMs } = deps;
  const toolsDir = path.join(os.homedir(), '.agent', 'tools');

  try { fs.mkdirSync(toolsDir, { recursive: true }); } catch { /* ignore */ }

  const fileMap = new Map<string, string>();
  const mtimeMap = new Map<string, number>();
  // 初始扫描不标记 hotAdded — 工具应进入 Zone 2 tool_rules
  scanAndSync(toolsDir, toolRegistry, fileMap, mtimeMap, true);

  return createWatcher({
    name: 'tool-watcher',
    debounceMs,
    recursive: true,
    paths: () => [toolsDir],
    filter: (filename) => filename.endsWith('.js') || filename.endsWith('.py'),
    // 文件变更触发的重新扫描 — 此时才标记 hotAdded，工具进 Zone 5 session-tools
    reload: () => scanAndSync(toolsDir, toolRegistry, fileMap, mtimeMap, false),
  });
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
  mtimeMap: Map<string, number>,
  isInitialScan: boolean,
): Promise<void> {
  const resolved = resolveToolEntries(dir);
  const currentKeys = new Set(resolved.map((r) => r.trackingKey));

  for (const entry of resolved) {
    const knownToolName = fileMap.get(entry.trackingKey);

    if (knownToolName !== undefined) {
      // 已跟踪 → 检查文件是否真的变了，避免 fs.watch 误触发导致全部标记为 hot-added
      let mtime: number | undefined;
      try { mtime = fs.statSync(entry.filePath).mtimeMs; } catch { /* stat 失败则走重载 */ }
      if (mtime !== undefined) {
        const prevMtime = mtimeMap.get(entry.trackingKey);
        if (prevMtime === mtime) continue; // 文件没变，跳过
        mtimeMap.set(entry.trackingKey, mtime);
      }

      // 重新加载（文件变更触发的热重载）
      if (entry.factory) {
        // Python 工具：不再解析
        const tool = entry.factory();
        if (tool) {
          registry.unregister(knownToolName);
          registry.register(tool);
          if (!isInitialScan) registry.markHotAdded(tool.name);
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
            if (!isInitialScan) registry.markHotAdded(tool.name);
            fileMap.set(entry.trackingKey, tool.name);
            logger.info(`Tool reloaded: ${tool.name} (${entry.label})`);
          }
        } catch (err) {
          logger.warn(`Failed to reload tool ${entry.label}: ${(err as Error).message}`);
        }
      }
    } else {
      await loadAndRegister(entry, registry, fileMap, mtimeMap, isInitialScan);
    }
  }

  for (const [key, toolName] of fileMap.entries()) {
    if (!currentKeys.has(key)) {
      registry.unregister(toolName);
      fileMap.delete(key);
      mtimeMap.delete(key);
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
  mtimeMap: Map<string, number>,
  isInitialScan: boolean,
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
    // 初始扫描（启动时）不标记 hotAdded → 工具进入 Zone 2 tool_rules
    // 文件变更触发的扫描才标记 → 工具进入 Zone 5 session-tools
    if (!isInitialScan) registry.markHotAdded(tool.name);
    fileMap.set(entry.trackingKey, tool.name);
    try { mtimeMap.set(entry.trackingKey, fs.statSync(entry.filePath).mtimeMs); } catch {}
    logger.info(`Tool registered: ${tool.name} (${entry.label})`);
  } catch (err) {
    logger.warn(`Failed to load tool ${entry.label}: ${(err as Error).message}`);
  }
}
