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

import type { MachineContext } from './types.js';
import type { FlowController } from './flows/types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('machine-registry');

export class MachineRegistry {
  private flows = new Map<string, FlowController>();
  private activeId: string | null = null;

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
  }
}
