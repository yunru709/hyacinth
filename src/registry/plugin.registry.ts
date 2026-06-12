import { GenericRegistry, type RegistryItem } from './base.js';
import type { PluginManager } from '../plugins/manager.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredPlugin extends RegistryItem {
  name: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

/**
 * PluginRegistry — 带 enable/disable 能力的插件注册表。
 *
 * 包装 PluginManager，在其基础上添加启用/禁用控制：
 * - 禁用的插件不会出现在 getAll 中
 * - 查询接口（getAll / get）仅返回已启用的插件
 */
export class PluginRegistry extends GenericRegistry<RegisteredPlugin> {
  private manager: PluginManager;

  constructor(manager: PluginManager) {
    super();
    this.manager = manager;
  }

  // ── 查询（仅已启用） ──────────────────────────────────────────

  /** 获取所有已启用的插件 */
  getAll(): RegisteredPlugin[] {
    const allPlugins = this.manager.getAll().map((p) => ({
      name: p.manifest.id,
      source: 'plugin' as const,
    }));
    // 过滤掉已禁用的
    return allPlugins.filter((p) => this.isEnabled(p.name));
  }

  /** 获取指定插件（禁用的返回 undefined） */
  get(name: string): RegisteredPlugin | undefined {
    if (!this.isEnabled(name)) return undefined;
    const instance = this.manager.get(name);
    if (!instance) return undefined;
    return { name: instance.manifest.id, source: 'plugin' };
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────

  disable(name: string): void {
    // 确保插件存在再禁用
    if (this.manager.get(name)) {
      super.disable(name);
    }
  }

  enable(name: string): void {
    super.enable(name);
  }

  // ── 生命周期代理 ─────────────────────────────────────────────

  /** 激活指定插件 */
  async activate(id: string, config?: Record<string, unknown>): Promise<void> {
    return this.manager.activate(id, config);
  }

  /** 停用指定插件 */
  async deactivate(id: string): Promise<void> {
    return this.manager.deactivate(id);
  }

  /** 完整流程：发现 → 加载 → 激活 → 连接 MCP → 注册 Skill 源 */
  async loadAll(): Promise<void> {
    return this.manager.loadAll();
  }

  // ── 内部工具 ─────────────────────────────────────────────────

  /** 获取内部 PluginManager */
  getManager(): PluginManager {
    return this.manager;
  }
}