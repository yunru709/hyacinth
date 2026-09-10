/**
 * infra-contributions.ts —— 基础设施贡献批（行数收尾第八批）。
 *
 * 迁移 3 类：MemoryStore（needs memoryFilePath）、HeartbeatScheduler（needs
 * scheduleConfig，subscribeConfig 接线随迁）、MCPSystem（needs cwd；
 * trackMcpSystemForShutdown 接线随迁）。
 *
 * 留 factory 的接线：memoryStore.initializeIfNeeded()（文件系统副作用，紧邻
 * 路径计算）、mcpSystem.start()/registerTo*（并行块 + 多注册面）、
 * heartbeatScheduler.start()（并行块）—— 三者均在使用点解构后原位保留。
 */

import { AssemblyRunner } from './assembly-runner.js';
import type { AssemblyResults } from './assembly-runner.js';
import { MemoryStore } from '../memory/memory-store.js';
import { HeartbeatScheduler } from '../schedule/scheduler.js';
import { MCPSystem } from '../mcp/index.js';
import { trackMcpSystemForShutdown } from '../mcp/shutdown.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { ScheduleConfig } from '../schedule/types.js';

export interface InfraContributionDeps {
  memoryFilePath: string;
  scheduleConfig: Record<string, unknown> | ScheduleConfig | undefined;
  configCenter: RuntimeConfigCenter;
  cwd: string;
}

/** 执行基础设施贡献批（memoryStore/heartbeatScheduler/mcpSystem） */
export async function runInfraContributions(
  deps: InfraContributionDeps,
): Promise<AssemblyResults> {
  const runner = new AssemblyRunner();
  runner.provide('memoryFilePath', deps.memoryFilePath);
  runner.provide('scheduleConfig', deps.scheduleConfig);
  runner.provide('configCenter', deps.configCenter);
  runner.provide('cwd', deps.cwd);
  return runner.run([
    {
      id: 'memoryStore',
      needs: ['memoryFilePath'],
      provides: ['memoryStore'],
      mount: ({ memoryFilePath }) => ({ memoryStore: new MemoryStore(memoryFilePath as string) }),
    },
    {
      id: 'heartbeatScheduler',
      needs: ['scheduleConfig', 'configCenter'],
      provides: ['heartbeatScheduler'],
      mount: (d) => {
        const heartbeatScheduler = new HeartbeatScheduler(undefined, d.scheduleConfig as any);
        heartbeatScheduler.subscribeConfig(d.configCenter as RuntimeConfigCenter);
        return { heartbeatScheduler };
      },
    },
    {
      id: 'mcpSystem',
      needs: ['cwd'],
      provides: ['mcpSystem'],
      mount: ({ cwd }) => {
        const mcpSystem = new MCPSystem({ cwd: cwd as string });
        // 退出收割：无论进程以何种方式退出，杀掉 MCP 子进程树，防孤儿进程累积
        trackMcpSystemForShutdown(mcpSystem);
        return { mcpSystem };
      },
    },
  ]);
}
