// ============================================================
// UI 协议层 — MCP 域（mcp.*）
// ============================================================
// 覆盖 UI 对 MCP Server 的查询、启停与热插拔管理：
//   mcp.list       列出所有 Server：配置文件声明 ∪ 运行时实例
//                  （名称/启用状态/连接状态/工具数/来源文件）
//   mcp.enable     启用 Server（清除配置文件里的 _disabled 并热重载）
//   mcp.disable    禁用 Server（写入 _disabled 并热重载）
//   mcp.add        运行时热插拔添加一个 Server（不落配置，重启丢失）
//   mcp.remove     运行时热拔一个 Server
//   mcp.reconnect  重连指定 Server
//
// 实装：委托 MCPSystem（getConfigView/setServerEnabled/addExternalServer/
// removeExternalServer/getManagers），通过闭包延迟解析（agent initialize 后可用）。
//
// 注：mcp.list 以**配置文件**为准（可见被禁用的 Server），运行时实例只补充
// connected/toolCount。这样 UI 才能给出「启用/关闭」开关 —— 早期版本只列
// 运行时实例，被 _disabled 的 Server 在 UI 上完全消失。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 最小接口（MCPSystem / MCPServerManager 结构兼容）
// ────────────────────────────────────────────────────────────

export interface MCPServerConfigLike {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  packageType?: 'npm' | 'python';
  package?: string;
}

export interface MCPServerManagerLike {
  getName(): string;
  isConnected(): boolean;
  /** 底层 MCPClient（含 getTools） */
  getClient(): { getTools(): unknown[] };
  reconnect(): Promise<void>;
}

/** 配置文件中声明的 Server 视图 */
export interface MCPConfigViewLike {
  name: string;
  enabled: boolean;
  /** 声明它的配置文件路径 */
  file: string;
  scope: 'user' | 'project' | 'project-agent';
  command?: string;
  url?: string;
}

export interface MCPSystemLike {
  getStatus(): { name: string; connected: boolean }[];
  getManagers(): MCPServerManagerLike[];
  getConfigView(): Promise<MCPConfigViewLike[]>;
  setServerEnabled(name: string, enabled: boolean): Promise<string>;
  addExternalServer(config: MCPServerConfigLike, opts?: { isHotPlug?: boolean }): Promise<void>;
  removeExternalServer(name: string): Promise<void>;
}

export interface MCPDomainOptions {
  getMCP: () => MCPSystemLike | null;
}

/** mcp.list 的单条结果 */
export interface MCPServerView {
  name: string;
  /** 配置文件里未被 _disabled 标记 */
  enabled: boolean;
  /** 是否真的连上了（非配置声明的 Server 恒为 true —— 运行时才有它） */
  connected: boolean;
  toolCount: number;
  /** 声明它的配置文件；运行时热插拔添加的 Server 为空 */
  file?: string;
  scope?: 'user' | 'project' | 'project-agent' | 'runtime';
  command?: string;
  url?: string;
}

// ────────────────────────────────────────────────────────────
// MCP 域工厂
// ────────────────────────────────────────────────────────────

export function createMCPDomain(options: MCPDomainOptions): DomainHandler {
  const { getMCP } = options;

  function system(): MCPSystemLike {
    const s = getMCP();
    if (!s) throw new Error('mcp not supported (MCPSystem not available)');
    return s;
  }

  return {
    // ── mcp.list ───────────────────────────────────────────
    async list(): Promise<{ servers: MCPServerView[] }> {
      const s = system();

      // 运行时实例：connected + toolCount
      const runtime = new Map<string, { connected: boolean; toolCount: number }>();
      for (const m of s.getManagers()) {
        let toolCount = 0;
        try {
          toolCount = m.getClient().getTools().length;
        } catch {
          toolCount = 0;
        }
        runtime.set(m.getName(), { connected: m.isConnected(), toolCount });
      }

      // 以配置文件声明为准（含被禁用的）
      const declared = await s.getConfigView();
      const seen = new Set<string>();
      const servers: MCPServerView[] = declared.map((c) => {
        seen.add(c.name);
        const rt = runtime.get(c.name);
        return {
          name: c.name,
          enabled: c.enabled,
          connected: rt?.connected ?? false,
          toolCount: rt?.toolCount ?? 0,
          file: c.file,
          scope: c.scope,
          command: c.command,
          url: c.url,
        };
      });

      // 运行时热插拔添加、配置文件里没有的（mcp.add 进来的）
      for (const [name, rt] of runtime) {
        if (seen.has(name)) continue;
        servers.push({
          name,
          enabled: true,
          connected: rt.connected,
          toolCount: rt.toolCount,
          scope: 'runtime',
        });
      }

      return { servers };
    },

    // ── mcp.enable / mcp.disable ───────────────────────────
    async enable(params: unknown): Promise<{ ok: true; name: string; file: string }> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('mcp.enable requires "name"');
      const s = system();
      const file = await s.setServerEnabled(name, true);
      return { ok: true, name, file };
    },

    async disable(params: unknown): Promise<{ ok: true; name: string; file: string }> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('mcp.disable requires "name"');
      const s = system();
      const file = await s.setServerEnabled(name, false);
      return { ok: true, name, file };
    },

    // ── mcp.add ────────────────────────────────────────────
    async add(params: unknown): Promise<{ ok: true; name: string }> {
      const cfg = (params ?? {}) as MCPServerConfigLike;
      if (!cfg.name) throw new Error('mcp.add requires "name"');
      const s = system();
      await s.addExternalServer(cfg, { isHotPlug: true });
      return { ok: true, name: cfg.name };
    },

    // ── mcp.remove ─────────────────────────────────────────
    async remove(params: unknown): Promise<{ ok: true; name: string }> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('mcp.remove requires "name"');
      const s = system();
      await s.removeExternalServer(name);
      return { ok: true, name };
    },

    // ── mcp.reconnect ─────────────────────────────────────
    async reconnect(params: unknown): Promise<{ ok: true; name: string }> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('mcp.reconnect requires "name"');
      const s = system();
      const manager = s.getManagers().find((m) => m.getName() === name);
      if (!manager) throw new Error(`mcp server "${name}" not found`);
      await manager.reconnect();
      return { ok: true, name };
    },
  };
}
