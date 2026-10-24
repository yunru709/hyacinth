// ============================================================
// UI 契约层 — 插件域（plugin.*）
// ============================================================
// 覆盖 UI 对插件系统的查询与管理，两列分置：
//
//   内核插件（loop.pluginHost，permission-chain / bypass / world-engine 等）：
//   plugin.list —— 挂载状态列表，state='error' 表示挂载失败（error 可诊断）。
//   只读：内核插件是安全/能力基座，不提供 UI 启停。
//
//   目录插件（~/.agent/plugins/<id>/，PluginManager 管理，如 companion）：
//   plugin.listDirectory     清单（id/name/description/status/skill/mcp 计数）
//   plugin.activate {id}     启用（加载并挂载）
//   plugin.deactivate {id}   停用
//   plugin.reload {id}       从磁盘重载（开发插件改完代码后用）
//
// 管理面依赖结构化 PluginManagerLike 接口（真实 PluginManager 的
// getAll/activate/deactivate/reloadFromDisk 经装配侧映射后注入，协议层零
// plugins/ 依赖 —— P5-2）。未注入时查询返回空、写操作报错（fail-closed）。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 PluginHost.list() 条目 / PluginManager 映射条目兼容）
// ────────────────────────────────────────────────────────────

/** 内核插件挂载状态（对应 PluginHost.list() 条目） */
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

/** 目录插件清单条目（装配侧从 PluginInstance 映射而来） */
export interface DirectoryPluginLike {
  id: string;
  name: string;
  description: string;
  /** discovered=已发现未加载 loaded=已加载未激活 activated=激活中 deactivated=已停用 error=出错 */
  status: 'discovered' | 'loaded' | 'activated' | 'deactivated' | 'error';
  /** 出错信息（status='error' 时有值） */
  error?: string;
  /** 插件目录绝对路径（诊断用） */
  dir: string;
  /** 附带的 Skill 定义数量 */
  skillCount: number;
  /** 注册的 MCP Server 数量 */
  mcpServerCount: number;
}

/** 目录插件管理面（真实 PluginManager 的窄形状视图，由装配侧映射注入） */
export interface PluginManagerLike {
  getAll(): DirectoryPluginLike[];
  activate(id: string): Promise<void>;
  deactivate(id: string): Promise<void>;
  reloadFromDisk(id: string): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// 插件域选项
// ────────────────────────────────────────────────────────────

export interface PluginDomainOptions {
  /** 获取内核插件宿主状态列表（loop.pluginHost.list()；含安全层插件） */
  getPluginHosts: () => PluginStatusLike[];
  /** 获取目录插件管理面（PluginManager 映射；未装配时查询返回空、写操作报错） */
  getDirectoryManager?: () => PluginManagerLike | null;
}

// ────────────────────────────────────────────────────────────
// 插件域工厂
// ────────────────────────────────────────────────────────────

export function createPluginDomain(options: PluginDomainOptions): DomainHandler {
  const { getPluginHosts } = options;
  const getDirectoryManager = options.getDirectoryManager ?? (() => null);
  const manager = (): PluginManagerLike => {
    const m = getDirectoryManager();
    if (!m) throw new Error('plugin manager not available（该 UI 通道未接入目录插件管理）');
    return m;
  };

  return {
    /** 查询内核插件挂载状态（B-4：挂载失败可见） */
    async list(): Promise<PluginStatusLike[]> {
      return getPluginHosts();
    },

    /** 查询目录插件清单（PluginManager 全量，含未激活的） */
    async listDirectory(): Promise<{ plugins: DirectoryPluginLike[] }> {
      const m = getDirectoryManager();
      return { plugins: m ? m.getAll() : [] };
    },

    /** 启用目录插件（加载并挂载） */
    async activate(params: unknown): Promise<{ ok: boolean; id: string }> {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('plugin.activate requires "id"');
      await manager().activate(id);
      return { ok: true, id };
    },

    /** 停用目录插件 */
    async deactivate(params: unknown): Promise<{ ok: boolean; id: string }> {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('plugin.deactivate requires "id"');
      await manager().deactivate(id);
      return { ok: true, id };
    },

    /** 从磁盘重载目录插件（改完代码后用） */
    async reload(params: unknown): Promise<{ ok: boolean; id: string }> {
      const id = (params as { id?: string } | undefined)?.id;
      if (!id) throw new Error('plugin.reload requires "id"');
      await manager().reloadFromDisk(id);
      return { ok: true, id };
    },
  };
}
