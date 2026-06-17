import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowDefinition } from '../workflow/types.js';
import type { WorkflowRegistry } from '../workflow/registry.js';
import { loadWorkflowFile, scanWorkflowsDir } from '../workflow/loader.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('hot-reload:workflow-watcher');

export interface WorkflowWatcherDeps {
  workflowRegistry: WorkflowRegistry;
  cwd?: string;
  debounceMs: number;
  /** 文件 workflow 加载/重载后的回调，用于补注册 ContextSource 等 */
  onWorkflowLoaded?: (def: WorkflowDefinition) => void;
}

/**
 * 监视 workflows 目录（用户级 + 项目级）的 .yaml 文件变更，自动重新加载 workflow
 *
 * 监视目录：
 * - ~/.agent/workflows/
 * - <cwd>/.agent/workflows/（如果提供了 cwd）
 */
export function watchWorkflows(deps: WorkflowWatcherDeps): fs.FSWatcher[] {
  const { workflowRegistry, cwd, debounceMs } = deps;

  const dirs: string[] = [];
  const userWorkflowsDir = path.join(homedir(), '.agent', 'workflows');
  dirs.push(userWorkflowsDir);

  if (cwd) {
    const projectWorkflowsDir = path.join(cwd, '.agent', 'workflows');
    dirs.push(projectWorkflowsDir);
  }

  // 先做一次初始扫描
  for (const dir of dirs) {
    const loaded = scanWorkflowsDir(dir, workflowRegistry);
    if (loaded.length > 0) {
      logger.info(`Loaded ${loaded.length} workflow(s) from ${dir}: ${loaded.join(', ')}`);
      // 为初始扫描到的文件 workflow 补注册 ContextSource
      if (deps.onWorkflowLoaded) {
        for (const name of loaded) {
          const def = workflowRegistry.get(name);
          if (def) deps.onWorkflowLoaded(def);
        }
      }
    }
  }

  const watchers: fs.FSWatcher[] = [];

  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch { /* 忽略 */ }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    logger.info(`Watching workflows directory: ${dir}`);

    const watcher = fs.watch(dir, { recursive: false }, (_eventType, filename) => {
      if (!filename || (!filename.endsWith('.yaml') && !filename.endsWith('.yml'))) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const filePath = path.join(dir, filename!);
        const ext = path.extname(filename!);
        const workflowName = filename!.slice(0, -ext.length);

        try {
          fs.accessSync(filePath);
          // 文件存在 → 重新加载
          const def = loadWorkflowFile(filePath);
          if (def) {
            // 内置名保护区：先 unregister 再 register
            if (workflowRegistry.has(def.name)) {
              workflowRegistry.unregister(def.name);
            }
            workflowRegistry.register(def);
            deps.onWorkflowLoaded?.(def);
            logger.info(`Workflow reloaded: ${def.name} (from ${filename})`);
          }
        } catch {
          if (workflowRegistry.has(workflowName)) {
            workflowRegistry.unregister(workflowName);
            logger.info(`Workflow unregistered: ${workflowName} (file removed)`);
          }
        }
      }, debounceMs);
    });

    watcher.on('error', (err) => {
      logger.warn(`Workflow watcher error on ${dir}: ${err.message}`, { error: err.message });
    });

    watchers.push(watcher);
  }

  return watchers;
}
