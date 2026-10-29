/**
 * agent-assembly.ts —— Agent 装配主体（行数收尾第十九批：factory 薄壳化）。
 *
 * factory.ts 的编排主体整体迁入本文件：类型（CreateAgentOptions /
 * AgentComponents）与 createAgent 装配函数。factory.ts 退化为薄壳
 * （re-export 类型 + 委托 createAgent），保持对外 API 不变。
 *
 * ## 组件装配原则
 *
 * 如果你要新增系统级组件（如新的 ContextSource、Tool、Flow）：
 *   1. 新建装配贡献（*-contributions.ts，needs/provides 声明）或在本文件接线
 *   2. 在此文件中注册 Tool 到 toolRegistry / Flow 到 flowRegistry
 *   3. 不要在其他地方分散注册——保持单一装配点
 *
 * 提示词、配置均通过外部化体系加载（loadPrompt / RuntimeConfigCenter），
 * 不要在装配中硬编码任何面向模型或用户的文本内容。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionManager } from '../memory/session.js';
import { CompanionSessionManager } from '../memory/companion-session.js';
import { createDefaultRegistry, createBuiltInTools, BashTool } from '../tools/index.js';
import { deriveDangerousTools } from '../tools/side-effect.js';
import { applyWorkspaceFence } from '../tools/path-sandbox.js';
import { scratchpadPath } from '../utils/scratchpad.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { registerBundleTools } from '../tools/bundle-tools.js';
import type { GitManager } from '../evolution/git-manager.js';
import { wireAutoGit } from '../evolution/auto-git.js';
import { createBuiltinSkills } from '../skills/index.js';
import type { SkillRegistry, SkillTool } from '../skills/index.js';
import { DelegateToAgentTool, loadAgentConfigs } from '../agents/index.js';
import type { AgentRegistry } from '../agents/index.js';
import type { MCPSystem } from '../mcp/index.js';
import type { LifecycleSupervisor } from '../supervisor/shutdown.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import type { CompressorOrchestrator } from '../context/compressor.js';
import type { LLMOrchestrator } from '../orchestrator/planner.js';
import type { PlanStore } from '../orchestrator/plan-store.js';
import type { ConversationStore } from '../memory/conversation.js';
import type { EventStore } from '../memory/events.js';
import type { StatsManager } from '../memory/stats.js';
import type { SummaryStore } from '../memory/summary.js';
import type { MemoryStore } from '../memory/memory-store.js';
import { AgentLoop } from '../orchestrator/loop.js';
import type { Pipeline } from '../kernel/pipeline.js';
import type { KnowledgeApi } from '../plugins/knowledge-plugin.js';
import { initDependencyAnalyzer } from '../dependency/index.js';
import type { Provider } from '../provider/interface.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import type { OutputHandler } from '../orchestrator/loop.js';
import type { ConfigManager } from '../setup/config.js';
import { createLogger } from '../logging/logger.js';
import {
  initToolLinksFromDisk,
  setToolLinkRuntime,
  TOOL_LINK_EXTRA_EVENT_SOURCES,
  toolLinksPath,
} from '../utils/tool-links.js';
// ── 自动化链路（AutomationRule，2026-10-30）──
// 定位：tool-links 是框架内部工具旁路（append 类），automation 是用户/模型定义的
// 完整链路（invoke/wake/gate/safety，可多步可分支）。两者共用 TriggerHub 派发。
import { getCurrentAutomationRules, initAutomationsFromDisk, saveAutomationRules } from '../automation/store.js';
import { dispatchAutomationEvent, getAutomationRuntime, setAutomationRuntime } from '../automation/service.js';
import type { AutomationRuntimeDeps } from '../automation/service.js';
import type { ValidationContext } from '../automation/validate.js';
import { armProbeRules, disarmWatchIds } from '../automation/sources.js';
import { createAutomationTools } from '../automation/tools.js';
import { createWakeSession } from '../automation/wake-adapter.js';
import { getWatchService } from '../watch/service-instance.js';
import { getSchedulerSessionPort } from '../schedule/session-port.js';
import { ensureGlobalTriggerHub } from '../trigger/hub.js';
import { buildCoreToolLinkRegistry } from '../orchestrator/tool-link-handlers.js';
import { LOOP_HOOK_NAMES } from '../orchestrator/loop-hooks.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { HotReloadManager } from '../hot-reload/index.js';
import { AssemblyRegistry } from '../supervisor/assembly-registry.js';
import { ExtensionRegistry } from '../supervisor/extension-registry.js';
import { createArchRegistries, applyProviderReplacement, applyRouterReplacements, applyAgentReplacements, applySourceReplacements, applySlotReplacements, applyServiceReplacements, createManifestAccess, recordBuiltinBaselines, type PipelineSlotDecl } from './arch-assembly.js';
import type { ProviderConfigLoader } from '../provider/config.js';
import { getProviderConfigLoader } from '../provider/config.js';
import { ProviderManager } from '../provider/manager.js';
import { modelCatalog } from '../provider/catalog.js';
import type { TurnRecorder, TurnStore } from '../rollback/index.js';
import type { MachineRegistry } from '../machine/index.js';
import type { BackgroundProcessRegistry } from '../tools/background-registry.js';
import { createProcessListTool, createProcessKillTool, createProcessOutputTool } from '../tools/process-tools.js';
import { createSystemInfoTool } from '../tools/system-info.js';
import { createChannelInfoTool, setChannelsInfo } from '../tools/channel-info.js';
import type { ChannelsInfo } from '../env/index.js';
import { collectSystemInfoAsync } from '../env/index.js';
import { CommandRegistry } from '../ui/command-registry.js';

import { runBaseContributions } from './base-contributions.js';
import { runContextChainContributions } from './context-chain-contributions.js';
import { runOrchestratorContributions } from './orchestrator-contributions.js';
import { runInfraContributions } from './infra-contributions.js';
import { runChannelContributions } from './channel-contributions.js';
import { runPluginManagerContribution } from './plugin-manager-contribution.js';
import { boot } from './boot.js';
import { wireConfigCenter } from './config-wiring.js';
import { bootstrapPersona, restoreFlowState, initModelCatalog } from './bootstrap-wiring.js';
import { registerLoopDependentTools } from './tool-registration.js';
import {
  registerLoopBackfill,
  setupChannelRegistries,
  installSchedulerHandler,
  wireConfigSubscriptions,
  wireMcpStatusCallback,
  wireReadToolImageHandler,
  wireFallbackNotifications,
} from './runtime-wiring.js';
import { mountBypassPlugins } from './bypass-wiring.js';
import { createContextModeService } from './context-mode-service.js';
import { createWorldEngineFactory } from './world-engine-service.js';
import { createPlanExecuteTool } from '../tools/plan-execute/index.js';
import { runCoreContributions } from './core-contributions.js';
import { registerContextSources } from './context-sources.js';
import { runPluginContributions } from './plugin-contributions.js';
import { runRuntimeContributions } from './runtime-contributions.js';

const logger = createLogger('factory');

// ─── Types ───────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────

export interface CreateAgentOptions {
  cwd: string;
  provider: Provider;
  maxTurns: number;
  maxContext: number;
  outputHandler: OutputHandler;
  /** 恢复指定 session */
  sessionId?: string;
  /** 继续最近的 session */
  shouldContinue?: boolean;
  /** 每个 session 的最大消息数 */
  maxMessages?: number;
  /** Persona 文件目录 */
  personaDir?: string;
  /** 本地模型 Provider（用于压缩通道，不影响主对话） */
  localModelProvider?: Provider;
  /** 渠道信息（注入到 System Prompt 的 environment section） */
  channelsInfo?: ChannelsInfo[];
  /** 创建此 Agent 的渠道标识（'webui' | 'tui' | 'feishu' | 'http-webhook' 等） */
  channel?: string;
  /** 外部注入的 SessionManager（避免多实例） */
  sessionManager?: SessionManager;
  /** 懒登记会话（见 AgentFactory.createAgent.lazySession）：只记 id 与路径，不建目录不写文件 */
  lazySession?: boolean;
}

// ─── Factory ─────────────────────────────────────────────────────────

export interface AgentComponents {
  loop: AgentLoop;
  sessionDir: string;
  sessionManager: SessionManager;
  toolRegistry: ReturnType<typeof createDefaultRegistry>;
  bundleRegistry: ToolBundleRegistry;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  dependencyAnalyzer?: DependencyAnalyzer;
  contextComposer: LayeredContextComposer;
  mcpSystem: MCPSystem;
  hotReloadManager: HotReloadManager;
  modelRouter: ModelRouter;
  providerConfigLoader: ProviderConfigLoader;
  /** 知识库引擎实例（knowledge 插件挂载失败时可能为 null —— 功能层 error 降级不阻断启动） */
  knowledgeBase: KnowledgeBase | null;
  /** 知识库最近查询（loop/stages 与上层共享同一引用） */
  kbState: { lastQuery: string };
  companionSessionManager: CompanionSessionManager;
  backgroundRegistry: BackgroundProcessRegistry;
  scheduler: HeartbeatScheduler;
  /** 目录插件管理器（getAll/activate/deactivate/reloadFromDisk）。内核插件挂载
   *  状态走 loop.pluginHost（plugin.list），两者在 plugin 契约域分列。 */
  pluginManager: import('../plugins/manager.js').PluginManager;
  /** 架构监督（扩展注册表方案）：本体注册表（出厂图只读视图）+ 扩展注册表（名单+生效视图） */
  assemblyRegistry?: AssemblyRegistry;
  extensionRegistry?: ExtensionRegistry;
  /** 渠道 Loop 注册表 — 供渠道注册自己的 loop，定时任务据此路由
   *  key: channel name (e.g. "tui", "feishu")
   *  对于多会话渠道（飞书等），notifyTaskFired 需要同时传入 sessionId */
  channelLoops: Map<string, {
    notifyTaskFired(name: string, sessionId?: string): Promise<void>;
    /** 渠道主动推送消息（非回复模式），飞书等渠道用此方法发送定时任务结果 */
    sendProactiveMessage?(sessionId: string, text: string): Promise<void>;
  }>;
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 进程级 guard：automation 只装配一次。
 *
 * ⚠️ `createAgentAssembly` 是**每个会话**调用一次。若不 guard：
 *   · 每个会话都会 `hub.registerSink(...)` ⇒ 同一事件触发 N 次（N=会话数）
 *   · 每个会话都会 arm 一遍 watcher ⇒ 监控项重复
 * 规则表与运行时都是进程级单例，装配理应只做一次。
 */
let automationWired = false;

export async function createAgentAssembly(
  options: CreateAgentOptions,
  supervisor?: LifecycleSupervisor,
): Promise<AgentComponents> {
  const { cwd, provider, maxTurns, maxContext, outputHandler, sessionId, shouldContinue, maxMessages = 10000, personaDir, localModelProvider, channelsInfo } = options;

  // ── 启动引导（行数收尾第十一批：config 加载 + 会话恢复三分支迁入 boot.ts）──
  const {
    configManager, config, defaultMode,
    sessionManager, sessionDir, currentSessionId, sessionType,
  } = await boot({
    cwd,
    sessionId,
    shouldContinue,
    channel: options.channel,
    sessionManager: options.sessionManager,
    lazySession: options.lazySession,
  });

  // ── P-A 基础贡献批（行数收尾：gitManager/turnStore/turnRecorder/flowRegistry）──
  // ConfigManager/SessionManager 因 config.load() 与 session 恢复逻辑深度接线，留 factory。
  const rollbackDir = path.join(os.homedir(), '.agent', 'rollback');
  const baseResults = await runBaseContributions({ cwd, rollbackDir });
  const gitManager = baseResults.get('gitManager') as GitManager;
  const turnStore = baseResults.get('turnStore') as TurnStore;
  const turnRecorder = baseResults.get('turnRecorder') as TurnRecorder;
  const flowRegistry = baseResults.get('flowRegistry') as MachineRegistry;

  // ── persona 引导 + Prompt 同步 + Flow 持久化恢复（行数收尾第十七批：bootstrap-wiring.ts）──
  const effectivePersonaDir = await bootstrapPersona(personaDir, cwd);
  await restoreFlowState(flowRegistry, sessionDir);

  // ── Provider Config Loader（时序锚：必须在 getDefaultConfig 之前，确保 providerDefault 读到 JSON）──
  const providerConfigLoader = getProviderConfigLoader(cwd);
  await providerConfigLoader.load();

  // ── 配置中心引导（行数收尾第十六批：RuntimeConfigCenter + inject×5 + 日志同步迁入 config-wiring.ts）──
  const { configCenter, effectiveMaxTurns, effectiveMaxContext } = wireConfigCenter({
    configManager,
    config,
    maxTurns,
    maxContext,
  });

  // ── Model Catalog 初始化 + maxContext 兜底（行数收尾第十七批：bootstrap-wiring.ts）──
  initModelCatalog({ cwd, provider, configCenter });

  // ── Fallback 上下文自适应接线（行数收尾第十五批：抽离 runtime-wiring.ts）──
  // loopRefBox：声明期 loop 未建，回调运行时取当前值（懒求值语义），loop 构造后回填。
  const loopRefBox: { current: AgentLoop | null } = { current: null };
  wireFallbackNotifications({ provider, configCenter, loopRefBox });

  // ── 环境信息（异步并行采集：不阻塞启动；首次 compose 时经 ContextSource await 消费） ──
  const envInfo = collectSystemInfoAsync();

  // 初始化渠道信息缓存（供 channel_info 工具查询）
  setChannelsInfo(channelsInfo ?? []);

  // ── 渠道上下文（ContextSource 注册已抽离至 context-sources.ts） ────
  const currentChannel = options.channel;

  // ── Flow 注入 / Memory / 陪伴 Memory / session-tools ContextSource 已抽离 ──
  const memoryFilePath = config.memoryFile ?? path.join(os.homedir(), '.agent', 'prompts', 'persona', 'memory.md');
  const memoryDir = path.dirname(memoryFilePath);
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  // ── 基础设施贡献批（行数收尾第八批：memoryStore/heartbeatScheduler/mcpSystem）──
  const persistedSchedule = configCenter.get('schedule') as Record<string, unknown> | undefined;
  const scheduleConfig = persistedSchedule ?? config.schedule;
  // initializeIfNeeded / start / registerTo* 属接线，解构后原位保留。
  const infraResults = await runInfraContributions({
    memoryFilePath,
    scheduleConfig: scheduleConfig as Record<string, unknown> | undefined,
    configCenter,
    cwd,
  });
  const memoryStore = infraResults.get('memoryStore') as MemoryStore;
  memoryStore.initializeIfNeeded();
  const heartbeatScheduler = infraResults.get('heartbeatScheduler') as HeartbeatScheduler;

  // ── MCP 系统（来自基础设施批；start 与依赖分析并行） ──────────────
  const mcpSystem = infraResults.get('mcpSystem') as MCPSystem;

  // ── 通道贡献批（行数收尾第九批：channelRegistry/角色通道/modelRouter）──
  // 角色通道创建（独立 userId KVCache 隔离）随批外移；subProvider* 与
  // bypassProvider 经返回值传出供后续接线消费。通道创建失败降级在批内保留。
  const {
    channelRegistry,
    modelRouter,
  } = await runChannelContributions({ cwd, config, provider });

  // ── 架构监督（扩展注册表方案阶段 4）：本体/扩展注册表 ──
  const pipelineSlots = (configCenter.get<PipelineSlotDecl[]>('kernel.pipeline') ?? []).map(
    (slot) => ({ id: slot.id, impl: slot.impl }),
  );
  const { assemblyRegistry, extensionRegistry } = createArchRegistries({ cwd, pipeline: pipelineSlots });
  // provider:main / router 分发表已后移至插件架构提交（runPluginManagerContribution）之后：
  // 两者消费 getResolvedReplacements()（遍历 pluginArchs），必须在插件申报 architecture 后调用，
  // 否则插件声明的 provider:main / router 替换会被静默丢弃。
  const manifestAccess = createManifestAccess(cwd);
  // ── 压缩链贡献批（行数收尾第六批：contextComposer/tokenCounter/summarizer/compressor）──
  const chainResults = await runContextChainContributions({
    effectiveMaxContext,
    modelRouter,
    compressThreshold: config.context?.compressThreshold,
    compressDepth: config.context?.compressDepth,
  });
  const contextComposer = chainResults.get('contextComposer') as LayeredContextComposer;
  const compressor = chainResults.get('compressor') as CompressorOrchestrator;
  const toolRegistry = createBuiltInTools(gitManager, currentSessionId, cwd, undefined, options.channel);
  // ── 安全：主 Agent 工作区围栏（kernel/security P0）——写类工具限工作区、.git 拒写 ──
  // 旧实现 createBuiltInTools 第 4 参传 undefined，path-sandbox 从未对主 Agent 生效。
  const securityWorkspaceRoot = (config as { security?: { workspaceRoot?: string } }).security?.workspaceRoot ?? cwd;
  // 额外可写根：agent 自维护区（与 memory.md 同目录的 persona 目录；Zone 5 临时记事本也在此）
  // —— 目录由 scratchpadPath() 推导（不写死字符串 ✓），且只放行这一个目录 ✓
  // 会话级记事本在 <sessionDir>/scratchpad.md ⇒ 把 sessionDir 也放行（否则 edit 写不进会话记事本）
const extraWritableRoots = [path.dirname(scratchpadPath()), sessionDir];
  // ── 权限统一（2026-10-13）：越界写入 = 「可确认」而非「不可能」──
  // 同一个 Set 交给两边：围栏读（决定放行）、loop 权限层写（用户点 yes/always 后记录）。
  // 缺了任何一边 ⇒ 要么越界永远写不进去，要么确认后仍被拒（静默不一致）。
  const approvedWriteRoots = new Set<string>();
  applyWorkspaceFence(toolRegistry, securityWorkspaceRoot, extraWritableRoots, approvedWriteRoots);
  // ── 编排贡献批（行数收尾第七批：planStore/orchestrator/providerRouter/
  // agentRegistry/toolExecutor/backgroundRegistry）——在 toolRegistry 建后执行。
  const orchResults = await runOrchestratorContributions({
    provider,
    localModelProvider,
    sessionDir,
    modelRouter,
    toolRegistry,
  });
  const toolExecutor = orchResults.get('toolExecutor') as ToolExecutor;
  const backgroundRegistry = orchResults.get('backgroundRegistry') as BackgroundProcessRegistry;

  // ── 预测式批量执行工具（plan_execute）：注入 ToolExecutor 执行子命令 ──
  // 规划 + 结构化断言门控：命中预测自动推进，落空交回主循环。
  // onHandoff → 循环级验证门（repair.verification）消费：预测落空后禁止直接结束。
  const planHandoff = { pending: null as string | null };
  // allow 在 AgentLoop 创建后才能绑定（内层工具准入需要读 loop 的 goal/工具包状态）；
  // 工具对象持有同一 options 引用，执行时现取，故先注册、后赋值即可。
  const planExecOpts: {
    onHandoff: (reason: string) => void;
    allow?: (name: string) => boolean;
  } = {
    onHandoff: (reason) => { planHandoff.pending = reason; },
  };
  toolRegistry.register(createPlanExecuteTool(toolExecutor, planExecOpts));

  // 注入 BashTool（使其支持 async: true 模式）
  const bashTool = toolRegistry.get('bash');
  bashTool?.setBackgroundRegistry?.(backgroundRegistry);

  // tools.allowAsync 配置（默认 true，可设为 false 禁止异步模式）
  const allowAsync = configCenter.get<boolean | undefined>('tools.allowAsync');
  if (allowAsync === false && bashTool instanceof BashTool) {
    bashTool.setAllowAsync(false);
  }

  // 注册后台进程管理工具
  toolRegistry.register(createProcessListTool(backgroundRegistry));
  toolRegistry.register(createProcessKillTool(backgroundRegistry));
  toolRegistry.register(createProcessOutputTool(backgroundRegistry));
  // 环境信息按需查询工具（替代 Zone 1 静态注入）
  toolRegistry.register(createSystemInfoTool());
  toolRegistry.register(createChannelInfoTool());

  // ── 核心服务贡献批（行数收尾第三批 · P-B 第一小批）──
  // stores ×4 + skillRegistry + skillTool：创建集中、无接线交织，经 AssemblyRunner
  // 装配（AgentLoop 构造前）。白名单随迁出逐条下降。
  const coreResults = await runCoreContributions({ maxMessages });
  const conversationStore = coreResults.get('conversationStore') as ConversationStore;
  const eventStore = coreResults.get('eventStore') as EventStore;
  const statsManager = coreResults.get('statsManager') as StatsManager;
  const summaryStore = coreResults.get('summaryStore') as SummaryStore;
  const skillRegistry = coreResults.get('skillRegistry') as SkillRegistry;
  const skillTool = coreResults.get('skillTool') as SkillTool;

  // ── Skill 系统（注册内置技能 + 注册工具，属接线，留在 factory）──
  for (const skill of createBuiltinSkills()) {
    skillRegistry.registerBuiltin(skill);
  }
  toolRegistry.register(skillTool);

  // ── MCP 启动：**后台跑，不挡装配** ✓（2026-09-20 实测修正 ✗→✓）────────────────
  // 为什么要改：原先这里是 `await Promise.all([mcpSystem.start(), …])`，
  // 而 `start()` 要逐个 spawn MCP 子进程（npx 冷启动数秒，握手超时上限 30s ✗）⇒
  // **整套会话装配被它拖住**，连带网页版首个连接（实测「连接中…」→「在线」要 4s+；
  // 进程风暴时直接卡死 ✗）。而 MCP 是**可选**工具系统，**不该挡住主界面** ✗。
  //
  // 为什么这样改是安全的（两处前提已核实 ✓）：
  //   ① 工具是**每回合现查**的 —— orchestrator/stages/context.ts 里
  //      `toolRegistry.getToolDefinitions(...)` 在每回合的 context 阶段调用
  //      ⇒ 晚注册的工具**照样能被看见** ✓（不是装配时快照 ✗）
  //   ② `bridge.registerToRegistry` **幂等且可重入**（内部先清旧注册再重注册 ✓）
  //      ⇒ 先挂注册面、连接完成后再补注册，不会重复注册 ✓
  //
  // 顺序：**先同步挂注册面**（零等待）⇒ 再后台启动 ⇒ 启动完成后补一次
  // 「依赖连接态」的注册（ContextSource 与 supervisor 都需要 managers 已存在 ✓）
  mcpSystem.registerToToolRegistry(toolRegistry);
  void mcpSystem
    .start()
    .then(() => {
      mcpSystem.registerToContextComposer(contextComposer);
      if (supervisor) {
        mcpSystem.registerToLifecycleSupervisor(supervisor);
      }
    })
    .catch((err: unknown) => {
      // MCP 起不来**不影响会话可用**（只是少了那批 MCP 工具）⇒ 只记日志，不抛 ✓
      // ⚠️ 注意：插件声明的 MCP（plugins/manager.ts 的 connectPluginMcpServers）走
      //    addExternalServers ⇒ 逐个 addServer，**不依赖 start() 已完成** ✓
      //    （JS 单线程 ⇒ 与 start() 并发也只是各自 push，互不破坏 ✓；
      //      唯一旧有隐患是"同一 server 被声明两次" ⇒ 与本次改动无关 ✓）
      console.warn(
        '[assembly] MCP 后台启动失败（会话仍可用，仅缺 MCP 工具）：',
        err instanceof Error ? err.message : String(err),
      );
    });

  // 调度器启动 + 依赖分析仍按原样并行等待（都快 ✓）
  const [, dependencyAnalyzer] = await Promise.all([
    heartbeatScheduler.start(),
    initDependencyAnalyzer(cwd),
  ] as const);

  // ── 插件系统（P6 收尾：PluginManager 创建经贡献批；依赖 MCP 就绪）──
  // loadAll 移至 loop 创建后：目录插件挂主循环钩子需要 loopHooks 总线（见下）
  const { pluginManager } = await runPluginManagerContribution({
    toolRegistry,
    skillRegistry,
    contextComposer,
    mcpSystem,
    cwd,
    extensionRegistry,
  });

  // ── 分发表（阶段 4.2）：provider:main / router 面 ──
  // 时序锚：必须在插件架构提交（上一步 runPluginManagerContribution 内 reportArchitecture）
  // 之后、AgentLoop 构造之前调用 —— 让插件声明的 provider:main / router 也能被裁决生效。
  await applyProviderReplacement({ cwd, extensionRegistry, channelRegistry });
  await applyRouterReplacements({ cwd, extensionRegistry });

  // ── 编排器 + Provider 路由（来自编排贡献批）───────────────────────
  const planStore = orchResults.get('planStore') as PlanStore;
  const orchestrator = orchResults.get('orchestrator') as LLMOrchestrator;
  const providerRouter = orchResults.get('providerRouter') as ProviderRouter;

  // ── 子 Agent 工具（agentRegistry 来自编排贡献批；subProvider* 来自通道批）──
  // loadAgentConfigs + register 循环属接线（config 驱动），留 factory。
  const agentRegistry = orchResults.get('agentRegistry') as AgentRegistry;
  const agents = await loadAgentConfigs(cwd, config.agents);
  for (const agent of agents) {
    agentRegistry.register(agent);
  }
  // ── 分发表：agent 面（子 Agent 名单替换，内置 config 装载后应用） ──
  await applyAgentReplacements({ cwd, extensionRegistry, agentRegistry });
  // 异步子Agent 结果队列——先创建引用，后续赋给 loop
  const pendingAsyncResults: Array<{ handle: string; agentName: string; status: 'completed' | 'failed'; result?: string; error?: string }> = [];

  const delegateTool = new DelegateToAgentTool(agentRegistry, {
    modelRouter,
    toolRegistry,
    sessionDir,
    maxContextTokens: maxContext,
    dependencyAnalyzer,
    pendingAsyncResults,
    // 子 Agent 的独立 LLM 访问：走角色表现建 scoped 实例（sub-{name}-{instanceId}
    // KVCache 隔离），通道配置由 model-channels.json 的 sub-agent 角色统一管理
    createSubProvider: (userId: string) => {
      const scoped = modelRouter.createScopedProvider('sub-agent', userId);
      if (!scoped) throw new Error('Cannot create sub-agent provider: channel "sub-agent" unavailable.');
      return scoped;
    },
  });
  toolRegistry.register(delegateTool);

  // ── Command Registry（斜杠命令外部配置化，支持模型修改 + 热重载） ──
  CommandRegistry.getInstance(cwd);

  // ── AgentLoop（P6-2：服务表 + 配置两层，构造签名不再逐字段列举）────
  const loop = new AgentLoop({
    provider,
    contextComposer,
    compressor,
    orchestrator,
    toolExecutor,
    toolRegistry,
    conversationStore,
    eventStore,
    statsManager,
    summaryStore,
    outputHandler,
    skillRegistry,
    mcpBridge: mcpSystem.getBridge(),
    dependencyAnalyzer,
    agentRegistry,
    flowRegistry,
    providerRouter,
    configCenter,
    modelRouter,
    turnRecorder,
  }, {
    sessionDir,
    maxTurns: effectiveMaxTurns,
    // 与 maxTurns 同源：都取 configCenter 解析后的有效值（2026-10-13「统一分母」）。
    // 此前这里用原始 options.maxContext，而上一行 maxTurns 用 effectiveMaxTurns ——
    // 同一份配置两个取法，构造期就埋下分母分叉（loop 内部还另有每轮兜底同步）。
    maxContextTokens: effectiveMaxContext,
    personaDir: effectivePersonaDir,
    dangerousTools: new Set(deriveDangerousTools(() => toolRegistry.getAll())),
    allowlistTools: new Set(),
    // ── 权限统一（2026-10-13）：与上方 applyWorkspaceFence 共享**同一份**围栏参数与已批准根 ──
    // 三处必须同源；漏任一处 ⇒ 越界写入要么永远写不进、要么确认后仍被拒（静默失效）
    approvedWriteRoots,
    workspaceFenceRoot: securityWorkspaceRoot,
    workspaceFenceExtraRoots: extraWritableRoots,
    // 循环级验证门信号：plan_execute 预测落空时置位（repair.verification 消费）
    planHandoff,
    // 统一宿主：loop 复用 PluginManager 的 PluginHost —— 内核插件（bypass/world-engine/
    // permission-chain）与目录插件共享宿主，目录插件可 deps 依赖 + getService 取服务
    pluginHost: pluginManager.getHost(),
  });

  // plan_execute 内层工具准入：与 ToolExecContext 同一谓词（goal 黑名单 / 工具包 / Router）。
  planExecOpts.allow = (name) => loop.isToolAllowedForExecution(name);

  // ── 模式真源注入：boot 的 sessionType（恢复自 meta.json；新建为 startup.defaultMode）
  // 决定首次 syncRouter() 激活哪个 Router（陪伴默认启动等）。
  loop.setSessionType(sessionType);

  // ── 分发表（阶段 4.2）：service/slot 面需 loop 就绪（stageServices / kernel.pipeline） ──
  // service:<key> → loop.setStageService；slot:* → pluginHost.get('kernel.pipeline').registerStageModule
  await applyServiceReplacements({
    cwd,
    extensionRegistry,
    setService: (key, value) => loop.setStageService(key, value as never),
  });
  await applySlotReplacements({
    cwd,
    extensionRegistry,
    pipeline: (loop.pluginHost.get('kernel.pipeline') as Pipeline | undefined) ?? null,
  });

  // ── 目录插件挂主循环钩子（P6-1：追加注入，宿主不重建 —— 顺序约束随之消失） ──
  pluginManager.setHooks(loop.loopHooks);

  // ── 内核基座插件先挂载（统一宿主）：bypass/permission-chain ──
  // 目录插件在 loadAll 时 deps 依赖 + getService 取服务；permission-chain 用
  // aroundHook，需钩子总线已注入（setHooks 之后）。
  await mountBypassPlugins({ loop, config, configCenter, modelRouter, memoryFilePath, sessionType });
  // ── 内核能力服务（轻量引用，不运行业务）：
  //  context.mode —— 模式切换窄接口；
  //  world-engine.createAgent —— 世界引擎工厂（实现类留在内核库，装配/激活由
  //  companion 目录插件驱动 —— 世界引擎不再是内核插件，不被无条件 mount）。
  // 目录插件经 api.getService 取用。
  pluginManager.getHost().register('context.mode', createContextModeService(loop));
  pluginManager.getHost().register('world-engine.createAgent', createWorldEngineFactory());

  await pluginManager.loadAll();

  // ── 联动清单（第三圈）：把 ~/.agent/tool-links.json 装进"当前清单" ──
  // 没有该文件 ⇒ 装载出厂默认（= 迁移前行为）；校验不过 ⇒ **保旧**并只 warn（不抛）。
  // 关系是数据：改这个文件即可接线/断线，不必改代码（watcher 热更见 hot-reload）。
  {
    const applied = initToolLinksFromDisk({
      // 除 loop 钩子外，还允许 afterWatch / afterScheduleTask 等外部事件源；
      // 少这一步，清单里的 on:"afterWatch:process" 会被判 unknown event
      // ⇒ 静默退回出厂默认（不报错、只是不生效），最难查。
      eventNames: [...LOOP_HOOK_NAMES, ...TOOL_LINK_EXTRA_EVENT_SOURCES],
      handlerIds: buildCoreToolLinkRegistry().ids(),
    });
    if (applied.errors.length > 0) {
      logger.warn('联动清单校验失败，保留出厂默认', { errors: applied.errors, path: applied.path });
    } else if (applied.existed) {
      logger.info('联动清单已生效', { path: applied.path });
    }

    // ── 路线 B（2026-10-29）：注入「按断言自动执行工具」的运行时 ──
    // 清单里声明 { handler: "core.invoke-tool", invoke: { tool, args } } 时，
    // 事件一到就直接执行该工具（零 LLM）。不注入 ⇒ 该处理器静默跳过，
    // append 类完全不受影响 ⇒ 对既有行为零影响。
    // 放在装配层是因为它需要 toolRegistry 实例，而 utils/ 不能反向依赖 tools/。
    setToolLinkRuntime({
      registry: buildCoreToolLinkRegistry(),
      invokeTool: async (toolName, args) => {
        const tool = toolRegistry.get(toolName);
        if (!tool) throw new Error(`[tool-links] invoke target not found: ${toolName}`);
        return await tool.execute(args);
      },
    });
  }

  // ── 自动化链路（AutomationRule，2026-10-30）──
  // 与上面的 tool-links 分工：
  //   tool-links  = 框架内部工具旁路（append 类，需要 tool 执行上下文 payload）
  //   automation  = 用户/模型定义的完整链路（invoke/wake/gate/safety，可多步可分支）
  // 两者共用 TriggerHub 派发与统一执行记录。
  //
  // ⚠️ 为什么包成函数、延后到工具注册之后调用（2026-10-30 真机实测踩坑）：
  //    `say` 等工具由 `registerLoopDependentTools`（本函数 790+ 行，内部 await import）
  //    才注册 —— 因为它们依赖 loop 实例（say 要 loop.submitSay）。
  //    若在本处立即装配，toolRegistry 里**还没有 say** ⇒ 规则被 validate 剔除
  //    （"工具 say 未注册"）⇒ count=0 且不 arm 任何 watcher。
  //    而这只打一条 warn、界面完全无感 —— 正是"配了没反应"的经典陷阱。
  const wireAutomation = () => {
    // 进程级只装配一次（createAgentAssembly 每会话调用，不 guard 会重复注册 sink/watcher）
    if (automationWired) return;
    automationWired = true;

    // 校验需要的"外部知识"：做成**工厂**而非快照 —— 热更后（新工具注册/新 probe kind）
    // 下一次校验能立即跟上，不必重启。
    const makeCtx = (): ValidationContext => ({
      knownProbeKinds: ['file', 'http', 'process', 'port', 'ui_region'],
      knownToolNames: toolRegistry.getToolDefinitions().map((t) => t.name),
      knownHandlers: buildCoreToolLinkRegistry().ids(),
      knownEvents: [...LOOP_HOOK_NAMES, ...TOOL_LINK_EXTRA_EVENT_SOURCES],
    });

    const applied = initAutomationsFromDisk(makeCtx());
    if (applied.errors.length > 0) {
      // 部分无效：非法条目已剔除，其余照常生效 —— 但必须让人看见是哪条错了
      logger.warn('自动化规则部分无效（已剔除）', {
        errors: applied.errors,
        path: applied.path,
        effective: applied.count,
      });
    }
    logger.info('自动化规则已加载', {
      count: applied.count,
      existed: applied.existed,
      path: applied.path,
    });

    // probe 类规则 → 启动 watcher，并建立 ruleId→watchId 映射。
    // runtime 靠这个映射做**精确匹配**：同一 kind 下可能有多条监控
    // （监控 A 日志、监控 B 日志都是 file），只按 kind 匹配会让 A 的命中触发 B 的规则。
    //
    // as unknown as：WatchArmer 是跨层的"最小接口"（参数故意比 WatchSpec 宽），
    // 与真实 WatchService.start 的逆变检查不兼容。spec 的实际形状由
    // WatchService 内部的 probe registry 校验 —— 传错了会在 start 时抛错，
    // 由 armProbeRules 捕获并记入 errors，不会静默跑坏。
    const armed = armProbeRules(
      getCurrentAutomationRules(),
      getWatchService() as unknown as Parameters<typeof armProbeRules>[1],
    );
    if (armed.errors.length > 0) {
      // 单条 arm 失败不阻断其它规则，但必须可见
      logger.warn('自动化规则 arm 部分失败', { errors: armed.errors, armed: armed.armed.size });
    }
    if (armed.armed.size > 0) {
      logger.info('自动化规则已启动监控', { count: armed.armed.size });
    }

    // 注入运行时：invoke（调工具）+ wake（唤醒会话，Where 决定落在哪个会话）
    const runtimeDeps: AutomationRuntimeDeps = {
      invokeTool: async (toolName, args) => {
        const tool = toolRegistry.get(toolName);
        if (!tool) throw new Error(`[automation] 工具不存在: ${toolName}`);
        return await tool.execute(args);
      },
      wakeSession: createWakeSession(() => getSchedulerSessionPort()),
      armedWatchIds: armed.armed,
    };
    setAutomationRuntime(runtimeDeps);

    // ── 工具面：让模型能设计链路（validate / create / list）──
    // 保存后必须**重载 + 重新 arm**，否则：
    //   ① 新规则要重启才生效（用户以为"配了没反应"）
    //   ② 旧 watcher 残留 ⇒ 同一事件触发两次
    // 顺序：停旧 → 写盘 → 重载 → 重 arm → 更新运行时映射
    const asArmer = () => getWatchService() as unknown as Parameters<typeof armProbeRules>[1];
    const reloadAndArm = (): { count: number; errors: string[] } => {
      const prev = getAutomationRuntime()?.armedWatchIds;
      if (prev && prev.size > 0) disarmWatchIds(asArmer(), prev.values());
      const reApplied = initAutomationsFromDisk(makeCtx());
      const reArmed = armProbeRules(getCurrentAutomationRules(), asArmer());
      runtimeDeps.armedWatchIds = reArmed.armed;
      setAutomationRuntime(runtimeDeps);
      return { count: reApplied.count, errors: [...reApplied.errors, ...reArmed.errors] };
    };

    for (const tool of createAutomationTools({
      getContext: () => makeCtx(),
      getRules: () => getCurrentAutomationRules(),
      save: (rules) => {
        saveAutomationRules(rules);
        return reloadAndArm();
      },
    })) {
      toolRegistry.register(tool);
    }
    logger.info('自动化工具面已注册', {
      tools: ['automation_validate', 'automation_create', 'automation_list'],
    });

    // 订阅 TriggerHub：watch / scheduler 已经在 fire，automation 在此消费。
    // 事件转换放在装配层做 —— 让 automation 层不认识 trigger 的类型。
    const hub = ensureGlobalTriggerHub();
    hub.registerSink(async (e) => {
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      const kind = typeof detail.kind === 'string' ? detail.kind : '';
      const watchId = typeof detail.watchId === 'string' ? detail.watchId : '';
      // watch 事件带 watchId，才能让 probe 类规则精确匹配自己 arm 的监控项；
      // 其他源退化为 `<source>:<name>`。
      const eventName =
        e.source === 'watch' && kind
          ? `afterWatch:${kind}${watchId ? `#${watchId}` : ''}`
          : `${e.source}:${e.name}`;

      try {
        const outcomes = await dispatchAutomationEvent({
          eventName,
          source: e.source,
          name: e.name,
          at: e.at,
          payload: detail,
        });
        const failed = outcomes.filter((o) => !o.result.ok);
        if (failed.length > 0) {
          // 失败必须可见（曾经"配了没反应也没提示"排查了一整晚）
          logger.warn('自动化规则执行失败', {
            failed: failed.map((f) => ({ rule: f.ruleName, id: f.ruleId, error: f.result.error })),
          });
        }
        if (outcomes.length > 0) {
          logger.info('自动化规则已执行', {
            event: eventName,
            ran: outcomes.map((o) => ({ rule: o.ruleName, ok: o.result.ok, steps: o.result.steps.length })),
          });
        }
      } catch (err) {
        // 兜底：sink 抛错会拖垮 TriggerHub 的派发循环
        logger.warn('自动化派发异常', { event: eventName, error: (err as Error).message });
      }
    });
    logger.info('自动化已接入 TriggerHub', { sinks: hub.sinkCount() });
  };

  // ── AutoGit（S4：git 自管理策略层，evolution 层消费 GitManager 原语）──
  // wireAutoGit 工厂内聚：new + onTurnEnd 观察者挂载（钩子体系首个装配侧观察者）
  // + 启动处置（autoGit.startupAction 收编遗留脏工作区）。避免装配层直接 new。
  await wireAutoGit(
    (h) => { loop.loopHooks.on('onTurnEnd', async (p) => { await h(p.turn); }); },
    gitManager,
    configCenter,
  );

  // ── 内核插件贡献批（P6-1 原语 + 外移样板）：knowledge/xref/generation 挂载点
  // 迁入 plugin-contributions.ts，先后由 needs/provides 承载（解析期 fail-fast）；
  // 生命周期走 PluginHost.mount。kbApi 由贡献 provides 传出，factory 取用。
  const contribResults = await runPluginContributions({
    cwd,
    configCenter,
    contextComposer,
    pluginManager,
    loop,
    logger,
  });
  const kbApi = contribResults.get('kbApi') as KnowledgeApi | null;

  // 注入知识库状态引用（与 components.kbState 共享同一引用 —— §5.2 收敛：不再各自 `?? {}` 创建新对象）
  const kbStateRef = kbApi?.kbState ?? { lastQuery: '' };
  // ── 回填批（行数收尾第十三批：kbState/pendingAsyncResults/loopRef/scheduler）──
  registerLoopBackfill({
    loop,
    kbStateRef,
    pendingAsyncResults,
    heartbeatScheduler,
  });
  if (supervisor) {
    loop.setLifecycleSupervisor(supervisor);
  }
  loopRefBox.current = loop; // wire fallback notification

  // ── 通道创建失败 → 一次性 UI 通知（2026-10-03）─────────────────────
  // 此前失败只写日志、界面无痕迹 ⇒ "配置写了 commandcode、实际跑 deepseek"
  // 可长期不被察觉。此处把失败清单转成 loop 的一次性通知，下一轮 runTurn 经
  // outputHandler.onStatus 显示为 warn 系统消息（与 fallback 降级通知同机制）。
  // 只报告**有失败**的情况：全绿时不发任何消息（不给正常路径加噪音）。
  const channelFailures = channelRegistry.getChannelFailures();
  if (channelFailures.length > 0) {
    const detail = channelFailures.map((f) => `${f.channel}(${f.error})`).join('; ');
    loop.pendingFallbackInfo =
      `[Channel] ${channelFailures.length} 个通道创建失败，已回退主 provider：${detail}`;
  }

  // 注册后台进程注册表到 LifecycleSupervisor（优雅关闭时自动清理）
  if (supervisor) {
    supervisor.registerBackgroundRegistry(backgroundRegistry);
  }

  // ── 陪伴模式 Session 管理（全局单例，所有渠道共享） ──────────────
  const companionSessionManager = CompanionSessionManager.getInstance();

  // ── MCP 状态回调 / Read 图片 handler（接线抽离 runtime-wiring.ts）──
  wireMcpStatusCallback(mcpSystem);
  wireReadToolImageHandler(toolRegistry, loop);

  // ── Runtime Control 工具注册（行数收尾第十二批：接线抽离 tool-registration.ts）──
  // ⚠️ 工具只通过注册表统一注册：src/tools/runtime-control.ts → createXxxTool() 工厂
  // → registerRuntimeControlTools()。内置工具 → src/tools/index.ts → createDefaultRegistry()。
  // 时序锚：不依赖 loop 的工具已在 AgentLoop 之前注册；依赖 loop 的紧跟在构造之后。
  await registerLoopDependentTools({
    loop,
    toolRegistry,
    providerRouter,
    skillRegistry,
    agentRegistry,
    configCenter,
    cwd,
    heartbeatScheduler,
    mcpSystem,
    modelRouter,
    sessionDir,
    gitManager,
    turnStore,
    flowRegistry,
    companionSessionManager,
  });

  // ⚠️ 时序锚（2026-10-30 真机实测踩坑）：
  //    automation 装配**必须**在 registerLoopDependentTools 之后。
  //    say / deliver 等工具依赖 loop 实例，在这一批（await import）才注册；
  //    提前装配会让规则因「工具 say 未注册」被 validate 剔除
  //    ⇒ count=0、不 arm 任何 watcher，且只有一条 warn —— 界面完全无感。
  wireAutomation();

  // ── goal 模式审查官接线（2026-10-10）────────────────────────────────────
  // 审查官是**独立职责**的子 agent（用户裁定「独立」）：模型走 assessment 角色通道，
  // 工具 [read/glob/grep/bash]（能自行复核），每轮全新 session（用后即弃）。
  // 未接线时 loop 视为「审查不可用」→ 放行并标注未核验（不锁死）。
  {
    const { createGoalReviewer } = await import('../agents/goal-reviewer.js');
    loop.setGoalReviewer(createGoalReviewer({
      modelRouter,
      toolRegistry,
      sessionDir,
      maxContextTokens: maxContext,
      dependencyAnalyzer,
      createSubProvider: (userId: string) => {
        const scoped = modelRouter.createScopedProvider('assessment', userId);
        if (!scoped) throw new Error('Cannot create goal-reviewer provider: channel "assessment" unavailable.');
        return scoped;
      },
    }));
  }

  // 注册 MCP 状态变更回调 — 消息通过 ContextSource (runtime:mcp_status) 自动注入 Zone 5，
  // 此处仅保留日志记录（未来可扩展为 TUI 状态栏更新）
  // ── 渠道注册表 + 定时任务处理器 + 配置订阅（接线抽离 runtime-wiring.ts）──
  const { registries: { channelLoops, channelSessions }, resolveChannelLoop } =
    setupChannelRegistries(loop, options.channel, configCenter);
  installSchedulerHandler({ heartbeatScheduler, loop, channelLoops, resolveChannelLoop, configCenter });
  wireConfigSubscriptions({ loop, configCenter, modelRouter, toolRegistry, skillRegistry, agentRegistry });

  // ── 运行时装配贡献批（行数收尾第二批：ToolBundleRegistry + HotReloadManager）──
  // 依赖均已就绪、无前向引用、产出单一 —— 经 AssemblyRunner 增量多批装配，
  // 与插件贡献批（plugin-contributions.ts）同模式。白名单随迁出逐条下降。
  const runtimeResults = await runRuntimeContributions({
    cwd,
    configCenter,
    contextComposer,
    toolRegistry,
    skillRegistry,
    agentRegistry,
    pluginManager,
    mcpSystem,
    channelRegistry,
    providerConfigLoader,
    modelCatalog,
    extensionRegistry,
    manifestAccess,
    // 联动清单访问面（第三圈）：装配层注入"路径 + 装载逻辑"，hot-reload 层只做类型引用。
    // 与上面那次启动装载**调用同一函数** ⇒ 冷启动与热更的语义必然一致，不会分叉。
    toolLinksAccess: {
      listPaths: () => [toolLinksPath()],
      reload: () =>
        initToolLinksFromDisk({
          eventNames: LOOP_HOOK_NAMES,
          handlerIds: buildCoreToolLinkRegistry().ids(),
        }),
    },
  });
  const bundleRegistry = runtimeResults.get('bundleRegistry') as ToolBundleRegistry;
  const hotReloadManager = runtimeResults.get('hotReloadManager') as HotReloadManager;

  // ── 全部内置 ContextSource 接线抽离（原 11 个内联 registerSource 块）──
  // 依赖（含懒闭包前向引用的 loopRef/loop）均已就绪；compose 输出由
  // section-resolver 按 zone/priority 排序，注册时序推迟行为等价。
  registerContextSources({
    contextComposer,
    cwd,
    channelsInfo,
    envInfo,
    currentChannel,
    flowRegistry,
    memoryStore,
    toolRegistry,
    skillRegistry,
    agentRegistry,
    summaryStore,
    loopRefBox,
    loop,
    bundleRegistry,
  });

  // ── 分发表：source 面（名单替换源，须在内置源注册后应用以覆盖同名） ──
  await applySourceReplacements({ cwd, extensionRegistry, composer: contextComposer });

  // ── Tool Bundle 工具注册（接线，保留）───────────────────────────────
  registerBundleTools(toolRegistry, bundleRegistry);
  loop.setBundleRegistry(bundleRegistry);
  // MCP：每个 server 自动同步一个独立工具包（`mcp-<server>`）⇒ 可按需 activate_bundle（2026-10-13 孑遗指派）
  // ⚠️ `all` 模式保持原样（启用 all = 所有工具可用，含 MCP）—— 本包的价值只在「不用 all」时体现，不给 all 开特例。
  mcpSystem.setBundleRegistry(bundleRegistry);

  // ── 架构监督基线上报（阶段 5）：未被替换点补记 builtin 生效条目，
  // 使 arch.list 一屏可见「谁在实际岗位上」（幂等，不覆盖名单替换条目）
  recordBuiltinBaselines({
    extensionRegistry,
    pipeline: pipelineSlots,
    sources: contextComposer.listSourceNames(),
    routerName: loop.activeRouter?.name,
  });

  // ── Hot Reload Manager（装配已迁入 runtime-contributions.ts）──
  // 清除上一 session 可能残留的热插拔标记，确保重启后工具归位 Zone 2
  toolRegistry.clearHotAdded();

  hotReloadManager.start();

  return {
    loop,
    sessionDir,
    sessionManager,
    toolRegistry,
    bundleRegistry,
    skillRegistry,
    agentRegistry,
    dependencyAnalyzer,
    contextComposer,
    mcpSystem,
    hotReloadManager,
    assemblyRegistry,
    extensionRegistry,
    modelRouter,
    providerConfigLoader,
    // §5.2 收敛：knowledgeBase 放宽为 | null（mount 失败诚实表达）；kbState 共享 kbStateRef 同一引用
    knowledgeBase: kbApi?.knowledgeBase ?? null,
    kbState: kbStateRef,
    companionSessionManager,
    backgroundRegistry,
    scheduler: heartbeatScheduler,
    // 目录插件管理面（plugin 契约域经 backend 注入消费：清单/启停/重载）
    pluginManager,
    channelLoops,
  };
}
