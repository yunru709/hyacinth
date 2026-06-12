/**
 * ModeManager — 模式系统统一管理器
 *
 * 职责：
 *   1. 注册/注销模式定义
 *   2. 激活/停用模式（模式互斥）
 *   3. 状态查询（isActive / getActive / getState）
 *   4. 注入内容渲染（委托到当前模式）
 *   5. 标记处理（委托到当前模式）
 *   6. 自动检测停用条件
 */

import type { ModeState, ModeDefinition } from './types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('mode-manager');

export class ModeManager {
  private definitions = new Map<string, ModeDefinition>();
  private activeDef: ModeDefinition | null = null;
  private activeState: ModeState | null = null;

  register(mode: ModeDefinition): void {
    const name = mode.name.toLowerCase();
    if (this.definitions.has(name)) {
      logger.warn(`Mode "${name}" already registered, overwriting.`);
    }
    this.definitions.set(name, mode);
    logger.info(`Mode registered: "${name}"`);
  }

  list(): string[] {
    return [...this.definitions.keys()];
  }

  activate(name: string, params: Record<string, unknown> = {}): ModeState {
    const key = name.toLowerCase();
    if (this.activeDef) this.deactivate();
    const mode = this.definitions.get(key);
    if (!mode) throw new Error(`Mode "${name}" not registered. Available: [${this.list().join(', ')}]`);
    this.activeDef = mode;
    this.activeState = mode.createState(params);
    logger.info(`Mode activated: "${name}"`, { params });
    return this.activeState;
  }

  deactivate(): void {
    if (!this.activeDef || !this.activeState) return;
    const name = this.activeDef.name;
    try { this.activeDef.onDeactivate?.(this.activeState); } catch (err) {
      logger.error(`Error in onDeactivate for mode "${name}"`, err instanceof Error ? err : undefined);
    }
    this.activeDef = null;
    this.activeState = null;
    logger.info(`Mode deactivated: "${name}"`);
  }

  isActive(): boolean { return this.activeDef !== null; }
  getActive(): string | null { return this.activeDef?.name ?? null; }
  getState(): ModeState | null { return this.activeState; }

  renderForInjection(): string | null {
    if (!this.activeDef || !this.activeState) return null;
    return this.activeDef.renderForInjection(this.activeState);
  }

  /**
   * 工具驱动入口：LLM 调用 task_mark → dispatch 到当前激活模式的 handleToolCall。
   * 返回给 LLM 的进度摘要，若与当前模式无关则返回 null。
   */
  dispatchToolCall(action: string, params: Record<string, unknown>): { mode: string; progress: string; allDone: boolean } | null {
    if (!this.activeDef || !this.activeState) return null;
    if (!this.activeDef.handleToolCall) return null;

    const result = this.activeDef.handleToolCall(this.activeState, action, params as any);
    if (!result) return null;

    this.activeState = result.newState;
    return { mode: result.result.mode, progress: result.result.progress, allDone: result.result.allDone };
  }

  /**
   * 检查当前模式是否已完成（用于自动停用检测）
   */
  checkComplete(): boolean {
    if (!this.activeDef || !this.activeState) return false;

    if (this.activeDef.isComplete(this.activeState)) {
      logger.info(`Mode "${this.activeDef.name}" completed, auto-deactivating.`);
      this.deactivate();
      return true;
    }

    return false;
  }
}