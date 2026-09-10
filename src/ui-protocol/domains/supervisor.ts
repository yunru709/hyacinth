// ============================================================
// UI 协议层 — Supervisor 域（supervisor.*）
// ============================================================
// Supervisor 方案 S5：进程监督层的可观测面。
//   supervisor.status —— 返回运行时监督状态一览：
//     uptime / pid / node / guardian（是否处于守护下）/ lastRestart（上次重启
//     原因存档）/ plugins（内核插件挂载状态，复用 plugin 域数据源）/
//     watchers（热重载 watcher 健康度，可选）/ git（工作区摘要，可选）。
//
// 物理边界（方案红线 5）：本域是"Supervisor 的可观测面"，但协议层自身
// 零业务依赖 —— git/watcher 等业务数据由 backend 注入 getter，协议层
// 只 import supervisor/protocol（零依赖契约叶，verify:layers 规则 4 白名单）。
// ============================================================

import type { DomainHandler } from '../server.js';
import { isUnderGuardian, readRestartReason, type RestartReason } from '../../supervisor/protocol.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实实现条目兼容）
// ────────────────────────────────────────────────────────────

/** 插件挂载状态（对应 PluginHost.list() 条目，与 plugin 域同源） */
export interface SupervisorPluginLike {
  id: string;
  state: 'mounted' | 'error';
  error?: string;
  deps: string[];
}

/** 热重载 watcher 健康度（对应 HotReloadManager.getStatus()） */
export interface SupervisorWatchersLike {
  started: boolean;
  watcherCount: number;
  debounceMs: number;
}

/** git 工作区摘要（backend 注入；协议层不依赖 evolution） */
export interface SupervisorGitLike {
  isRepo: boolean;
  dirty: boolean;
  /** 最近一条 auto: 提交摘要（无则 null） */
  lastAutoCommit: string | null;
}

/** supervisor.status 返回结构 */
export interface SupervisorStatus {
  /** 进程运行时长（秒） */
  uptimeSec: number;
  pid: number;
  node: string;
  /** 是否处于 guardian 守护之下（重启兜底是否可用） */
  guardian: boolean;
  /** 上次重启原因存档（无存档为 null） */
  lastRestart: RestartReason | null;
  /** 内核插件挂载状态 */
  plugins: SupervisorPluginLike[];
  /** 热重载 watcher 健康度（backend 未注入为 null） */
  watchers: SupervisorWatchersLike | null;
  /** git 工作区摘要（backend 未注入为 null） */
  git: SupervisorGitLike | null;
}

// ────────────────────────────────────────────────────────────
// 域选项
// ────────────────────────────────────────────────────────────

export interface SupervisorDomainOptions {
  /** 内核插件挂载状态（同 plugin 域：loop.pluginHost.list()） */
  getPluginHosts: () => SupervisorPluginLike[];
  /** 热重载 watcher 健康度（对应 AgentComponents.hotReloadManager.getStatus()，可选） */
  getWatcherStatus?: () => SupervisorWatchersLike | null | Promise<SupervisorWatchersLike | null>;
  /** git 工作区摘要（backend 注入，GitManager 摘要为异步，可选） */
  getGitSummary?: () => SupervisorGitLike | null | Promise<SupervisorGitLike | null>;
}

// ────────────────────────────────────────────────────────────
// 域工厂
// ────────────────────────────────────────────────────────────

export function createSupervisorDomain(options: SupervisorDomainOptions): DomainHandler {
  const { getPluginHosts, getWatcherStatus, getGitSummary } = options;

  /** 可选异步 getter 的安全求值：异常一律降级 null（可观测面绝不抛错） */
  async function resolve<T>(getter: (() => T | null | Promise<T | null>) | undefined): Promise<T | null> {
    try {
      return (await getter?.()) ?? null;
    } catch {
      return null;
    }
  }

  return {
    /** 运行时监督状态一览（S5 可观测面） */
    async status(): Promise<SupervisorStatus> {
      const [watchers, git] = await Promise.all([
        resolve(getWatcherStatus),
        resolve(getGitSummary),
      ]);

      return {
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
        node: process.version,
        guardian: isUnderGuardian(),
        lastRestart: readRestartReason(),
        plugins: getPluginHosts(),
        watchers,
        git,
      };
    },
  };
}
