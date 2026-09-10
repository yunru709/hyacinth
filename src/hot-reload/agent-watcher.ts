import path from 'node:path';
import os from 'node:os';
import type { AgentRegistry } from '../agents/registry.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { AgentDefinition } from '../types.js';
import { loadAgentConfigs } from '../agents/config-loader.js';
import { createLogger } from '../logging/logger.js';
import { createWatcher, type WatcherHandle } from './watcher-base.js';

interface AgentWatcherDeps {
  agentRegistry: AgentRegistry;
  contextComposer: LayeredContextComposer;
  cwd: string;
  debounceMs: number;
}

/**
 * 判断两个 AgentDefinition 的配置是否相同（忽略 instanceId 等运行时字段）。
 */
function isSameConfig(a: AgentDefinition, b: AgentDefinition): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.systemPrompt === b.systemPrompt &&
    a.maxTurns === b.maxTurns &&
    a.modelPreference === b.modelPreference &&
    arraysEqual(a.allowedTools, b.allowedTools)
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 监听 agents.json 配置文件变化，自动重载 Agent 定义。
 *
 * 监听路径（按优先级）：AGENTS_CONFIG_PATH 环境变量 > 项目 > 全局。
 * 变更时重新加载配置并 diff：增量注册/注销/更新（added/removed/changed）。
 */
export function watchAgentsJson(deps: AgentWatcherDeps): WatcherHandle[] {
  return createWatcher({
    name: 'agents',
    debounceMs: deps.debounceMs,
    paths: () => {
      const watchPaths: string[] = [];
      const envPath = process.env['AGENTS_CONFIG_PATH'];
      if (envPath) watchPaths.push(path.resolve(envPath));
      watchPaths.push(path.join(deps.cwd, '.agent', 'agents.json'));
      watchPaths.push(path.join(os.homedir(), '.agent', 'agents.json'));
      return [...new Set(watchPaths)];
    },
    reload: () => reloadAgents(deps),
  });
}

async function reloadAgents(deps: AgentWatcherDeps): Promise<void> {
  const logger = createLogger('hot-reload:agents');

  // 1. 重新加载配置
  const newAgents = await loadAgentConfigs(deps.cwd);

  // 2. 获取当前已注册的 Agent（按 name 建立索引）
  const oldMap = new Map<string, AgentDefinition>();
  for (const a of deps.agentRegistry.getAll()) {
    oldMap.set(a.name, a);
  }
  const newMap = new Map<string, AgentDefinition>();
  for (const a of newAgents) {
    newMap.set(a.name, a);
  }

  // 3. 找出变化
  const oldNames = new Set(oldMap.keys());
  const newNames = new Set(newMap.keys());

  const added = [...newNames].filter((n) => !oldNames.has(n));
  const removed = [...oldNames].filter((n) => !newNames.has(n));
  const changed: string[] = [];
  for (const name of newNames) {
    if (oldNames.has(name)) {
      const oldDef = oldMap.get(name)!;
      const newDef = newMap.get(name)!;
      if (!isSameConfig(oldDef, newDef)) {
        changed.push(name);
      }
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    logger.info('agents.json unchanged, no reload needed');
    return;
  }

  logger.info('agent changes detected', {
    added: added.length > 0 ? added : undefined,
    removed: removed.length > 0 ? removed : undefined,
    changed: changed.length > 0 ? changed : undefined,
  });

  // 4. 应用变更

  // 处理新增
  for (const name of added) {
    const def = newMap.get(name)!;
    deps.agentRegistry.register(def);
    registerAgentContextSource(deps, def, logger);
    logger.info('agent added', { agent: name });
  }

  // 处理变更：先注销旧的，再注册新的
  for (const name of changed) {
    const def = newMap.get(name)!;
    deps.agentRegistry.unregister(name);
    removeAgentContextSource(deps, name, logger);
    deps.agentRegistry.register(def);
    registerAgentContextSource(deps, def, logger);
    logger.info('agent updated', { agent: name });
  }

  // 处理删除
  for (const name of removed) {
    deps.agentRegistry.unregister(name);
    removeAgentContextSource(deps, name, logger);
    logger.info('agent removed', { agent: name });
  }

  logger.info('agents reload complete', {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
  });
}

function registerAgentContextSource(
  deps: AgentWatcherDeps,
  def: AgentDefinition,
  logger: ReturnType<typeof createLogger>,
): void {
  try {
    deps.contextComposer.registerSource({
      name: `agent-${def.name}`,
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: def.description,
      getContent: () => deps.agentRegistry.getFullDefinitions([def.name]),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('failed to register agent context source', { agent: def.name, error: msg });
  }
}

function removeAgentContextSource(
  deps: AgentWatcherDeps,
  agentName: string,
  logger: ReturnType<typeof createLogger>,
): void {
  const sourceName = `agent-${agentName}`;
  const existing = deps.contextComposer.getSource(sourceName);
  if (existing) {
    deps.contextComposer.unregisterSource(sourceName);
    logger.debug('unregistered agent context source', { agent: agentName });
  }
}
