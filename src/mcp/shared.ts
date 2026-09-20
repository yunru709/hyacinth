// ============================================================
// MCP 共享池 —— 同一 cwd，全进程只保留一份 MCPSystem（2026-09-20 方案 (b)）
// ============================================================
//
// 背景（实测 ✗）：会话装配是**按会话**跑的，而原先每个装配都 `new MCPSystem` ✗ ⇒
// **每开一个网页/标签就 spawn 一整套 MCP 子进程**（日志实证：跑 5 次探针 ⇒
// 5 次「MCPSystem started: 1/1」；反复开页面堆到 **290 个进程** ⇒ 网页被拖成"半死" ✗）。
//
// 改法：装配时改为**从本池取** ⇒ 开再多会话，后台也只有一套 MCP ✓
// 工具不会被少给：每个会话仍会各自 `registerToToolRegistry(自己的 registry)` ✓，
// 而 `MCPSystem` 内部已把「注册面」改成**集合**（同时服务多个会话 ✓）。
//
// 生命周期：实例**不在会话结束时销毁**（同一进程内长期复用 ✓）；
// 子进程收割仍由 mcp/shutdown.ts 的 exit 钩子负责 ✓。
import path from 'node:path';
import { MCPSystem } from './system.js';

const pool = new Map<string, MCPSystem>();

/**
 * 取（或首次创建）该 cwd 的共享 MCPSystem。
 * @returns system 共享实例；created 本次是否首次创建（用于只挂一次退出收割 ✓）
 */
export function acquireSharedMcpSystem(cwd: string): { system: MCPSystem; created: boolean } {
  const key = path.resolve(cwd);
  const existing = pool.get(key);
  if (existing) return { system: existing, created: false };
  const system = new MCPSystem({ cwd: key });
  pool.set(key, system);
  return { system, created: true };
}

/** 仅供测试/诊断：清空池（**不断开**已建连接 ✓ 断开由 stop()/shutdown 负责） */
export function __resetSharedMcpSystems(): void {
  pool.clear();
}
