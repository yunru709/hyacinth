// ============================================================
// UI 协议层 — 插件域（plugin.*）
// ============================================================
// 覆盖 UI 对内核插件挂载状态的查询（B-4：挂载失败可见性）。
//   plugin.list —— 返回内核插件宿主（loop.pluginHost）的插件状态列表，
//   含 permission-chain / bypass / world-engine 等，state='error' 表示挂载失败
//   （error 消息可诊断）。业务插件（knowledge/xref/generation，挂 PluginManager
//   内部宿主）由装配方另行聚合（如需要）。
//
// 依赖结构化 PluginStatusLike 接口（真实 PluginHost.list() 条目天然兼容）。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 PluginHost.list() 条目兼容）
// ────────────────────────────────────────────────────────────

/** 插件挂载状态（对应 PluginHost.list() 条目） */
export interface PluginStatusLike {
  /** 插件 id */
  id: string;
  /** 挂载态：mounted | error */
  state: 'mounted' | 'error';
  /** 挂载失败时的错误信息（state='error' 时有值） */
  error?: string;
  /** 依赖的插件 id */
  deps: string[];
}

// ────────────────────────────────────────────────────────────
// 插件域选项
// ────────────────────────────────────────────────────────────

export interface PluginDomainOptions {
  /** 获取内核插件宿主状态列表（loop.pluginHost.list()；含安全层插件） */
  getPluginHosts: () => PluginStatusLike[];
}

// ────────────────────────────────────────────────────────────
// 插件域工厂
// ────────────────────────────────────────────────────────────

export function createPluginDomain(options: PluginDomainOptions): DomainHandler {
  const { getPluginHosts } = options;

  return {
    /** 查询内核插件挂载状态（B-4：挂载失败可见） */
    async list(): Promise<PluginStatusLike[]> {
      return getPluginHosts();
    },
  };
}
