// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 安全红线 · 旁路智能体（元认知层）                        ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  本模块管理所有旁路智能体的注册/启停/调度。                  ║
// ║  旁路智能体直接注入主 Agent 上下文，一旦出错会带偏主 Agent， ║
// ║  是本系统【风险最高】的一层。                                ║
// ║                                                              ║
// ║  ✅ 注册的旁路智能体只允许【极其专一化】的窄工具：           ║
// ║     memory_* / inject_hint / cluster_assign / world_* 等      ║
// ║  ❌ 禁止 bash / read / write / edit / http_request 等        ║
// ║     任何通用工具。给旁路智能体加通用工具 = 安全事故。        ║
// ║                                                              ║
// ║  维护此项目的 Agent 请注意：即使只读前几行也必须遵守。      ║
// ║  完整规则见 src/bypass/base.ts 头部。                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ============================================================
// bypass/manager — BypassManager
// ============================================================
//
// 管理所有旁路Agent的生命周期和调度。
// 由 Loop 在每轮对话前后调用 preTurn/postTurn。
//
// 职责：
//   - Agent 注册与启停
//   - preTurn：收集所有活跃Agent的注入内容（阻塞，等旁路LLM完成）
//   - postTurn：并行调度所有Agent的后台观察（不阻塞主流程）
//   - 异常隔离：单个Agent失败不影响其他Agent和主流程
// ============================================================

import type {
  BypassAgent,
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
  Injection,
} from './types.js';
import type { ModelRouterLike } from './base.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('bypass-manager');

export class BypassManager {
  /** 所有已注册的Agent */
  private registry = new Map<string, BypassAgent>();
  /** 当前激活的Agent列表 */
  private active: BypassAgent[] = [];
  /** 模型路由引用（注入后所有Agent共享） */
  private modelRouter: ModelRouterLike | null = null;

  /** 注入模型路由（factory 初始化后调用） */
  setModelRouter(router: ModelRouterLike): void {
    this.modelRouter = router;
    for (const agent of this.registry.values()) {
      if ('setModelRouter' in agent) {
        (agent as any).setModelRouter(router);
      }
    }
  }

  /**
   * 注册一个旁路Agent。
   *
   * ⚠️ 安全约束：旁路智能体 = 元认知层，注册进来即获得 preTurn /
   * postTurn 的注入与记忆维护能力。它的工具必须被严格限制为
   * "极其专一化"的窄工具（memory_* / inject_hint / cluster_assign /
   * world_*），且只能以固定格式读写指定路径的文件。
   *
   * ❌ 任何自带 bash / read / write / edit / http_request 等通用
   * 工具的旁路 Agent 都不应被注册。若确实需要新增旁路能力，
   * 请先阅读 base.ts 头部的安全自问清单，并确保新工具是窄工具。
   */
  register(agent: BypassAgent): void {
    this.registry.set(agent.name, agent);
    if (this.modelRouter && 'setModelRouter' in agent) {
      (agent as any).setModelRouter(this.modelRouter);
    }
    // 注入 BypassManager 引用（供 postTurn 中调 inject() 用）
    if ('_manager' in agent) {
      (agent as any)._manager = this;
    }
    logger.info(`BypassAgent registered: ${agent.name} (modes: ${agent.modes.join(', ')})`);
  }

  /** 取消注册 */
  unregister(name: string): void {
    this.registry.delete(name);
    this.active = this.active.filter(a => a.name !== name);
  }

  /** 根据模式名激活对应的旁路Agent */
  async activateForMode(modeName: string): Promise<void> {
    // 先停用当前活跃的
    await this.deactivateAll();

    const toActivate: BypassAgent[] = [];
    for (const agent of this.registry.values()) {
      if (agent.modes.includes('*') || agent.modes.includes(modeName)) {
        toActivate.push(agent);
      }
    }

    for (const agent of toActivate) {
      try {
        await agent.start();
        this.active.push(agent);
        logger.info(`BypassAgent started: ${agent.name} (mode: ${modeName})`);
      } catch (err) {
        logger.warn(`BypassAgent start failed: ${agent.name}`, { error: (err as Error).message });
      }
    }
  }

  /** 手动激活指定Agent（TUI命令用） */
  async activateAgent(name: string): Promise<void> {
    const agent = this.registry.get(name);
    if (!agent) {
      logger.warn(`BypassAgent not found: ${name}`);
      return;
    }
    if (this.active.includes(agent)) return;

    try {
      await agent.start();
      this.active.push(agent);
      logger.info(`BypassAgent manually activated: ${name}`);
    } catch (err) {
      logger.warn(`BypassAgent start failed: ${name}`, { error: (err as Error).message });
    }
  }

  /** 手动停用指定Agent（TUI命令用） */
  async deactivateAgent(name: string): Promise<void> {
    const agent = this.registry.get(name);
    if (!agent) return;

    try {
      await agent.stop();
    } catch (err) {
      logger.warn(`BypassAgent stop failed: ${name}`, { error: (err as Error).message });
    }
    this.active = this.active.filter(a => a !== agent);
    logger.info(`BypassAgent deactivated: ${name}`);
  }

  /** 停用所有Agent */
  async deactivateAll(): Promise<void> {
    for (const agent of this.active) {
      try {
        await agent.stop();
      } catch (err) {
        logger.warn(`BypassAgent stop failed: ${agent.name}`, { error: (err as Error).message });
      }
    }
    this.active = [];
  }

  /** 某Agent是否激活 */
  isActive(name: string): boolean {
    return this.active.some(a => a.name === name);
  }

  /** 获取已注册的Agent（用于直接访问Agent特有方法，如 setPendingNarration） */
  getAgent(name: string): BypassAgent | undefined {
    return this.registry.get(name);
  }

  /** 获取激活列表 */
  getActiveNames(): string[] {
    return this.active.map(a => a.name);
  }

  /** 运行时注入：旁路Agent 在 postTurn 中可调用此方法写入纠正内容 */
  private _pendingInjections: import('./types.js').Injection[] = [];

  inject(agentName: string, injection: import('./types.js').Injection): void {
    // 清除同一 agent 的旧注入，只保留最新
    this._pendingInjections = this._pendingInjections.filter(
      ij => ij.section !== injection.section,
    );
    this._pendingInjections.push(injection);
    logger.info(`BypassAgent injected: ${agentName} → ${injection.section}`);
  }

  /** 消费待注入内容（由 Loop 在 compose 前调用） */
  consumeInjections(): import('./types.js').Injection[] {
    const injs = [...this._pendingInjections];
    this._pendingInjections = [];
    return injs;
  }

  // ── preTurn：阻塞，等所有旁路Agent完成 ──────────────────────

  async preTurn(ctx: PreTurnContext): Promise<{
    transformedInput?: string;
    injections: Injection[];
    intent?: { capability: string; confidence: number };
  }> {
    if (this.active.length === 0) {
      return { injections: [] };
    }

    const allInjections: Injection[] = [];
    let transformedInput: string | undefined;
    let intent: { capability: string; confidence: number } | undefined;

    for (const agent of this.active) {
      if (!agent.preTurn) continue;
      try {
        const result = await agent.preTurn(ctx);
        if (result.transformedInput !== undefined) {
          transformedInput = result.transformedInput;
        }
        // orchestrator 是意图的权威来源
        if (agent.name === 'orchestrator' && result.intent) {
          intent = result.intent;
        }
        allInjections.push(...result.injections);
      } catch (err) {
        logger.warn(`BypassAgent preTurn failed: ${agent.name}`, { error: (err as Error).message });
      }
    }

    return { transformedInput, injections: allInjections, intent };
  }

  // ── postTurn：等所有旁路Agent完成后返回 ──────────────────

  async postTurn(ctx: PostTurnContext): Promise<void> {
    if (this.active.length === 0) return;

    await Promise.allSettled(
      this.active.map(async (agent) => {
        if (!agent.postTurn) return;
        try {
          await agent.postTurn(ctx);
        } catch (err) {
          logger.warn(`BypassAgent postTurn failed: ${agent.name}`, { error: (err as Error).message });
        }
      }),
    );
  }
}
