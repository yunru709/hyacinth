/**
 * WorkflowManager — 工作流运行时状态管理器
 *
 * 职责：
 *   1. 激活/停用 Workflow（互斥）
 *   2. 步骤分发（委托到当前 WorkflowDefinition.handleStep）
 *   3. 注入内容渲染（persistent + step 双通道）
 *   4. 自动检测停用条件
 *   5. 状态与 session 绑定（切换 session 时自动保存/恢复）
 *
 * 注入架构：
 *   renderPersistent() → Zone 5 workflow_persistent（阶段引导/分析结果，阶段切换时变化）
 *   renderStep()      → Zone 5 workflow_step（当前步骤指令，每步变化）
 *   未实现 renderPersistent/renderStep 的旧 Workflow 回退到 renderForInjection。
 */

import type { WorkflowDefinition, WorkflowState, WorkflowStepAction, WorkflowStepResult } from './types.js';
import type { WorkflowRegistry } from './registry.js';
import { createLogger } from '../logging/logger.js';
import fs from 'node:fs';
import path from 'node:path';

const logger = createLogger('workflow-manager');
const WORKFLOW_STATE_FILE = 'workflow-state.json';

export class WorkflowManager {
  private activeDef: WorkflowDefinition | null = null;
  private activeState: WorkflowState | null = null;
  private sessionDir: string | null = null;

  constructor(private registry: WorkflowRegistry) {}

  // ── 注册代理 ─────────────────────────────────────────────────────

  /** 注册一个 Workflow 定义（代理到 WorkflowRegistry） */
  register(def: WorkflowDefinition): void {
    this.registry.register(def);
  }

  /** 列出所有已注册 Workflow 名称 */
  list(): string[] {
    return this.registry.getAll().map(d => d.name);
  }

  // ── 激活 / 停用 ──────────────────────────────────────────────────

  /** 激活指定 Workflow（自动停用当前已激活的 Workflow） */
  activate(name: string, params: Record<string, unknown> = {}): WorkflowState {
    if (this.activeDef) this.deactivate();

    // 大小写不敏感查找
    const def = this.registry.get(name)
      ?? this.registry.getAll().find(d => d.name.toLowerCase() === name.toLowerCase());

    if (!def) {
      const available = this.list().join(', ');
      throw new Error(`Workflow "${name}" not registered. Available: [${available}]`);
    }

    this.activeDef = def;
    this.activeState = def.createState(params);
    logger.info(`Workflow activated: "${name}"`, { params });
    this.autoSave();
    return this.activeState;
  }

  /** 停用当前 Workflow */
  deactivate(): void {
    if (!this.activeDef || !this.activeState) return;
    const name = this.activeDef.name;
    try { this.activeDef.onDeactivate?.(this.activeState); } catch (err) {
      logger.error(`Error in onDeactivate for workflow "${name}"`, err instanceof Error ? err : undefined);
    }
    this.activeDef = null;
    this.activeState = null;
    logger.info(`Workflow deactivated: "${name}"`);
    this.autoSave();
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  isActive(): boolean { return this.activeDef !== null; }
  getActive(): string | null { return this.activeDef?.name ?? null; }
  getState(): WorkflowState | null { return this.activeState; }

  // ── 注入 ─────────────────────────────────────────────────────────

  /** 回退用的组合注入（兼容旧 workflow） */
  renderForInjection(): string | null {
    if (!this.activeDef || !this.activeState) return null;
    return this.activeDef.renderForInjection(this.activeState);
  }

  /**
   * 持久上下文 — 分析结果等不随步骤变化的内容。
   * 若 workflow 实现了 renderPersistent 则用新接口，否则回退到 renderForInjection。
   */
  renderPersistent(): string | null {
    if (!this.activeDef || !this.activeState) return null;
    if (this.activeDef.renderPersistent) {
      return this.activeDef.renderPersistent(this.activeState);
    }
    // 兼容：旧 workflow 的 renderForInjection 作为 persistent 内容
    return this.activeDef.renderForInjection(this.activeState);
  }

  /**
   * 当前步骤 — 单条步骤指令，每轮变化。
   * 若 workflow 实现了 renderStep 则用新接口，否则返回 null（不重复注入）。
   */
  renderStep(): string | null {
    if (!this.activeDef || !this.activeState) return null;
    if (this.activeDef.renderStep) {
      return this.activeDef.renderStep(this.activeState);
    }
    return null;
  }

  // ── 步骤分发 ─────────────────────────────────────────────────────

  /**
   * 工具驱动入口：LLM 调用 workflow({action:"step", ...}) → dispatch 到当前 WorkflowDefinition.handleStep。
   * 若当前 Workflow 未实现 handleStep，返回 null。
   */
  dispatchStep(action: WorkflowStepAction): WorkflowStepResult | null {
    if (!this.activeDef || !this.activeState) return null;
    if (!this.activeDef.handleStep) return null;

    const result = this.activeDef.handleStep(this.activeState, action);
    if (!result) return null;

    this.activeState = result.newState;
    this.autoSave();
    return result.result;
  }

  // ── 完成检查 ─────────────────────────────────────────────────────

  /** 只读检查：当前工作流是否已完成（不触发停用） */
  isCompleteCheck(): boolean {
    if (!this.activeDef || !this.activeState) return false;
    return this.activeDef.isComplete(this.activeState);
  }

  /** 检查并自动停用已完成的工作流（有副作用，仅在后工具检测时调用） */
  checkComplete(): boolean {
    if (!this.activeDef || !this.activeState) return false;

    if (this.activeDef.isComplete(this.activeState)) {
      logger.info(`Workflow "${this.activeDef.name}" completed, auto-deactivating.`);
      this.deactivate();
      return true;
    }

    return false;
  }

  // ── Session 绑定 ──────────────────────────────────────────────────

  /**
   * 切换 session：保存当前状态到旧 session → 清理 → 从新 session 恢复。
   * 由 AgentLoop.switchSession() 调用。
   */
  switchSession(newSessionDir: string): void {
    // 1. 保存当前状态到旧 session
    if (this.activeDef && this.activeState && this.sessionDir) {
      this.writeStateFile(this.sessionDir, this.activeDef.name, this.activeState);
    }
    // 2. 清理内存状态
    if (this.activeDef && this.activeState) {
      try { this.activeDef.onDeactivate?.(this.activeState); } catch {}
    }
    this.activeDef = null;
    this.activeState = null;
    // 3. 绑定新 session 目录
    this.sessionDir = newSessionDir;
    // 4. 从新 session 恢复
    this.tryRestore();
  }

  /** 设置初始 session 目录（factory 创建时调用，不触发 switch） */
  setSessionDir(dir: string): void {
    this.sessionDir = dir;
    this.tryRestore();
  }

  // ── 持久化 ────────────────────────────────────────────────────────

  private stateFilePath(): string | null {
    if (!this.sessionDir) return null;
    return path.join(this.sessionDir, WORKFLOW_STATE_FILE);
  }

  private autoSave(): void {
    const filePath = this.stateFilePath();
    if (!filePath) return;
    try {
      if (this.activeDef && this.activeState) {
        this.writeStateFile(this.sessionDir!, this.activeDef.name, this.activeState);
      } else {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn('Failed to save workflow state', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private writeStateFile(dir: string, name: string, state: WorkflowState): void {
    const filePath = path.join(dir, WORKFLOW_STATE_FILE);
    fs.writeFileSync(filePath, JSON.stringify({ name, state }, null, 2), 'utf-8');
  }

  private tryRestore(): void {
    const filePath = this.stateFilePath();
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as { name: string; state: WorkflowState };
      // 大小写不敏感查找（与 activate() 一致）
      const def = this.registry.get(data.name)
        ?? this.registry.getAll().find(d => d.name.toLowerCase() === data.name.toLowerCase());
      if (!def) {
        logger.warn(`Workflow "${data.name}" from session state not registered, skipping restore.`);
        return;
      }
      // 若恢复的工作流已完成，跳过激活并清理残留状态文件
      if (def.isComplete(data.state)) {
        logger.info(`Restored workflow "${data.name}" is already complete, skipping.`);
        try { fs.unlinkSync(filePath); } catch {}
        return;
      }
      this.activeDef = def;
      this.activeState = data.state;
      logger.info(`Workflow restored from session: "${data.name}"`);
    } catch (err) {
      logger.warn('Failed to restore workflow state', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
