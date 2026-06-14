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
 *   7. 模式状态与 session 绑定（切换 session 时自动保存/恢复）
 */

import type { ModeState, ModeDefinition } from './types.js';
import { createLogger } from '../logging/logger.js';
import fs from 'node:fs';
import path from 'node:path';

const logger = createLogger('mode-manager');
const MODE_STATE_FILE = 'mode-state.json';

export class ModeManager {
  private definitions = new Map<string, ModeDefinition>();
  private activeDef: ModeDefinition | null = null;
  private activeState: ModeState | null = null;
  private sessionDir: string | null = null;

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
    this.autoSave();
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
    this.autoSave();
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
    this.autoSave();
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

  // ── Session 绑定 ──────────────────────────────────────────────────

  /**
   * 切换 session：保存当前模式状态到旧 session → 清理 → 从新 session 恢复。
   * 由 AgentLoop.switchSession() 调用。
   */
  switchSession(newSessionDir: string): void {
    // 1. 保存当前状态到旧 session（保留，切回来时可恢复）
    if (this.activeDef && this.activeState && this.sessionDir) {
      this.writeStateFile(this.sessionDir, this.activeDef.name, this.activeState);
    }
    // 2. 清理内存状态（不触发 autoSave，旧 session 文件已保存）
    if (this.activeDef && this.activeState) {
      try { this.activeDef.onDeactivate?.(this.activeState); } catch {}
    }
    this.activeDef = null;
    this.activeState = null;
    // 3. 绑定新 session 目录
    this.sessionDir = newSessionDir;
    // 4. 从新 session 恢复模式
    this.tryRestore();
  }

  /** 设置初始 session 目录（factory 创建时调用，不触发 switch） */
  setSessionDir(dir: string): void {
    this.sessionDir = dir;
    this.tryRestore();
  }

  // ── 持久化 ────────────────────────────────────────────────────────

  private modeFilePath(): string | null {
    if (!this.sessionDir) return null;
    return path.join(this.sessionDir, MODE_STATE_FILE);
  }

  private autoSave(): void {
    const filePath = this.modeFilePath();
    if (!filePath) return;
    try {
      if (this.activeDef && this.activeState) {
        this.writeStateFile(this.sessionDir!, this.activeDef.name, this.activeState);
      } else {
        // 显式停用 → 删除持久化文件
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn('Failed to save mode state', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private writeStateFile(dir: string, name: string, state: ModeState): void {
    const filePath = path.join(dir, MODE_STATE_FILE);
    fs.writeFileSync(filePath, JSON.stringify({ name, state }, null, 2), 'utf-8');
  }

  private tryRestore(): void {
    const filePath = this.modeFilePath();
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { name: string; state: ModeState };
      const mode = this.definitions.get(data.name.toLowerCase());
      if (!mode) {
        logger.warn(`Mode "${data.name}" from session state not registered, skipping restore.`);
        return;
      }
      this.activeDef = mode;
      this.activeState = data.state;
      logger.info(`Mode restored from session: "${data.name}"`);
    } catch (err) {
      logger.warn('Failed to restore mode state', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}