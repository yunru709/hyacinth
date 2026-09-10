import { createLogger } from '../logging/logger.js';

/**
 * GenericRegistry<T> — 统一注册表基类
 *
 * 提供所有 Registry 共享的 register/unregister/enable/disable 标准接口。
 * 子类只需继承并选择性重写特定方法即可。
 */

const logger = createLogger('registry');

/** 所有可注册对象的基接口 */
export interface RegistryItem {
  /** 唯一标识 */
  name: string;
  /** 来源标识：'builtin' | 'mcp' | 'plugin' | 'file' | 'user' */
  source?: string;
}

export type RegistryEvent = 'register' | 'unregister' | 'enable' | 'disable' | 'update';

export type RegistryEventListener = (event: RegistryEvent, name: string) => void;

export abstract class GenericRegistry<T extends RegistryItem> {
  /** 注册条目 */
  protected items = new Map<string, T>();
  /** 禁用集合 */
  protected _disabled = new Set<string>();
  /** 事件监听器 */
  private listeners: RegistryEventListener[] = [];
  /**
   * 同名覆盖守卫：返回 false 拒绝覆盖（安全门禁——防止插件/MCP 热重载
   * 通过同名注册替换内置工具；子类按需设置，未设置时保持旧行为）。
   */
  protected overwriteGuard?: (incoming: T, existing: T) => boolean;

  // ── 注册 / 注销 ──────────────────────────────────────────────

  /** 注册一个条目（同名覆盖，受 overwriteGuard 门禁约束） */
  register(item: T): void {
    const existing = this.items.get(item.name);
    if (existing && this.overwriteGuard && !this.overwriteGuard(item, existing)) {
      logger.warn(`overwrite denied by overwriteGuard: "${item.name}"`, {
        name: item.name,
        existingSource: existing.source ?? 'core',
        incomingSource: item.source ?? 'core',
      });
      return;
    }
    this.items.set(item.name, item);
    this.emit('register', item.name);
  }

  /** 注销一个条目，返回是否成功 */
  unregister(name: string): boolean {
    this._disabled.delete(name);
    const deleted = this.items.delete(name);
    if (deleted) this.emit('unregister', name);
    return deleted;
  }

  // ── 查询 ─────────────────────────────────────────────────────

  /** 获取指定条目（禁用的返回 undefined） */
  get(name: string): T | undefined {
    if (this._disabled.has(name)) return undefined;
    return this.items.get(name);
  }

  /** 获取所有已启用条目 */
  getAll(): T[] {
    return [...this.items.values()].filter((i) => !this._disabled.has(i.name));
  }

  /** 检查条目是否存在（不区分启用/禁用） */
  has(name: string): boolean {
    return this.items.has(name);
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────

  /** 启用一个条目 */
  enable(name: string): void {
    if (this._disabled.has(name)) {
      this._disabled.delete(name);
      this.emit('enable', name);
    }
  }

  /** 禁用一个条目（存在才禁用） */
  disable(name: string): void {
    if (this.items.has(name) && !this._disabled.has(name)) {
      this._disabled.add(name);
      this.emit('disable', name);
    }
  }

  /** 检查是否已启用 */
  isEnabled(name: string): boolean {
    return this.items.has(name) && !this._disabled.has(name);
  }

  /** 获取所有已启用条目（同 getAll） */
  getEnabled(): T[] {
    return this.getAll();
  }

  /** 获取所有已禁用条目 */
  getDisabled(): T[] {
    return [...this.items.values()].filter((i) => this._disabled.has(i.name));
  }

  // ── 统计 ─────────────────────────────────────────────────────

  /** 检查注册表是否为空 */
  isEmpty(): boolean {
    return this.items.size === 0;
  }

  /** 获取注册条目总数（含禁用） */
  size(): number {
    return this.items.size;
  }

  // ── 事件 ─────────────────────────────────────────────────────

  /** 注册事件监听 */
  onEvent(listener: RegistryEventListener): void {
    this.listeners.push(listener);
  }

  /** 移除事件监听 */
  offEvent(listener: RegistryEventListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  protected emit(event: RegistryEvent, name: string): void {
    for (const listener of this.listeners) {
      try { listener(event, name); } catch { /* 不抛出让调用方崩溃 */ }
    }
  }
}