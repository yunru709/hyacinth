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
import { scratchpadPath } from '../context/scratchpad.js';
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
import { initToolLinksFromDisk, toolLinksPath } from '../supervisor/tool-links.js';
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
  const effectivePersonaDir = await bootstrapPersona(personaDir);
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
  const currentSessionIdForCtx = currentSessionId;

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
  applyWorkspaceFence(toolRegistry, securityWorkspaceRoot, [path.dirname(scratchpadPath())]);
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
  toolRegistry.register(createPlanExecuteTool(toolExecutor, {
    onHandoff: (reason) => { planHandoff.pending = reason; },
  }));

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

  // MCP 启动（可能启动子进程，慢）与调度器启动、依赖分析并行
  const [, , dependencyAnalyzer] = await Promise.all([
    mcpSystem.start(),
    heartbeatScheduler.start(),
    initDependencyAnalyzer(cwd),
  ] as const);

  mcpSystem.registerToToolRegistry(toolRegistry);
  mcpSystem.registerToContextComposer(contextComposer);
  if (supervisor) {
    mcpSystem.registerToLifecycleSupervisor(supervisor);
  }

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
    maxContextTokens: maxContext,
    personaDir: effectivePersonaDir,
    dangerousTools: new Set(deriveDangerousTools(() => toolRegistry.getAll())),
    allowlistTools: new Set(),
    // 循环级验证门信号：plan_execute 预测落空时置位（repair.verification 消费）
    planHandoff,
    // 统一宿主：loop 复用 PluginManager 的 PluginHost —— 内核插件（bypass/world-engine/
    // permission-chain）与目录插件共享宿主，目录插件可 deps 依赖 + getService 取服务
    pluginHost: pluginManager.getHost(),
  });

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
  pluginManager.getHost().register('context.mode', createContextModeService());
  pluginManager.getHost().register('world-engine.createAgent', createWorldEngineFactory());

  await pluginManager.loadAll();

  // ── 联动清单（第三圈）：把 ~/.agent/tool-links.json 装进"当前清单" ──
  // 没有该文件 ⇒ 装载出厂默认（= 迁移前行为）；校验不过 ⇒ **保旧**并只 warn（不抛）。
  // 关系是数据：改这个文件即可接线/断线，不必改代码（watcher 热更见 hot-reload）。
  {
    const applied = initToolLinksFromDisk({
      eventNames: LOOP_HOOK_NAMES,
      handlerIds: buildCoreToolLinkRegistry().ids(),
    });
    if (applied.errors.length > 0) {
      logger.warn('联动清单校验失败，保留出厂默认', { errors: applied.errors, path: applied.path });
    } else if (applied.existed) {
      logger.info('联动清单已生效', { path: applied.path });
    }
  }

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
    sessionDir,
    channelsInfo,
    envInfo,
    currentChannel,
    currentSessionIdForCtx,
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

  // ── 架构监督基线上报（阶段 5）：未被替换点补记 builtin 生效条目，
  // 使 arch.list 一屏可见「谁在实际岗位上」（幂等，不覆盖名单替换条目）
  recordBuiltinBaselines({
    extensionRegistry,
    pipeline: pipelineSlots,
    sources: contextComposer.listSourceNames(),
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
    channelLoops,
  };
}
