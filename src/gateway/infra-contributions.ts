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
import { acquireSharedMcpSystem } from '../mcp/shared.js';
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
        // ── 共享实例（2026-09-20 方案 (b)）──────────────────────────────
        // 装配是**按会话**跑的 ⇒ 原先每开一个网页/标签就 `new MCPSystem` 一次 ✗ ⇒
        // 每个会话都 spawn 一整套 MCP 子进程（日志实证：5 次探针 ⇒ 5 次
        // 「MCPSystem started: 1/1」✗；反复开页面堆到 **290 个进程** ⇒ 网页被拖成"半死" ✗）
        // 改为**同一 cwd 全进程共用一份** ⇒ **开再多会话，后台也只有一套 MCP** ✓
        // （工具不会少给：每个会话仍各自 registerToToolRegistry 进自己的 registry ✓）
        const { system: mcpSystem, created } = acquireSharedMcpSystem(cwd as string);
        // 退出收割：无论进程以何种方式退出，杀掉 MCP 子进程树，防孤儿进程累积
        // （该函数本身幂等 ✓ 这里只对「首次创建」挂一次，语义更清楚 ✓）
        if (created) trackMcpSystemForShutdown(mcpSystem);
        return { mcpSystem };
      },
    },
  ]);
}
