// ============================================================
// MCP 子进程退出收割
// ============================================================
// 背景：stdio 型 MCP Server（npx/python 包装）是"后端进程 → cmd.exe
// → node/python → …"的多层进程树。后端无论以何种方式退出（Ctrl+C、
// process.exit、被外部强杀），如果不显式收割，整棵树在 Windows 上
// 会全部变成孤儿常驻 —— 实测一次累积可挂 60+ 个 node 进程、数 GB 内存。
//
// 两道防线：
//   1. process.on('exit') 同步 forceKillAll（taskkill /T，进程树击杀）。
//      'exit' 在 process.exit() 内同步触发，覆盖 SIGINT/SIGTERM 优雅
//      退出与任意 exit() 调用；被外部 TerminateProcess 强杀时无法拦截
//      （Windows 限制），由 orphan-sweeper 在下次启动时兜底清扫。
//   2. stop()/disconnect() 的常规路径已由 MCPServerManager 负责。
// ============================================================

import type { MCPSystem } from './system.js';

const trackedSystems = new Set<MCPSystem>();
let registered = false;

/** 注册 MCPSystem 的退出收割（幂等；同一进程多个 MCPSystem 均会被收割） */
export function trackMcpSystemForShutdown(mcpSystem: MCPSystem): void {
  trackedSystems.add(mcpSystem);
  if (registered) return;
  registered = true;

  process.on('exit', () => {
    for (const system of trackedSystems) {
      for (const manager of system.getManagers()) {
        try {
          // 同步强杀：'exit' 回调里不允许异步操作
          manager.getProcessManager().forceKillAll();
        } catch {
          // 进程可能已不存在
        }
      }
    }
  });
}
