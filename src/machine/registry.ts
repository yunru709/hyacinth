// ============================================================
// MachineRegistry — 状态机注册表
// ============================================================
//
// 管理多个 FlowController 的生命周期。
// 同一时间只有一个 Flow 处于活跃状态——激活新 Flow 前
// 自动停用当前活跃的 Flow。
//
// MachineRegistry 直接存储 FlowController（而非 MachineRunner），
// 这样 ContextSource 可以直接调用 getInjection()，无需额外映射。
// ============================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MachineContext } from './types.js';
import type { FlowController } from './flows/types.js';
import type { MachineRunnerState } from './runner.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('machine-registry');

/** 持久化文件名 */
const STATE_FILE = 'flow-state.json';

export class MachineRegistry {
  private flows = new Map<string, FlowController>();
  private activeId: string | null = null;
  private persistenceDir: string | null = null;

  /** 注册 Flow */
  register(flow: FlowController): void {
    if (this.flows.has(flow.id)) {
      logger.warn('Flow already registered, replacing', { id: flow.id });
    }
    this.flows.set(flow.id, flow);
  }

  /** 按 id 获取 Flow */
  get(id: string): FlowController | undefined {
    return this.flows.get(id);
  }

  /** 获取当前活跃的 Flow */
  getActive(): FlowController | undefined {
    if (!this.activeId) return undefined;
    const flow = this.flows.get(this.activeId);
    // 只有当 Flow 的 runner 处于 active 状态时才返回
    if (flow?.runner.status === 'active') return flow;
    return undefined;
  }

  /** 设置持久化目录（factory 在 sessionDir 确定后调用） */
  setPersistenceDir(dir: string): void {
    this.persistenceDir = dir;
  }

  /** 激活指定 Flow（自动停用当前活跃 Flow） */
  activate(id: string, context?: MachineContext): void {
    const flow = this.flows.get(id);
    if (!flow) {
      logger.error('Cannot activate unknown flow', undefined, { id });
      return;
    }

    // 停用当前活跃 Flow
    if (this.activeId && this.activeId !== id) {
      this.deactivate();
    }

    this.activeId = id;
    flow.activate(context);
    logger.info('Flow activated', { id });
    this.save().catch(() => {});
  }

  /** 停用当前活跃 Flow */
  deactivate(): void {
    if (this.activeId) {
      const flow = this.flows.get(this.activeId);
      if (flow && flow.runner.status === 'active') {
        flow.deactivate();
      }
      logger.info('Flow deactivated', { id: this.activeId });
      this.activeId = null;
      this.save().catch(() => {});
    }
  }

  /**
   * 步骤完成回调。
   *
   * 调用活跃 Flow 的 advance('flow_complete')。
   * 如果转移结果 isTerminal，停用该 Flow。
   *
   * @deprecated 请使用 onAdvanceSucceeded — flow_complete 工具内部已调用 advance，
   *   orchestrator loop 只需检查结果后调用 onAdvanceSucceeded 做清理。
   */
  async onStepComplete(): Promise<void> {
    const active = this.getActive();
    if (!active) return;

    const result = active.advance('flow_complete');

    if (result.isTerminal) {
      // 所有步骤完成
      logger.info('Flow completed', { id: active.id });
      // runner 内部的 onComplete 已由 MachineRunner.advance() 触发
      this.activeId = null;
    }
  }

  /**
   * 标记一次成功的 advance 的后续处理。
   *
   * flow_complete 工具内部已调用 advance()，
   * 这里只做 post-advance 清理（terminal → deactivate）。
   */
  onAdvanceSucceeded(flowId: string, isTerminal: boolean): void {
    if (isTerminal) {
      logger.info('Flow completed', { id: flowId });
      this.activeId = null;
    }
    this.save().catch(() => {});
  }

  // ── 持久化 ──────────────────────────────────────────────────

  private getStatePath(): string | null {
    if (!this.persistenceDir) return null;
    return path.join(this.persistenceDir, STATE_FILE);
  }

  /** 保存当前活跃 Flow 状态到磁盘 */
  private async save(): Promise<void> {
    const statePath = this.getStatePath();
    if (!statePath) return;

    try {
      if (!this.activeId) {
        // 无活跃 flow → 删除状态文件（避免重启后误恢复已完成的 flow）
        try { await fs.unlink(statePath); } catch { /* 文件不存在则跳过 */ }
        return;
      }

      const flow = this.flows.get(this.activeId);
      if (!flow || flow.runner.status !== 'active') {
        try { await fs.unlink(statePath); } catch { /* skip */ }
        return;
      }

      const state: MachineRunnerState = flow.runner.toJSON();
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('Failed to save flow state', { error: (err as Error).message });
    }
  }

  /**
   * 从磁盘恢复 Flow 状态。
   * 应在 session 确定后、首次 run 之前调用。
   */
  async load(): Promise<void> {
    const statePath = this.getStatePath();
    if (!statePath) return;

    let raw: string;
    try {
      raw = await fs.readFile(statePath, 'utf-8');
    } catch {
      return; // 文件不存在或不可读 → 正常，新 session
    }

    let state: MachineRunnerState;
    try {
      state = JSON.parse(raw) as MachineRunnerState;
    } catch {
      logger.warn('Corrupted flow-state.json, ignoring');
      try { await fs.unlink(statePath); } catch { /* skip */ }
      return;
    }

    // 验证必要字段
    if (!state.machineId || !state.currentState) {
      logger.warn('Incomplete flow-state.json, ignoring');
      return;
    }

    const flow = this.flows.get(state.machineId);
    if (!flow) {
      logger.warn('Unknown flow type in flow-state.json', { machineId: state.machineId });
      try { await fs.unlink(statePath); } catch { /* skip */ }
      return;
    }

    // 恢复 runner 状态（不触发 onEnter/onExit，纯数据恢复）
    try {
      flow.runner.restoreState(state);
    } catch (err) {
      logger.warn('Failed to restore flow state', { error: (err as Error).message });
      try { await fs.unlink(statePath); } catch { /* skip */ }
      return;
    }

    this.activeId = state.machineId;
    logger.info('Flow state restored', { id: state.machineId, state: state.currentState });
  }
}
