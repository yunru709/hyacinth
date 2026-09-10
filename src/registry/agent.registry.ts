import crypto from 'node:crypto';
import { GenericRegistry, type RegistryItem } from './base.js';
import type { AgentDefinition } from '../types.js';

function shortId(): string {
  return crypto.randomUUID().split('-')[0];
}

interface RegisteredAgent extends AgentDefinition, RegistryItem {}

/**
 * AgentRegistry — 子 Agent 注册表（支持多实例分身）
 *
 * 通过 instanceId 支持同一 name 的多个运行时实例。
 * 继承自 GenericRegistry，但因多实例语义覆写了大部分方法：
 * - items 以 instanceId 为键（非 name）
 * - _disabled 存储禁用的 instanceId
 * - get(name) 返回该名称下所有启用的实例数组
 * - enable/disable 作用于该名称下的所有实例
 */
export class AgentRegistry extends GenericRegistry<RegisteredAgent> {
  /** 按 name 分组存储 { [name]: RegisteredAgent[] } */
  private agents = new Map<string, RegisteredAgent[]>();

  constructor() {
    super();
  }

  // ── 注册 / 创建 ──────────────────────────────────────────────

  /** 注册子 Agent 定义（自动分配 instanceId 若未提供） */
  register(def: RegisteredAgent): RegisteredAgent {
    if (!def.instanceId) {
      def.instanceId = `${def.name}-${shortId()}`;
    }
    const list = this.agents.get(def.name) || [];
    list.push(def);
    this.agents.set(def.name, list);
    this.items.set(def.instanceId!, def);
    this.emit('register', def.name);
    return def;
  }

  /** 基于已有 Agent 创建分身（克隆定义 + 新 instanceId） */
  spawnInstance(name: string, customName?: string): RegisteredAgent | undefined {
    const list = this.agents.get(name);
    if (!list || list.length === 0) return undefined;

    const template = list[0]; // 取第一个作为模板
    const clone: RegisteredAgent = {
      ...template,
      instanceId: `${name}-${shortId()}`,
    };
    if (customName) {
      clone.name = customName;
    }
    return this.register(clone);
  }

  // ── 查询 ─────────────────────────────────────────────────────

  /** 按名称获取该名称下所有启用实例（多实例语义，返回数组而非单值） */
  // @ts-expect-error: AgentRegistry 多实例语义 — get() 返回数组，与基类返回值不同，这是有意为之
  get(name: string): RegisteredAgent[] {
    const list = this.agents.get(name);
    if (!list) return [];
    return list.filter(d => !this._disabled.has(d.instanceId!));
  }

  /** 按实例 ID 精确查找（不受禁用影响） */
  getByInstanceId(instanceId: string): RegisteredAgent | undefined {
    return this.items.get(instanceId);
  }

  /** 获取所有已注册且启用的实例 */
  getAll(): RegisteredAgent[] {
    const result: RegisteredAgent[] = [];
    for (const list of this.agents.values()) {
      for (const def of list) {
        if (!this._disabled.has(def.instanceId!)) {
          result.push(def);
        }
      }
    }
    return result;
  }

  /** 检查给定名称下是否有启用实例 */
  has(name: string): boolean {
    return this.get(name).length > 0;
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────

  /** 启用某个名称下的所有实例 */
  enable(name: string): void {
    const list = this.agents.get(name);
    if (!list) return;
    for (const def of list) {
      this._disabled.delete(def.instanceId!);
    }
    this.emit('enable', name);
  }

  /** 禁用某个名称下的所有实例 */
  disable(name: string): void {
    const list = this.agents.get(name);
    if (!list) return;
    const anyNew = list.some(def => !this._disabled.has(def.instanceId!));
    for (const def of list) {
      this._disabled.add(def.instanceId!);
    }
    if (anyNew) this.emit('disable', name);
  }

  /** 检查某个名称下是否有启用实例 */
  isEnabled(name: string): boolean {
    return this.get(name).length > 0;
  }

  // ── 列表 ─────────────────────────────────────────────────────

  getEnabled(): RegisteredAgent[] {
    return this.getAll();
  }

  getDisabled(): RegisteredAgent[] {
    const result: RegisteredAgent[] = [];
    for (const list of this.agents.values()) {
      for (const def of list) {
        if (this._disabled.has(def.instanceId!)) {
          result.push(def);
        }
      }
    }
    return result;
  }

  // ── 统计 ─────────────────────────────────────────────────────

  isEmpty(): boolean {
    for (const list of this.agents.values()) {
      if (list.length > 0) return false;
    }
    return true;
  }

  size(): number {
    let count = 0;
    for (const list of this.agents.values()) {
      count += list.length;
    }
    return count;
  }

  // ── 移除 ─────────────────────────────────────────────────────

  /** 注销某个名称的全部实例 */
  unregister(name: string): boolean {
    const list = this.agents.get(name);
    if (!list) return false;
    for (const def of list) {
      this.items.delete(def.instanceId!);
      this._disabled.delete(def.instanceId!);
    }
    this.agents.delete(name);
    this.emit('unregister', name);
    return true;
  }

  /** 销毁单个实例 */
  destroyInstance(instanceId: string): boolean {
    const def = this.items.get(instanceId);
    if (!def) return false;
    this.items.delete(instanceId);
    this._disabled.delete(instanceId);

    const list = this.agents.get(def.name);
    if (list) {
      const idx = list.findIndex(d => d.instanceId === instanceId);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.agents.delete(def.name);
    }
    return true;
  }

  /** 更新单个实例的配置 */
  update(instanceId: string, partial: Partial<Omit<AgentDefinition, 'name' | 'instanceId'>>): RegisteredAgent | undefined {
    const def = this.items.get(instanceId);
    if (!def) return undefined;

    if (partial.description !== undefined) def.description = partial.description;
    if (partial.systemPrompt !== undefined) def.systemPrompt = partial.systemPrompt;
    if (partial.allowedTools !== undefined) def.allowedTools = partial.allowedTools;
    if (partial.modelPreference !== undefined) def.modelPreference = partial.modelPreference;
    if (partial.maxTurns !== undefined) def.maxTurns = partial.maxTurns;
    if (partial.sessionTtlMinutes !== undefined) def.sessionTtlMinutes = partial.sessionTtlMinutes;

    this.emit('update', instanceId);
    return def;
  }

  // ── 索引（供 prompt 使用） ────────────────────────────────────

  /** 生成紧凑索引（名称 + 描述 + instanceId），供 Zone 2 使用 */
  getIndex(): string {
    const all = this.getAll();
    if (all.length === 0) return 'No sub-agents available';
    return all.map(a => {
      const extra = all.filter(x => x.name === a.name).length > 1
        ? ` (id: ${a.instanceId})`
        : '';
      return `- ${a.name}${extra}: ${a.description}`;
    }).join('\n');
  }

  /** 生成完整定义文本，供精确模式展开 */
  getFullDefinitions(names?: string[]): string {
    const agents = names
      ? this.getAll().filter(a => names.includes(a.name))
      : this.getAll();
    if (agents.length === 0) return '';
    return agents.map(a => {
      const tools = a.allowedTools.length > 0 ? a.allowedTools.join(', ') : 'all';
      return `## Sub-Agent: ${a.name}\nInstance: ${a.instanceId}\nDescription: ${a.description}\nAllowed Tools: ${tools}\nMax Turns: ${a.maxTurns}\nSystem Prompt: ${a.systemPrompt}`;
    }).join('\n\n');
  }

  // ── 向后兼容别名 ──────────────────────────────────────────────

  /** @deprecated 使用 enable() 替代 */
  enableAgent(name: string): void {
    this.enable(name);
  }

  /** @deprecated 使用 disable() 替代 */
  disableAgent(name: string): void {
    this.disable(name);
  }
}