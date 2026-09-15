// ============================================================
// 全局子进程注册表 + 退出收割
// ============================================================
// 背景：LifecycleSupervisor 对受管进程的收割是"注册制"——exit 钩子
// 只遍历注册进 supervisor.entities 的 ProcessManager。测试 / 插件 /
// 任何裸 new 的 ProcessManager 实例不在表里，主进程退出时无人收割，
// 其子进程树整体孤儿化（实测全量测试一次泄漏一批 node 孤儿）。
//
// 方案：ProcessManager 构造时自动注册到本模块级注册表，destroy() 时
// 注销；installGlobalReaper()（幂等）挂 beforeExit + exit 钩子，同步
// 遍历所有存活实例 forceKillAll()。任何实例——无论是否经过 supervisor
// 或任何上层——在进程退出路径上都被收割，与 mcp/shutdown.ts 的
// trackMcpSystemForShutdown 模式一致。
//
// 注：TerminateProcess 强杀路径 JS 钩子不触发，由 lifecycle/watchdog.ts
// 的父死自灭 watchdog + orphan-sweeper 启动兜底覆盖。
// ============================================================

import type { ProcessManager } from './manager.js';

const managers = new Set<ProcessManager>();
let reaperInstalled = false;

/** 注册一个 ProcessManager 实例（构造时自动调用） */
export function registerManager(pm: ProcessManager): void {
  managers.add(pm);
}

/** 注销一个 ProcessManager 实例（destroy 时调用） */
export function unregisterManager(pm: ProcessManager): void {
  managers.delete(pm);
}

/** 当前被追踪的实例数（诊断/测试用） */
export function trackedManagerCount(): number {
  return managers.size;
}

/**
 * 安装全局退出收割器（幂等）。
 * beforeExit / exit 两个钩子都挂：beforeExit 走正常退出路径，
 * exit 兜底（process.exit() 内同步触发，覆盖 SIGINT/SIGTERM 优雅退出）。
 * 收割是同步的（exit 回调不允许异步），逐实例 forceKillAll。
 */
export function installGlobalReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;

  const reap = (): void => {
    for (const pm of managers) {
      try {
        pm.forceKillAll();
      } catch {
        // 单实例失败不影响其余收割
      }
    }
  };

  process.on('beforeExit', reap);
  process.on('exit', reap);
}
