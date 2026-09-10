// ============================================================
// UI 协议层 — 工具包域（bundle.*）
// ============================================================
// 覆盖 UI 对工具包（ToolBundle）的完整管理：
//   bundle.list          列出全部工具包 + 激活状态 + 全量模式标记
//   bundle.activate      激活指定工具包（可多包，替换当前激活集）
//   bundle.deactivate    回到全量模式（清空激活集）
//   bundle.create        创建自定义工具包
//   bundle.delete        删除自定义工具包（内置包不可删）
//   bundle.addTools      向工具包追加工具
//   bundle.removeTools   从工具包移除工具
//
// 实装：委托 ToolBundleRegistry（持久化到 ~/.agent/tool-bundles.json），
// 通过闭包延迟解析（agent initialize 后可用）。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 最小接口（ToolBundleRegistry 结构兼容）
// ────────────────────────────────────────────────────────────

export interface BundleMeta {
  name: string;
  description: string;
  builtin?: boolean;
  tools: string[];
}

export interface BundleRegistryLike {
  isAllMode(): boolean;
  list(): BundleMeta[];
  getActive(): BundleMeta[];
  getActiveToolNames(): string[];
  activate(names: string[]): void;
  deactivate(): void;
  create(name: string, description: string, tools: string[]): BundleMeta;
  delete(name: string): void;
  addTools(bundleName: string, toolNames: string[]): void;
  removeTools(bundleName: string, toolNames: string[]): void;
}

export interface BundleDomainOptions {
  getBundleRegistry: () => BundleRegistryLike | null;
}

// ────────────────────────────────────────────────────────────
// 工具包域工厂
// ────────────────────────────────────────────────────────────

export function createBundleDomain(options: BundleDomainOptions): DomainHandler {
  const { getBundleRegistry } = options;

  function registry(): BundleRegistryLike {
    const r = getBundleRegistry();
    if (!r) throw new Error('bundle not supported (bundle registry not available)');
    return r;
  }

  return {
    // ── bundle.list ────────────────────────────────────────
    async list(): Promise<{ allMode: boolean; bundles: (BundleMeta & { active: boolean })[] }> {
      const r = registry();
      const activeNames = new Set(r.getActive().map((b) => b.name));
      return {
        allMode: r.isAllMode(),
        bundles: r.list().map((b) => ({ ...b, active: activeNames.has(b.name) })),
      };
    },

    // ── bundle.activate ────────────────────────────────────
    async activate(params: unknown): Promise<{ ok: true; names: string[] }> {
      const names = (params as { names?: string[] } | undefined)?.names;
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error('bundle.activate requires non-empty "names" array');
      }
      const r = registry();
      r.activate(names);
      return { ok: true, names };
    },

    // ── bundle.deactivate（回全量模式）────────────────────
    async deactivate(): Promise<{ ok: true }> {
      const r = registry();
      r.deactivate();
      return { ok: true };
    },

    // ── bundle.create ──────────────────────────────────────
    async create(params: unknown): Promise<BundleMeta> {
      const { name, description, tools } = (params as { name?: string; description?: string; tools?: string[] } | undefined) ?? {};
      if (!name) throw new Error('bundle.create requires "name"');
      const r = registry();
      return r.create(name, description ?? '', Array.isArray(tools) ? tools : []);
    },

    // ── bundle.delete ──────────────────────────────────────
    async delete(params: unknown): Promise<{ ok: true; name: string }> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('bundle.delete requires "name"');
      const r = registry();
      r.delete(name);
      return { ok: true, name };
    },

    // ── bundle.addTools ────────────────────────────────────
    async addTools(params: unknown): Promise<{ ok: true; name: string; tools: string[] }> {
      const { name, tools } = (params as { name?: string; tools?: string[] } | undefined) ?? {};
      if (!name || !Array.isArray(tools) || tools.length === 0) {
        throw new Error('bundle.addTools requires "name" and non-empty "tools"');
      }
      const r = registry();
      r.addTools(name, tools);
      return { ok: true, name, tools };
    },

    // ── bundle.removeTools ─────────────────────────────────
    async removeTools(params: unknown): Promise<{ ok: true; name: string; tools: string[] }> {
      const { name, tools } = (params as { name?: string; tools?: string[] } | undefined) ?? {};
      if (!name || !Array.isArray(tools) || tools.length === 0) {
        throw new Error('bundle.removeTools requires "name" and non-empty "tools"');
      }
      const r = registry();
      r.removeTools(name, tools);
      return { ok: true, name, tools };
    },
  };
}
