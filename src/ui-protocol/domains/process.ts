// ============================================================
// UI 协议层 — 后台进程域（process.*）
// ============================================================
// 覆盖 UI 对后台进程的查询与终止（对应 TUI /bg 后台进程）：
//   process.list   列出全部后台进程（含状态）
//   process.kill   终止指定后台进程
//
// 依赖结构化 BackgroundRegistryLike 接口（真实
// BackgroundProcessRegistry 天然兼容：list/kill），可独立测试。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { ProcessInfoLike } from '../types.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 BackgroundProcessRegistry 兼容）
// ────────────────────────────────────────────────────────────

export interface BackgroundRegistryLike {
  list(): ProcessInfoLike[];
  kill(handle: string): Promise<boolean>;
}

// ────────────────────────────────────────────────────────────
// 后台进程域选项
// ────────────────────────────────────────────────────────────

export interface ProcessDomainOptions {
  /** 动态获取后台进程注册表（agent 在 initialize 后才就绪，通过闭包延迟解析） */
  getRegistry: () => BackgroundRegistryLike | null;
}

// ────────────────────────────────────────────────────────────
// 后台进程域工厂
// ────────────────────────────────────────────────────────────

export function createProcessDomain(options: ProcessDomainOptions): DomainHandler {
  const { getRegistry } = options;

  return {
    // ── process.list ───────────────────────────────────────
    list(): { processes: ProcessInfoLike[] } {
      const registry = getRegistry();
      if (!registry) return { processes: [] };
      return { processes: registry.list() };
    },

    // ── process.kill ───────────────────────────────────────
    async kill(params: unknown): Promise<{ ok: boolean; handle: string }> {
      const handle = (params as { handle?: string } | undefined)?.handle;
      if (!handle) throw new Error('process.kill requires "handle"');
      const registry = getRegistry();
      if (!registry) throw new Error('background registry not available');
      const ok = await registry.kill(handle);
      return { ok, handle };
    },
  };
}
