/**
 * runtime-wiring.ts —— 运行时接线抽离（行数收尾第十三批）。
 *
 * 抽离 factory 中「loop 构造后」的三块杂项接线：
 * 1. 回填批（registerLoopBackfill）：kbState/pendingAsyncResults/loopRef 回填 +
 *    scheduler/bundleRegistry/subscribeConfig
 * 2. 渠道注册表（setupChannelRegistries）：__channelLoopRegistry/__channelSessionRegistry
 *    globalThis 单例 + 定时任务降级链路由 resolveChannelLoop
 * 3. 定时任务处理器（installSchedulerHandler）：heartbeatScheduler.setHandler 全量
 *    逻辑（模式隔离/命令式/陪伴广播/降级链）
 * 4. 配置订阅与禁用恢复（restoreDisabledStates + watchModelsConfig）
 * 5. MCP 状态回调 + readTool 图片 handler（wireMiscHandlers）
 *
 * 均为「依赖已就绪、纯接线、无产出」的块 —— 不走 AssemblyRunner（无 needs/
 * provides 拓扑价值），直接函数化 + deps 注入，与 context-sources.ts 同模式。
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import type { MCPSystem } from '../mcp/system.js';
import type { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { Provider } from '../provider/interface.js';
import type { ProviderRouter } from '../provider/router.js';
import type { GitManager } from '../evolution/git-manager.js';
import type { TurnStore } from '../rollback/index.js';
import type { MachineRegistry } from '../machine/index.js';
import type { BypassManager } from '../bypass/manager.js';
import type { ModelsConfig, LocalModelConfig } from '../provider/model-router.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { isCompanionModeActive } from '../context/profiles.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('factory');

// ─── 1. 回填批 ──────────────────────────────────────────────────────

export interface LoopBackfillDeps {
  loop: AgentLoop;
  kbStateRef: { lastQuery: string };
  pendingAsyncResults: Array<{ handle: string; agentName: string; status: 'completed' | 'failed'; result?: string; error?: string }>;
  heartbeatScheduler: HeartbeatScheduler;
}

/** loop 构造后的字段回填（类 3 共享引用接线；bundleRegistry 时序在 runtime 批后，另行 set） */
export function registerLoopBackfill(deps: LoopBackfillDeps): void {
  const { loop, kbStateRef, pendingAsyncResults, heartbeatScheduler } = deps;
  loop.kbState = kbStateRef;
  loop.pendingAsyncResults = pendingAsyncResults; // 异步子Agent结果队列（和 delegateTool 共享引用）
  loop.setScheduler(heartbeatScheduler);
}

// ─── 2. 渠道注册表 ──────────────────────────────────────────────────

export interface ChannelRegistries {
  channelLoops: Map<string, {
    notifyTaskFired(name: string, sessionId?: string): Promise<void>;
    sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
  }>;
  channelSessions: Map<string, () => string>;
}

/** 降级链解析结果 */
export interface ResolvedChannelLoop {
  loop: ChannelRegistries['channelLoops'] extends Map<string, infer V> ? V : never;
  channel: string;
  level: 'primary' | 'fallback' | 'last-resort';
}

/**
 * 渠道 Loop/Session 注册表（globalThis 单例，跨进程共享）。
 * 返回 resolveChannelLoop 供定时任务降级链使用。
 */
export function setupChannelRegistries(
  loop: AgentLoop,
  channel: string | undefined,
  configCenter: RuntimeConfigCenter,
): { registries: ChannelRegistries; resolveChannelLoop: (task: import('../schedule/types.js').ScheduledTask) => ResolvedChannelLoop } {
  // ── 渠道 Loop 注册表（定时任务渠道感知路由） ──
  // 导出为模块级单例，供 feishu-channel 等渠道在 start() 时自行注册
  if (!(globalThis as any).__channelLoopRegistry) {
    (globalThis as any).__channelLoopRegistry = new Map<string, {
      notifyTaskFired(name: string, sessionId?: string): Promise<void>;
      sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
    }>();
  }
  const channelLoops: Map<string, {
    notifyTaskFired(name: string, sessionId?: string): Promise<void>;
    sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
  }> = (globalThis as any).__channelLoopRegistry;

  // ── 渠道 Session 注册表（重启前快照，重启后按渠道恢复） ──
  // 各渠道把「获取自己当前 sessionId 的 getter」注册进来（而非静态值），
  // 这样用户切换 session（switch_session/new_session/load）后 getter 实时反映最新 session，
  // 避免重启时恢复旧 session。RestartTool 重启时调用 getter 序列化快照写入 .restart-session，
  // 重启后 cli 按启动渠道取对应 session，避免多渠道共享进程（TUI + 飞书）时重启串 session。
  // 注意：仅当显式传入 channel 时才注册——http-webhook/tui-ws 等不传 channel 的渠道
  // 不注册，防止它们静默污染 'tui' 键（否则 serve 模式每个 http 请求都会顶掉真实 TUI 会话）。
  if (!(globalThis as any).__channelSessionRegistry) {
    (globalThis as any).__channelSessionRegistry = new Map<string, () => string>();
  }
  const channelSessions: Map<string, () => string> = (globalThis as any).__channelSessionRegistry;
  if (channel) {
    channelSessions.set(channel, () => path.basename((loop as any).sessionDir));
  }

  // 主 loop 注册为 'tui'（TUI 本地模式的默认渠道）
  channelLoops.set('tui', loop);

  /** 按降级链查找第一个在线的渠道 Loop */
  const resolveChannelLoop = (task: import('../schedule/types.js').ScheduledTask): ResolvedChannelLoop => {
    // 1) 首选渠道
    if (task.channel) {
      const l = channelLoops.get(task.channel);
      if (l) return { loop: l, channel: task.channel, level: 'primary' as const };
    }

    // 2) 任务级降级链
    const fallback = task.fallback ?? configCenter.get<string[]>('schedule.channelFallback');
    if (fallback && fallback.length > 0) {
      for (const ch of fallback) {
        const l = channelLoops.get(ch);
        if (l) return { loop: l, channel: ch, level: 'fallback' as const };
      }
    }

    // 3) 最后兜底：飞书（持久消息渠道），再不行才用本地 loop
    const feishuLoop = channelLoops.get('feishu');
    if (feishuLoop) return { loop: feishuLoop, channel: 'feishu', level: 'last-resort' as const };
    return { loop: loop as unknown as ResolvedChannelLoop['loop'], channel: 'tui', level: 'last-resort' as const };
  };

  return { registries: { channelLoops, channelSessions }, resolveChannelLoop };
}

// ─── 3. 定时任务处理器 ──────────────────────────────────────────────

export interface SchedulerHandlerDeps {
  heartbeatScheduler: HeartbeatScheduler;
  loop: AgentLoop;
  channelLoops: ChannelRegistries['channelLoops'];
  resolveChannelLoop: (task: import('../schedule/types.js').ScheduledTask) => ResolvedChannelLoop;
  configCenter: RuntimeConfigCenter;
}

/** 定时任务处理器：任务触发时根据 channel + 降级链路由到对应渠道的 Loop */
export function installSchedulerHandler(deps: SchedulerHandlerDeps): void {
  const { heartbeatScheduler, loop, channelLoops, resolveChannelLoop, configCenter } = deps;
  heartbeatScheduler.setHandler(async (task) => {
    logger.info(`Scheduled task fired: ${task.name}`, { id: task.id, type: task.action.type, channel: task.channel });

    // 模式隔离：跳过不属于当前模式的任务
    if (task.mode) {
      const currentMode = isCompanionModeActive() ? 'companion' : 'normal';
      if (task.mode !== currentMode) {
        logger.info(`Task "${task.name}" skipped: mode "${task.mode}" ≠ current "${currentMode}"`);
        return;
      }
    }

    if (task.action.type === 'command') {
      // 命令式任务 — 不需要渠道，直接执行 shell 命令
      // 安全归因（kernel/security）：任务命令由 LLM 经 add_task 写入，
      // 执行期标记 schedule 归因 → 内核硬拒绝清单/env 守卫按 LLM 驱动裁决
      const { exec } = await import('node:child_process');
      const { runAttributed } = await import('../kernel/security/index.js');
      await runAttributed({ kind: 'schedule', name: task.name }, async () => {
        exec(task.action.target, { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) logger.error(`Task command failed: ${task.name}`, err, { stderr: stderr.trim() });
          else logger.info(`Task command OK: ${task.name}`, { stdout: stdout.trim() });
        });
      });
      return;
    }

    // 陪伴模式：广播到所有活跃渠道（TUI + 飞书共享同一对话）
    if (task.mode === 'companion') {
      const feishuEntry = channelLoops.get('feishu');
      const collectedTexts: string[] = [];

      // 在 TUI loop 上运行 Agent，同时收集输出用于飞书推送
      const originalHandler = (loop as any).outputHandler;
      if (originalHandler) {
        const dualHandler = {
          ...originalHandler,
          onText: (text: string) => {
            collectedTexts.push(text);
            originalHandler.onText?.(text);
          },
        };
        (loop as any).outputHandler = dualHandler;
      }

      try {
        await loop.notifyTaskFired(task.name);
      } finally {
        if (originalHandler) {
          (loop as any).outputHandler = originalHandler;
        }
      }

      // 将 Agent 回复推送到飞书
      if (feishuEntry?.sendProactiveMessage && collectedTexts.length > 0) {
        const response = collectedTexts.join('').trim();
        if (response) {
          const feishuSessionId = (task as any).sessionId as string | undefined;
          await feishuEntry.sendProactiveMessage(feishuSessionId ?? '', response).catch((err: Error) =>
            logger.error(`Companion task feishu push failed: ${task.name}`, err)
          );
        }
      }
      return;
    }

    // AI 交互式任务 — 按降级链查找可用渠道
    const { loop: targetEntry, channel: usedChannel, level } = resolveChannelLoop(task);
    if (level === 'fallback') {
      logger.warn(`Task "${task.name}" channel "${task.channel}" offline, downgraded to "${usedChannel}"`, { taskId: task.id });
    } else if (level === 'last-resort' && task.channel) {
      logger.warn(`Task "${task.name}" channel "${task.channel}" and all fallbacks offline, last-resort to "${usedChannel}"`, { taskId: task.id });
    }

    // 非 TUI 渠道（飞书等）：主动推送模式
    // handleTaskNotification 内部会运行 Agent、收集输出、发送到飞书聊天
    const sessionId = (task as any).sessionId as string | undefined;
    const entry = targetEntry as { notifyTaskFired: Function; sendProactiveMessage?: Function };
    if (entry.sendProactiveMessage && usedChannel !== 'tui') {
      await entry.notifyTaskFired(task.name, sessionId);
    } else {
      entry.notifyTaskFired(task.name).catch((err: Error) =>
        logger.error(`Task notify failed (channel: ${usedChannel}): ${task.name}`, err)
      );
    }
  });
}

// ─── 4. 配置订阅 + 禁用状态恢复 ─────────────────────────────────────

export interface ConfigWiringDeps {
  loop: AgentLoop;
  configCenter: RuntimeConfigCenter;
  modelRouter: ModelRouter;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
}

/** 订阅 models.* 与 local.* 配置变更热重载 ModelRouter + 恢复持久化的 disabled 状态 */
export function wireConfigSubscriptions(deps: ConfigWiringDeps): void {
  const { loop, configCenter, modelRouter, toolRegistry, skillRegistry, agentRegistry } = deps;

  // 订阅 RuntimeConfigCenter 变更，让 update_config 即时生效
  loop.subscribeConfig();

  // 订阅 models.* 和 local.* 配置变更，热重载 ModelRouter
  configCenter.watch('models.*', () => {
    const newModels = configCenter.get('models') as unknown as ModelsConfig | undefined;
    const newLocal = configCenter.get('local') as unknown as LocalModelConfig | undefined;
    if (newModels) {
      modelRouter.setConfig(newModels, newLocal);
    }
  });
  configCenter.watch('local.*', () => {
    const newModels = configCenter.get('models') as unknown as ModelsConfig | undefined;
    const newLocal = configCenter.get('local') as unknown as LocalModelConfig | undefined;
    if (newModels) {
      modelRouter.setConfig(newModels, newLocal);
    }
  });

  // ── Restore persisted disabled states from configCenter ──
  const persistedDisabledTools = configCenter.get('tools.disabled') as unknown as string[] | undefined;
  if (Array.isArray(persistedDisabledTools)) {
    for (const name of persistedDisabledTools) {
      toolRegistry.disableTool(name);
    }
  }

  const persistedDisabledSkills = configCenter.get('skills.disabled') as unknown as string[] | undefined;
  if (Array.isArray(persistedDisabledSkills)) {
    for (const name of persistedDisabledSkills) {
      skillRegistry.disableSkill(name);
    }
  }

  const persistedDisabledAgents = configCenter.get('agents.disabled') as unknown as string[] | undefined;
  if (Array.isArray(persistedDisabledAgents)) {
    for (const name of persistedDisabledAgents) {
      agentRegistry.disableAgent(name);
    }
  }
}

// ─── 5. 杂项 handler ────────────────────────────────────────────────

/** MCP 状态变更回调（Zone 5 runtime:mcp_status 自动注入，此处仅日志） */
export function wireMcpStatusCallback(mcpSystem: MCPSystem): void {
  mcpSystem.onStatusChange(({ type, name, tools }) => {
    logger.info(`MCP status: ${type}`, { name, tools: tools?.join(',') });
  });
}

/** Read 工具的图片处理器 — 将读到的图片注入 ImageStore */
export function wireReadToolImageHandler(toolRegistry: ToolRegistry, loop: AgentLoop): void {
  const readTool = toolRegistry.get('read');
  if (readTool && typeof (readTool as any).setImageHandler === 'function') {
    (readTool as any).setImageHandler({
      store: (base64: string, mime: string, sourcePath: string) =>
        loop.imageStore.store(base64, mime, sourcePath),
      inject: (imgId: string, data: string, mediaType: string) => {
        loop.pendingImageInjections.push({ imgId, data, media_type: mediaType });
      },
    });
  }
}

// ─── 6. Fallback 通知接线 ───────────────────────────────────────────

export interface FallbackWiringDeps {
  /** 主 Provider（可能是带降级链的 FallbackChain） */
  provider: Provider;
  configCenter: RuntimeConfigCenter;
  /**
   * loopRef 容器：声明期 loop 未建，回调运行时取当前值（懒求值语义）。
   * 传入 `{ current: AgentLoop | null }`，factory 在 loop 构造后回填。
   */
  loopRefBox: { current: AgentLoop | null };
}

/**
 * Fallback 上下文自适应接线：降级链切换/恢复 Provider 时
 * 自动更新 session.maxContext 并写入一次性通知（pendingFallbackInfo/pendingRecoverInfo）。
 */
export function wireFallbackNotifications(deps: FallbackWiringDeps): void {
  const { provider, configCenter, loopRefBox } = deps;
  const fallbackChain = provider as {
    setOnFallback?: (cb: (from: unknown, to: unknown, err: Error) => void) => void;
    setOnRecover?: (cb: (prov: unknown) => void) => void;
  };
  if (fallbackChain.setOnFallback) {
    // 去重：一次 createStream 内可能多次 onFallback（primary→本地→候选），
    // 只有降级目标「真正变化」时才写一次性通知，避免每轮刷屏。
    let lastFrom = '';
    let lastTo = '';
    fallbackChain.setOnFallback((from, to) => {
      const fromP = from as { getProviderType(): string; getModel(): string };
      const toProvider = to as { getProviderType(): string; getModel(): string };
      const newLimit = getModelContextWindow(
        toProvider.getProviderType() as import('../types.js').ProviderType,
        toProvider.getModel(),
      );
      const current = configCenter.get<number>('session.maxContext') ?? 200000;
      if (newLimit !== current) {
        configCenter.set('session.maxContext', newLimit);
        logger.info(
          `Fallback context adapted: ${current.toLocaleString()} → ${newLimit.toLocaleString()} (${toProvider.getProviderType()}/${toProvider.getModel()})`,
        );
      }
      // 一次性通知：下一次 runTurn 消费（同 from→to 组合只提示一次）
      if (loopRefBox.current) {
        const fromKey = `${fromP.getProviderType()}/${fromP.getModel()}`;
        const toKey = `${toProvider.getProviderType()}/${toProvider.getModel()}`;
        if (fromKey !== lastFrom || toKey !== lastTo) {
          lastFrom = fromKey;
          lastTo = toKey;
          loopRefBox.current.pendingFallbackInfo = `[Fallback] "${fromP.getProviderType()}" unavailable — using "${toProvider.getProviderType()}". Check API key or quota.`;
        }
      }
    });
  }
  // ── 降级链恢复主 Provider 时，把 maxContext 恢复为主 provider 的窗口 ──
  if (fallbackChain.setOnRecover) {
    fallbackChain.setOnRecover((prov) => {
      const recovered = prov as { getProviderType(): string; getModel(): string };
      const newLimit = getModelContextWindow(
        recovered.getProviderType() as import('../types.js').ProviderType,
        recovered.getModel(),
      );
      const current = configCenter.get<number>('session.maxContext') ?? 200000;
      if (newLimit !== current) {
        configCenter.set('session.maxContext', newLimit);
        logger.info(
          `Fallback recovered — context restored: ${current.toLocaleString()} → ${newLimit.toLocaleString()} (${recovered.getProviderType()}/${recovered.getModel()})`,
        );
      }
      // 一次性通知：下一次 runTurn 消费
      if (loopRefBox.current) {
        loopRefBox.current.pendingRecoverInfo = `[Recovered] "${recovered.getProviderType()}" is back online — restored primary provider.`;
      }
    });
  }
}
