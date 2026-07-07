// ============================================================
// FlowRegistry — Flow 注册表
// ============================================================
//
// 管理所有 FlowController 的生命周期。
// 同一时间只有一个 Flow 处于活跃状态——激活新 Flow 前
// 自动停用当前活跃的 Flow。
// ============================================================

import type { FlowController, IFlowRegistry } from './types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('flow-registry');

export class FlowRegistry implements IFlowRegistry {
  private flows = new Map<string, FlowController>();
  private activeFlowId: string | null = null;

  register(flow: FlowController): void {
    if (this.flows.has(flow.id)) {
      logger.warn('Flow already registered, replacing', { id: flow.id });
    }
    this.flows.set(flow.id, flow);
  }

  get(id: string): FlowController | undefined {
    return this.flows.get(id);
  }

  getActive(): FlowController | undefined {
    if (!this.activeFlowId) return undefined;
    const flow = this.flows.get(this.activeFlowId);
    if (flow?.status === 'active') return flow;
    return undefined;
  }

  activate(id: string, context?: Record<string, unknown>): void {
    const flow = this.flows.get(id);
    if (!flow) {
      logger.error('Cannot activate unknown flow', undefined, { id });
      return;
    }

    // 停用当前活跃 Flow
    if (this.activeFlowId && this.activeFlowId !== id) {
      this.deactivate();
    }

    this.activeFlowId = id;
    // MutableFlowController 接受 context 参数；固定步骤 Flow 忽略
    (flow as FlowController & { activate(c?: Record<string, unknown>): void }).activate(context);
    logger.info('Flow activated', { id });
  }

  deactivate(): void {
    if (this.activeFlowId) {
      const flow = this.flows.get(this.activeFlowId);
      if (flow && flow.status === 'active') {
        flow.deactivate();
      }
      logger.info('Flow deactivated', { id: this.activeFlowId });
      this.activeFlowId = null;
    }
  }

  async onStepComplete(): Promise<void> {
    const active = this.getActive();
    if (!active) return;

    const hasNext = active.advance();

    if (!hasNext) {
      // 所有步骤完成
      logger.info('Flow completed', { id: active.id });
      if (active.onComplete) {
        await active.onComplete();
      }
      active.status = 'completed';
      // deactivate() 会调用 deactivate()，但我们已经手动设置了 status
      // 直接清理 activeFlowId
      this.activeFlowId = null;
    }
  }
}
