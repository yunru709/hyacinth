import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SessionManager } from '../memory/session.js';
import { createDefaultRegistry, createBuiltInTools, BashTool } from '../tools/index.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolBundleRegistry } from '../tools/bundle-registry.js';
import { registerBundleTools } from '../tools/bundle-tools.js';
import { GitManager } from '../evolution/git-manager.js';
import { SkillRegistry, createBuiltinSkills, SkillTool } from '../skills/index.js';
import { AgentRegistry, createBuiltinAgents, DelegateToAgentTool, loadAgentConfigs } from '../agents/index.js';
import { MCPSystem } from '../mcp/index.js';
import { LifecycleSupervisor } from '../lifecycle/supervisor.js';
import { LayeredContextComposer } from '../context/composer.js';
import {
  KnowledgeBase,
  KnowledgeWatcher,
  createKbAddTool,
  createKbListTool,
  createKbDeleteTool,
  StructuredStore,
  createAddStructuredTool,
  createUpdateStructuredTool,
  createDeleteStructuredTool,
  createListStructuredTool,
  createKbUpdateTool,
  createKbToggleTool,
} from '../knowledge/index.js';
import { DefaultStrategy, PreciseStrategy, type ComposeStrategy } from '../context/precision/index.js';
import { CompressorOrchestrator, StructuredSummarizer } from '../context/compressor.js';
import { TokenCounter } from '../context/tokenizer.js';
import { LLMOrchestrator } from '../orchestrator/planner.js';
import { PlanStore } from '../orchestrator/plan-store.js';
import { ConversationStore } from '../memory/conversation.js';
import { EventStore } from '../memory/events.js';
import { StatsManager } from '../memory/stats.js';
import { SummaryStore } from '../memory/summary.js';
import { MemoryStore } from '../memory/memory-store.js';
import { AgentLoop } from '../orchestrator/loop.js';
import { PluginManager } from '../plugins/index.js';
import { initDependencyAnalyzer } from '../dependency/index.js';
import type { Provider } from '../provider/interface.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import type { OutputHandler } from '../orchestrator/loop.js';
import type { BootstrapStatus } from '../setup/persona-bootstrap.js';
import { ensureGlobalPersonaFiles, getBootstrapStatus } from '../setup/persona-bootstrap.js';
import { ConfigManager } from '../setup/config.js';
import { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { FullConfig } from '../runtime/config-schema.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { createLogger } from '../logging/logger.js';
import { ProviderRouter } from '../provider/router.js';
import { ModelRouter } from '../provider/model-router.js';
import type { ModelsConfig, LocalModelConfig } from '../provider/model-router.js';
import { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { TrainingScheduler } from '../training/scheduler.js';
import { DataRefiner } from '../training/refiner.js';
import { RefinedDataStore } from '../training/refined-store.js';
import { AdapterBridge } from '../training/adapter-bridge.js';
import { LocalModelModule } from '../local-model/index.js';
import { HeartbeatScheduler } from '../schedule/scheduler.js';
import { HotReloadManager } from '../hot-reload/index.js';
import { ProviderConfigLoader, getProviderConfigLoader } from '../provider/config.js';
import { getModelCatalogLoader } from '../provider/model-catalog-loader.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { modelCatalog } from '../provider/catalog.js';
import { ModeManager, createPlanMode, createSpecMode, createTodoMode, createBootstrapMode } from '../modes/index.js';
import { createBootstrapMarkTool } from '../tools/bootstrap.js';
import { createTriggerCompressionTool } from '../tools/compression.js';
import { BackgroundProcessRegistry } from '../tools/background-registry.js';
import { createProcessListTool, createProcessKillTool, createProcessOutputTool } from '../tools/process-tools.js';

import { collectSystemInfo, buildEnvironmentSection } from '../env/index.js';
import type { ChannelsInfo } from '../env/index.js';
import { CommandRegistry } from '../ui/command-registry.js';
import { TrainingAggregator } from '../training/aggregator.js';
import { DatasetBuilder } from '../training/dataset.js';
import { AdapterManager } from '../training/adapter.js';
import { ModelStore } from '../training/model-store.js';

const logger = createLogger('factory');

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
  /** Bootstrap 工作区目录 */
  personaDir?: string;
  /** Bootstrap 状态 */
  bootstrapStatus?: BootstrapStatus;
  /** 本地模型 Provider（用于压缩通道，不影响主对话） */
  localModelProvider?: Provider;
  /** 渠道信息（注入到 System Prompt 的 environment section） */
  channelsInfo?: ChannelsInfo[];
}

export interface AgentComponents {
  loop: AgentLoop;
  sessionDir: string;
  sessionManager: SessionManager;
  toolRegistry: ReturnType<typeof createDefaultRegistry>;
  skillRegistry: SkillRegistry;
  agentRegistry: AgentRegistry;
  dependencyAnalyzer?: DependencyAnalyzer;
  contextComposer: LayeredContextComposer;
  mcpSystem: MCPSystem;
  hotReloadManager: HotReloadManager;
  modeManager: ModeManager;
  modelRouter: ModelRouter;
  providerConfigLoader: ProviderConfigLoader;
  knowledgeBase: KnowledgeBase;
  kbState: { lastQuery: string };
  kbWatcher: KnowledgeWatcher;
  structuredStore: StructuredStore;
  composeStrategy: ComposeStrategy;
  backgroundRegistry: BackgroundProcessRegistry;
}

// ─── Factory ─────────────────────────────────────────────────────────

export async function createAgent(
  options: CreateAgentOptions,
  supervisor?: LifecycleSupervisor,
): Promise<AgentComponents> {
  const { cwd, provider, maxTurns, maxContext, outputHandler, sessionId, shouldContinue, maxMessages = 10000, personaDir, bootstrapStatus, localModelProvider, channelsInfo } = options;

  // ── Session ──────────────────────────────────────────────────────
  const sessionManager = new SessionManager(cwd);
  let sessionDir: string;
  let currentSessionId: string;
  let sessionType: 'normal' | 'precise' = 'normal';

  if (sessionId) {
    const session = await sessionManager.resume(sessionId);
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = session.type ?? 'normal';
    logger.info('Resumed session', { sessionId: session.id, type: sessionType });
  } else if (shouldContinue) {
    const session = await sessionManager.resume();
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = session.type ?? 'normal';
    logger.info('Continued session', { sessionId: session.id, type: sessionType });
  } else {
    const session = await sessionManager.create();
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    logger.info('New session', { sessionId: session.id });
  }

  // ── Git 基础设施 ──────────────────────────────────────────────────
  const gitManager = new GitManager(cwd);

  // ── 配置加载 ──────────────────────────────────────────────────────
  const configManager = new ConfigManager(cwd);
  const config = await configManager.load();

  // ── Global Persona Bootstrap ──────────────────────────────────────
  const personaSetup = await ensureGlobalPersonaFiles();
  const effectivePersonaDir = personaDir ?? personaSetup.personaDir;
  const effectiveBootstrapStatus = bootstrapStatus ?? (await getBootstrapStatus(effectivePersonaDir));

  // ── Provider Config Loader（必须在 getDefaultConfig 之前，确保 providerDefault 读到 JSON） ──
  const providerConfigLoader = getProviderConfigLoader(cwd);
  await providerConfigLoader.load();

  // ── Runtime Config Center ──────────────────────────────────────────
  const configCenter = RuntimeConfigCenter.getInstance();
  configCenter.initialize(getDefaultConfig(), configManager);
  configCenter.merge(config as unknown as Partial<FullConfig>);

  // 统一从 configCenter 读取 maxTurns（合并了 defaults + config.json 覆盖）
  const effectiveMaxTurns = configCenter.get<number>('session.maxTurns') ?? maxTurns;

  // ── Model Catalog Loader ───────────────────────────────────────────
  getModelCatalogLoader(cwd);
  modelCatalog.init(cwd);

  const modelCtx = getModelContextWindow(provider.getProviderType(), provider.getModel());
  // 仅当 configCenter 中尚无用户自定义值时，才用模型原生上限初始化
  const existingMaxContext = configCenter.get<number>('session.maxContext');
  if (!existingMaxContext || existingMaxContext <= 0) {
    configCenter.set('session.maxContext', modelCtx);
  }

  // ── Fallback 上下文自适应：降级链切换 Provider 时自动更新 maxContextTokens ──
  let loopRef: AgentLoop | null = null;
  const fallbackChain = provider as { setOnFallback?: (cb: (from: unknown, to: unknown, err: Error) => void) => void };
  if (fallbackChain.setOnFallback) {
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
      // 一次性通知：下一次 runTurn 消费
      if (loopRef) {
        loopRef.pendingFallbackInfo = `[Fallback] "${fromP.getProviderType()}" unavailable — using "${toProvider.getProviderType()}". Check API key or quota.`;
      }
    });
  }

  // 统一使用 configCenter 中的 maxContext，确保与 loop.ts 一致
  const effectiveMaxContext = configCenter.get<number>('session.maxContext') ?? maxContext;

  // ── 核心模块 ──────────────────────────────────────────────────────
  const contextComposer = new LayeredContextComposer(effectiveMaxContext);
  const tokenCounter = new TokenCounter();

  // ── 环境信息采集（进程启动时执行一次，注册为 ContextSource） ────────
  const envInfo = collectSystemInfo();
  contextComposer.registerSource({
    name: 'env-info',
    strategy: 'always_inline',
    cacheability: 'anchor',
    description: '运行环境信息（静态模板 + 动态系统信息 + 渠道信息）',
    getContent: () => buildEnvironmentSection(envInfo, channelsInfo, { cwd }),
  });

  // ── 跨会话 Memory 系统 ─────────────────────────────────────────────
  const memoryFilePath = config.memoryFile ?? path.join(os.homedir(), '.agent', 'prompts', 'persona', 'memory.md');
  const memoryDir = path.dirname(memoryFilePath);
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  const memoryStore = new MemoryStore(memoryFilePath);
  memoryStore.initializeIfNeeded();
  contextComposer.registerSource({
    name: 'memory',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '跨会话项目记忆',
    getContent: () => memoryStore.formatForContext(),
  });

  // ── 历史对话边界标记 — 对抗长上下文注意力漂移 ──────────────────────
  contextComposer.registerSource({
    name: 'history_boundary_before',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '历史对话开始标记',
    getContent: () => {
      return contextComposer.activeConditions.has('precise_mode')
        ? '── 以下为检索有关信息 ──'
        : '── 以下为历史对话 ──';
    },
  });
  contextComposer.registerSource({
    name: 'history_boundary_after',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '历史对话结束标记',
    getContent: () => {
      return contextComposer.activeConditions.has('precise_mode')
        ? '── 以上为检索有关信息 ──'
        : '── 以上为历史对话 ──';
    },
  });

  // ── 会话临时工具 ContextSource ──────────────────────────────────────
  // hot-reload 热添加的工具不进 Zone 2 tool_rules，在此 Zone 5 session_tools 展示。
  // 下次启动时工具已在 ToolRegistry 中持久化，自然归位到 tool_rules。
  contextComposer.registerSource({
    name: 'session-tools',
    strategy: 'index_only',
    cacheability: 'live',
    description: '会话临时工具',
    getContent: () => {
      const names = toolRegistry.getHotAddedNames();
      return names.length > 0 ? `[Session-only tools]\n${names.join(', ')}` : '';
    },
  });
  const channelRegistry = new ModelChannelRegistry(cwd);
  const providerActive = typeof config.provider === 'object'
    ? (config.provider as Record<string, unknown>).active as string | undefined
    : undefined;
  channelRegistry.buildFromLegacy(config.models, config.local, providerActive);
  channelRegistry.initializeChannels();
  // 将 ProviderManager 构建的带弹性层（重试+熔断+降级链）的主 Provider 注入 registry，
  // 替换 initializeChannels 中创建的裸 Provider
  channelRegistry.setMainProvider(provider, providerActive);
  const modelRouter = new ModelRouter(provider, config.models, config.local, channelRegistry);
  const summarizer = new StructuredSummarizer(modelRouter);
  const compressor = new CompressorOrchestrator(tokenCounter, summarizer, effectiveMaxContext, {
    compressThreshold: config.context?.compressThreshold,
    compressDepth: config.context?.compressDepth,
  });
  const toolRegistry = createBuiltInTools(gitManager, currentSessionId, cwd);
  const toolExecutor = new ToolExecutor(toolRegistry);

  // ── 后台进程注册表（异步工具支持）────────────────────────────────────
  const backgroundRegistry = new BackgroundProcessRegistry();

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
  const conversationStore = new ConversationStore(maxMessages);
  const eventStore = new EventStore();
  const statsManager = new StatsManager();
  const summaryStore = new SummaryStore();

  // ── Skill 系统 ────────────────────────────────────────────────────
  const skillRegistry = new SkillRegistry();
  for (const skill of createBuiltinSkills()) {
    skillRegistry.registerBuiltin(skill);
  }
  const skillTool = new SkillTool(skillRegistry);
  toolRegistry.register(skillTool);

  // 注册每个 Skill 为独立的 lazy_expand 源
  for (const skill of skillRegistry.getAll()) {
    contextComposer.registerSource({
      name: `skill-${skill.name}`,
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: skill.description,
      getContent: () => skillRegistry.getFullDefinitions([skill.name]),
    });
  }

  // ── MCP 系统（统一管理，随主进程启动）───────────────────────────
  const mcpSystem = new MCPSystem({ cwd });
  await mcpSystem.start();
  mcpSystem.registerToToolRegistry(toolRegistry);
  mcpSystem.registerToContextComposer(contextComposer);
  if (supervisor) {
    mcpSystem.registerToLifecycleSupervisor(supervisor);
  }

  // ── 插件系统 ──────────────────────────────────────────────────────
  const pluginManager = new PluginManager({
    toolRegistry,
    skillRegistry,
    contextComposer,
    projectDir: cwd,
    mcpSystem,
  });
  await pluginManager.loadAll();

  // ── 编排器 ────────────────────────────────────────────────────────
  const planStore = new PlanStore();
  const orchestrator = new LLMOrchestrator(provider, planStore, sessionDir, modelRouter);

  // ── Provider 路由 + 训练调度器 ─────────────────────────────────────
  const { trainingScheduler, providerRouter } = await createTrainingPipeline({
    cwd,
    sessionDir,
    statsManager,
    provider,
    localModelProvider,
    config,
  });

  // ── 定时任务调度器 ─────────────────────────────────────────────────
  // Read persisted schedule config from configCenter, fallback to config.schedule
  const persistedSchedule = configCenter.get('schedule') as Record<string, unknown> | undefined;
  const scheduleConfig = persistedSchedule ?? config.schedule;
  const heartbeatScheduler = new HeartbeatScheduler(undefined, scheduleConfig as any);
  heartbeatScheduler.subscribeConfig(configCenter);
  await heartbeatScheduler.start();

  // ── 依赖图谱分析器 ────────────────────────────────────────────────
  const dependencyAnalyzer = await initDependencyAnalyzer(cwd);

  // ── CodeGraphTool（依赖图谱查询，需 DependencyAnalyzer 实例） ──────
  if (dependencyAnalyzer) {
    const { CodeGraphTool } = await import('../tools/code-graph.js');
    toolRegistry.register(new CodeGraphTool(dependencyAnalyzer));
  }

  // ── 子 Agent 系统 ─────────────────────────────────────────────────
  const agentRegistry = new AgentRegistry();
  const agents = await loadAgentConfigs(cwd, config.agents);
  for (const agent of agents) {
    agentRegistry.register(agent);
  }
  const delegateTool = new DelegateToAgentTool(agentRegistry, {
    modelRouter,
    toolRegistry,
    sessionDir,
    maxContextTokens: maxContext,
    dependencyAnalyzer,
  });
  toolRegistry.register(delegateTool);

  // 注册每个子 Agent 为独立的 lazy_expand 源
  for (const agent of agentRegistry.getAll()) {
    contextComposer.registerSource({
      name: `agent-${agent.name}`,
      strategy: 'lazy_expand',
      cacheability: 'manifest',
      description: agent.description,
      getContent: () => agentRegistry.getFullDefinitions([agent.name]),
    });
  }

  // ── Mode Manager ─────────────────────────────────────────────────
  const modeManager = new ModeManager();
  modeManager.register(createBootstrapMode(effectivePersonaDir));
  if (effectiveBootstrapStatus === 'pending') {
    modeManager.activate('bootstrap');
  }
  modeManager.register(createPlanMode());
  modeManager.register(createSpecMode());
  modeManager.register(createTodoMode());

  // 绑定 session 目录（模式状态随 session 持久化，切换时自动保存/恢复）
  modeManager.setSessionDir(sessionDir);

  // Zone 5 模式注入：plan/spec/todo 激活时每轮注入模式提示词
  contextComposer.registerSource({
    name: 'mode-injection',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '当前激活模式的注入内容',
    getContent: () => modeManager.isActive() ? (modeManager.renderForInjection() ?? '') : '',
  });

  // ── 模式系统工具 ──────────────────────────────────────────────────
  const { createModeMarkTool, createTaskStartTool, createTaskMarkTool } = await import('../tools/mode-tools.js');
  toolRegistry.register(createModeMarkTool(modeManager));
  toolRegistry.register(createBootstrapMarkTool(modeManager));
  toolRegistry.register(createTaskStartTool(modeManager));
  toolRegistry.register(createTaskMarkTool(modeManager));

  // ── 知识库（Zone 4，默认关闭）───────────────────────────────────────
  const kbDir = path.join(os.homedir(), '.agent', 'knowledge');
  const kbStorePath = path.join(kbDir, 'kb.sqlite');

  // 结构化存储（主）
  const structuredStore = new StructuredStore(kbStorePath);

  // 旧版文件索引（保留兼容）
  const kbFilesDir = path.join(kbDir, 'files');
  fs.mkdirSync(kbFilesDir, { recursive: true });
  const knowledgeBase = new KnowledgeBase(kbStorePath);
  const kbState = { lastQuery: '' };

  // Zone 4 ContextSource（结构化 tag 匹配 + FTS5 兜底）
  contextComposer.registerSource({
    name: 'kb_context',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '知识库检索结果',
    getContent: async () => {
      if (!knowledgeBase.enabled) return '';
      const q = kbState.lastQuery;
      if (!q || !q.trim()) return '';
      const maxTotal = configCenter.get<number>('kb.maxTotal') ?? 5;
      const maxMain = configCenter.get<number>('kb.maxMain') ?? 3;
      const maxRefs = configCenter.get<number>('kb.maxRefs') ?? 2;
      return structuredStore.formatResults(
        structuredStore.search(q, maxTotal),
        maxMain,
        maxRefs,
      );
    },
  });
  // 旧工具（保留兼容）
  const kbAddTool = createKbAddTool(knowledgeBase, kbFilesDir);
  toolRegistry.register(kbAddTool);
  toolRegistry.register(createKbListTool(knowledgeBase));
  toolRegistry.register(createKbDeleteTool(knowledgeBase, kbFilesDir));
  toolRegistry.register(createKbUpdateTool(knowledgeBase, kbFilesDir));
  toolRegistry.register(createKbToggleTool(knowledgeBase, contextComposer));
  // 新结构化工具
  toolRegistry.register(createAddStructuredTool(structuredStore, () => knowledgeBase.enabled));
  toolRegistry.register(createUpdateStructuredTool(structuredStore, () => knowledgeBase.enabled));
  toolRegistry.register(createDeleteStructuredTool(structuredStore, () => knowledgeBase.enabled));
  toolRegistry.register(createListStructuredTool(structuredStore, () => knowledgeBase.enabled));

  // ── 知识库文件监控（后台自动索引 files/ 目录变更）─────────────────
  const kbWatcher = new KnowledgeWatcher({
    filesDir: kbFilesDir,
    retriever: knowledgeBase.retriever,
  });
  // 异步启动，不阻塞 Agent 主流程
  kbWatcher.start().catch(() => {});

  // ── Command Registry（斜杠命令外部配置化，支持模型修改 + 热重载） ──
  CommandRegistry.getInstance(cwd);

  // ── AgentLoop ─────────────────────────────────────────────────────
  const loop = new AgentLoop(
    provider,
    contextComposer,
    compressor,
    orchestrator,
    toolExecutor,
    toolRegistry,
    conversationStore,
    eventStore,
    statsManager,
    sessionDir,
    summaryStore,
    effectiveMaxTurns,
    maxContext,
    outputHandler,
    skillRegistry,
    mcpSystem.getBridge(),
    dependencyAnalyzer,
    agentRegistry,
    effectivePersonaDir,
    effectiveBootstrapStatus,
    providerRouter,
    trainingScheduler,
    new Set(config.safety?.dangerousTools ?? ['write', 'bash']),
    new Set(),
    config.training?.scheduleTime ?? '03:00',
    configCenter,
    modeManager,
    modelRouter,
  );

  // 注入知识库状态引用
  loop.kbState = kbState;
  loopRef = loop; // wire fallback notification

  // 注册后台进程注册表到 LifecycleSupervisor（优雅关闭时自动清理）
  if (supervisor) {
    supervisor.registerBackgroundRegistry(backgroundRegistry);
  }

  // 注入精确模式策略（默认普通模式）
  const composeStrategy = sessionType === 'precise'
    ? new PreciseStrategy(sessionDir)
    : new DefaultStrategy();
  loop.composeStrategy = composeStrategy;

  // ── Read 工具的图片处理器 — 将读到的图片注入 ImageStore ──
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

  // ── ImageStore 上下文注入 — 让模型始终知道已索引的图片 ──────────
  contextComposer.registerSource({
    name: 'image_store',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '已索引图片清单（通过 view_image 工具可重新查看）',
    getContent: () => loop.imageStore.listForContext(),
  });

  // ── Runtime Control 工具注册 ──────────────────────────────────────
  // ⚠️ 工具只通过注册表统一注册，禁止在此处或 loop.ts 中直接 new Tool() 硬编码。
  // 新增运行时工具的正确方式：
  //   1. src/tools/runtime-control.ts → createXxxTool() 工厂函数
  //   2. src/registry/tool.registry.ts → registerRuntimeControlTools() 内注册
  //   3. 命名遵循 create{Name}Tool 模式，参考已有工具
  // 内置工具 → src/tools/index.ts → createDefaultRegistry()

  // 不依赖 loop 的工具在 AgentLoop 之前注册；依赖 loop 的紧跟在构造之后。
  // 确保工具列表在首轮 compose 前已完整。
  toolRegistry.registerConfigTools(configCenter);
  toolRegistry.registerTrainingTools(trainingScheduler, configCenter);
  // registerRuntimeControlTools 内有 switch_provider / set_mode 等 30+ 工具依赖 loop 实例
  toolRegistry.registerRuntimeControlTools(loop, providerRouter, skillRegistry, agentRegistry, trainingScheduler, configCenter, cwd, heartbeatScheduler, mcpSystem, modelRouter);
  toolRegistry.register(createTriggerCompressionTool(loop));

  // destroy_sub_agent 需要 sessionDir，在此单独注册
  const { createDestroySubAgentTool } = await import('../tools/runtime-control.js');
  toolRegistry.register(createDestroySubAgentTool(agentRegistry, sessionDir));

  // 注册 MCP 状态变更回调 — 消息通过 ContextSource (runtime:mcp_status) 自动注入 Zone 5，
  // 此处仅保留日志记录（未来可扩展为 TUI 状态栏更新）
  mcpSystem.onStatusChange(({ type, name, tools }) => {
    logger.info(`MCP status: ${type}`, { name, tools: tools?.join(',') });
  });

  loop.setScheduler(heartbeatScheduler);

  // 定时任务处理器：任务触发时执行动作或唤醒 Agent
  heartbeatScheduler.setHandler(async (task) => {
    logger.info(`Scheduled task fired: ${task.name}`, { id: task.id, type: task.action.type });
    if (task.action.type === 'command') {
      const { exec } = await import('node:child_process');
      exec(task.action.target, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) logger.error(`Task command failed: ${task.name}`, err, { stderr: stderr.trim() });
        else logger.info(`Task command OK: ${task.name}`, { stdout: stdout.trim() });
      });
    } else {
      // 唤醒 Agent，自动发起一轮对话执行任务
      loop.notifyTaskFired(task.name).catch(err =>
        logger.error(`Task notify failed: ${task.name}`, err instanceof Error ? err : new Error(String(err)))
      );
    }
  });

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

  // ── Tool Bundle Registry ────────────────────────────────────────────
  const bundleRegistry = new ToolBundleRegistry(cwd);
  registerBundleTools(toolRegistry, bundleRegistry);

  // 注册为 ContextSource：Zone 2 展示 bundle 索引，Zone 5 展开当前包的工具体
  contextComposer.registerSource({
    name: 'tool-bundles',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '工具包索引',
    getContent: () => {
      const bundles = bundleRegistry.list();
      if (bundles.length === 0) return '';
      const activeNames = new Set(bundleRegistry.getActive().map(b => b.name));
      const lines = bundles.map(b => {
        let marker = '';
        if (b.name === 'common') {
          marker = ' [始终加载]';
        } else if (activeNames.has(b.name)) {
          marker = ' [已激活]';
        }
        const toolCount = b.tools.length > 0 ? ` (${b.tools.length} tools)` : ' (全量)';
        return `- ${b.name}: ${b.description}${toolCount}${marker}`;
      });
      return `工具包 (使用 activate_bundle <name> 激活，可同时激活多个):\n${lines.join('\n')}`;
    },
  });
  loop.setBundleRegistry(bundleRegistry);

  // ── Hot Reload Manager ────────────────────────────────────────────
  const hotReloadManager = new HotReloadManager({
    toolRegistry,
    skillRegistry,
    agentRegistry,
    pluginManager,
    configCenter,
    contextComposer,
    mcpSystem,
    bundleRegistry,
    channelRegistry,
    cwd,
    providerConfigLoader,
    modelCatalog,
  });
  hotReloadManager.start();

  return {
    loop,
    sessionDir,
    sessionManager,
    toolRegistry,
    skillRegistry,
    agentRegistry,
    dependencyAnalyzer,
    contextComposer,
    mcpSystem,
    hotReloadManager,
    modeManager,
    modelRouter,
    providerConfigLoader,
    knowledgeBase,
    kbState,
    kbWatcher,
    structuredStore,
    composeStrategy,
    backgroundRegistry,
  };
}

/**
 * 创建训练调度器及其依赖组件（用于 CLI 命令和 Agent 主流程）
 */
export async function createTrainingPipeline(options: {
  cwd: string;
  sessionDir: string;
  statsManager: StatsManager;
  provider: Provider;
  localModelProvider?: Provider;
  config: Awaited<ReturnType<ConfigManager['load']>>;
}): Promise<{ trainingScheduler: TrainingScheduler; providerRouter: ProviderRouter }> {
  const { cwd, sessionDir, statsManager, provider, localModelProvider, config } = options;

  const sessionsParentDir = path.dirname(sessionDir);
  const trainingDataDir = path.join(cwd, 'training_data');
  const adaptersDir = path.join(cwd, 'adapters');

  const providerRouter = new ProviderRouter();
  providerRouter.register('main', provider);
  if (localModelProvider) {
    providerRouter.register('local', localModelProvider);
  }

  const modelStore = new ModelStore(path.join(cwd, 'models'));
  await modelStore.scan();

  const trainAggregator = new TrainingAggregator(sessionsParentDir);
  const trainDatasetBuilder = new DatasetBuilder(trainingDataDir);
  const trainAdapterManager = new AdapterManager(
    path.join(adaptersDir, 'registry.json'),
    trainingDataDir,
  );
  await trainAdapterManager.init();

  const refinedStore = new RefinedDataStore(cwd);
  const refiner = new DataRefiner();
  const localModelModule = LocalModelModule.getInstance();
  if (!localModelModule.isInitialized()) {
    localModelModule.initialize(cwd);
  }
  const modelBridge = localModelModule.getBridge();
  const adapterBridge = new AdapterBridge(modelBridge, adaptersDir);

  const trainingScheduler = new TrainingScheduler({
    aggregator: trainAggregator,
    datasetBuilder: trainDatasetBuilder,
    adapterManager: trainAdapterManager,
    statsManager,
    globalDir: sessionsParentDir,
    modelStore,
    providerRouter,
    config: config.training,
    scheduleTime: config.training?.scheduleTime ?? '03:00',
    refiner,
    refinedStore,
    adapterBridge,
    cwd,
  });

  return { trainingScheduler, providerRouter };
}
