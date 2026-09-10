// ============================================================
// UI 协议层 — 工具域（tool.*）
// ============================================================
// 覆盖 UI 对工具注册表的查询与启停控制：
//   tool.list    列出全部工具（名称/描述/来源/启用状态/是否被工具包过滤/所属工具包）
//   tool.toggle  启用/禁用某个工具（内存级，与会话同生命周期）
//   tool.bundles 列出可用工具包（供 UI 做「加入工具包」下拉）
//
// 实现：通过闭包延迟解析 ToolRegistry + ToolBundleRegistry
// （agent 在 initialize 后才就绪），与 kb/process 域同模式。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { BundleRegistryLike } from './bundle.js';

// ────────────────────────────────────────────────────────────
// 最小接口（结构兼容）
// ────────────────────────────────────────────────────────────

export interface ToolEntryLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** 来源：'builtin' | 'mcp' | 'plugin' | 'file' | 'user'（RegistryItem.source） */
  source?: string;
  /** source==='mcp' 时为所属 MCP Server 名（由 MCPBridge 写入） */
  mcpServer?: string;
}

export interface ToolRegistryLike {
  getAll(): ToolEntryLike[];
  has(name: string): boolean;
  isEnabled(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
  /** 会话内热插拔添加的工具（可选，老实现可能没有） */
  getHotAddedNames?(): string[];
}

export type { BundleRegistryLike } from './bundle.js';

export interface ToolDomainOptions {
  getToolRegistry: () => ToolRegistryLike | null;
  getBundleRegistry: () => BundleRegistryLike | null;
}

/** tool.list 的单条结果 */
export interface ToolView {
  name: string;
  description?: string;
  /** 'builtin' | 'mcp' | 'plugin' | 'file' | 'user'，缺失时回落 builtin */
  source: string;
  /** source==='mcp' 时所属 MCP Server 名 */
  mcpServer?: string;
  enabled: boolean;
  /** 非全量模式下不在激活包内 → 被过滤 */
  bundleFiltered: boolean;
  /** 所属工具包名（按 bundle-registry 的 tools 数组计算，含内置与自定义） */
  bundles: string[];
  /** 会话内热插拔添加（重启后消失） */
  hotAdded: boolean;
}

// ────────────────────────────────────────────────────────────
// 工具域工厂
// ────────────────────────────────────────────────────────────

export function createToolDomain(options: ToolDomainOptions): DomainHandler {
  const { getToolRegistry, getBundleRegistry } = options;

  return {
    // ── tool.list ──────────────────────────────────────────
    async list(): Promise<{ tools: ToolView[] }> {
      const registry = getToolRegistry();
      if (!registry) throw new Error('tool.list not supported (tool registry not available)');
      const bundles = getBundleRegistry();
      const allMode = bundles?.isAllMode() ?? true;
      const activeSet = new Set(bundles?.getActiveToolNames() ?? []);

      // 工具名 → 所属工具包（供 UI 直接渲染「移出」操作）
      const membership = new Map<string, string[]>();
      if (bundles) {
        for (const b of bundles.list()) {
          for (const t of b.tools) {
            const arr = membership.get(t);
            if (arr) arr.push(b.name);
            else membership.set(t, [b.name]);
          }
        }
      }

      const hotAdded = new Set(registry.getHotAddedNames?.() ?? []);

      const tools = registry.getAll().map((t) => {
        const source = t.source ?? 'builtin';
        return {
          name: t.name,
          description: t.description,
          source,
          ...(t.mcpServer ? { mcpServer: t.mcpServer } : {}),
          enabled: registry.isEnabled(t.name),
          // 是否被工具包过滤掉（非全量模式且不在激活包内）
          bundleFiltered: !allMode && !activeSet.has(t.name),
          bundles: membership.get(t.name) ?? [],
          hotAdded: hotAdded.has(t.name),
        };
      });
      return { tools };
    },

    // ── tool.toggle ────────────────────────────────────────
    async toggle(params: unknown): Promise<{ ok: true; name: string; enabled: boolean }> {
      const { name, enabled } = (params as { name?: string; enabled?: boolean } | undefined) ?? {};
      if (!name) throw new Error('tool.toggle requires "name"');
      const registry = getToolRegistry();
      if (!registry) throw new Error('tool.toggle not supported (tool registry not available)');
      if (!registry.has(name)) throw new Error(`tool "${name}" not found`);
      if (enabled) registry.enable(name);
      else registry.disable(name);
      return { ok: true, name, enabled: !!enabled };
    },

    // ── tool.bundles：可用工具包（「加入工具包」下拉用）────
    async bundles(): Promise<{ bundles: { name: string; description: string; builtin?: boolean }[] }> {
      const r = getBundleRegistry();
      if (!r) throw new Error('tool.bundles not supported (bundle registry not available)');
      return {
        bundles: r.list().map((b) => ({
          name: b.name,
          description: b.description,
          ...(b.builtin ? { builtin: true } : {}),
        })),
      };
    },
  };
}
