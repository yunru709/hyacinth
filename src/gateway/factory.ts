import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SessionManager } from '../memory/session.js';
import { CompanionSessionManager } from '../memory/companion-session.js';
import { isCompanionModeActive, getActiveRouter, switchRouter } from '../context/profiles.js';
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
  StructuredStore,
  createStructuredTool,
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
import { ensureGlobalPersonaFiles, ensureGlobalPromptDir } from '../setup/persona-bootstrap.js';
import { ConfigManager } from '../setup/config.js';
import { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { FullConfig } from '../runtime/config-schema.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { createLogger } from '../logging/logger.js';
import { ProviderRouter } from '../provider/router.js';
import { ModelRouter } from '../provider/model-router.js';
import type { ModelsConfig, LocalModelConfig } from '../provider/model-router.js';
import { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { ScheduledTask } from '../schedule/types.js';
import { HotReloadManager } from '../hot-reload/index.js';
import { ProviderConfigLoader, getProviderConfigLoader } from '../provider/config.js';
import { ProviderManager } from '../provider/manager.js';
import { compressorUserId, orchestratorUserId, setUserIdPrefix, DEFAULT_USER_ID } from '../provider/user-id.js';
import { getModelCatalogLoader } from '../provider/model-catalog-loader.js';
import { injectConfigCenter } from '../provider/local-config.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { modelCatalog } from '../provider/catalog.js';
import { TurnRecorder, TurnStore, createRollbackStatusTool, createRollbackTool } from '../rollback/index.js';
import { MachineRegistry, TodoFlow, SpecFlow } from '../machine/index.js';
import { createAskUserTool } from '../tools/ask-user.js';
import { createFlowStartTool, createFlowAddTool, createFlowCompleteTool } from '../tools/flow.js';
import { createTriggerCompressionTool } from '../tools/compression.js';
import { BackgroundProcessRegistry } from '../tools/background-registry.js';
import { createProcessListTool, createProcessKillTool, createProcessOutputTool } from '../tools/process-tools.js';
import { createSystemInfoTool } from '../tools/system-info.js';
import { createChannelInfoTool, setChannelsInfo } from '../tools/channel-info.js';

import { collectSystemInfo, buildEnvironmentSection } from '../env/index.js';
import type { ChannelsInfo } from '../env/index.js';
import { CommandRegistry } from '../ui/command-registry.js';
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
  modelRouter: ModelRouter;
  providerConfigLoader: ProviderConfigLoader;
  knowledgeBase: KnowledgeBase;
  kbState: { lastQuery: string };
  kbWatcher: KnowledgeWatcher | null;
  /** 知识库结构化存储（懒加载，只在知识库启用时才创建） */
  structuredStore: StructuredStore | null;
  composeStrategy: ComposeStrategy;
  companionSessionManager: CompanionSessionManager;
  backgroundRegistry: BackgroundProcessRegistry;
  scheduler: HeartbeatScheduler;
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
//
// ## 组件装配原则
//
// 这是整个 Agent 的唯一装配入口。所有模块在此创建、配置、注入。
// 如果你要新增系统级组件（如新的 ContextSource、Tool、Flow）：
//
//   1. 在此文件中注册 ContextSource 到 composer（Zone 注入）
//   2. 在此文件中注册 Tool 到 toolRegistry
//   3. 在此文件中注册 Flow 到 flowRegistry
//   4. 不要在其他地方分散注册——保持单一装配点
//
// 提示词、配置均通过外部化体系加载（loadPrompt / RuntimeConfigCenter），
// 不要在工厂中硬编码任何面向模型或用户的文本内容。
//
// ─────────────────────────────────────────────────────────────────────

export async function createAgent(
  options: CreateAgentOptions,
  supervisor?: LifecycleSupervisor,
): Promise<AgentComponents> {
  const { cwd, provider, maxTurns, maxContext, outputHandler, sessionId, shouldContinue, maxMessages = 10000, personaDir, localModelProvider, channelsInfo } = options;

  // ── 配置预加载（需在 session 创建前读取 startup.defaultMode）──────
  const configManager = new ConfigManager(cwd);
  const config = await configManager.load();
  const startupMode = (config as unknown as Record<string, unknown>).startup as Record<string, unknown> | undefined;
  const defaultMode: 'normal' | 'companion' =
    startupMode?.defaultMode === 'companion' ? 'companion' : 'normal';

  // ── Session ──────────────────────────────────────────────────────
  const sessionManager = options.sessionManager ?? new SessionManager(cwd);
  let sessionDir: string;
  let currentSessionId: string;
  let sessionType: 'normal' | 'precise' | 'companion' = 'normal';

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
    // 新 session：根据 startup.defaultMode 决定初始 Router 模式
    // 注意：陪伴模式也创建 normal session，实际 session 切换由 CompanionRouter.onActivate 负责
    const session = await sessionManager.create('normal', options.channel);
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = defaultMode;
    logger.info('New session', { sessionId: session.id, channel: options.channel, defaultMode: sessionType });
  }

  // ── Git 基础设施 ──────────────────────────────────────────────────
  const gitManager = new GitManager(cwd);

  // ── 回合回滚 ──────────────────────────────────────────────────────
  const rollbackDir = path.join(os.homedir(), '.agent', 'rollback');
  const turnStore = new TurnStore(rollbackDir);
  const turnRecorder = new TurnRecorder(gitManager, turnStore, cwd);

  // ── 状态机注册表（机器在 persona 初始化后注册） ────────────────
  const flowRegistry = new MachineRegistry();

  // ── Global Persona Bootstrap ──────────────────────────────────────
  const personaSetup = await ensureGlobalPersonaFiles();
  const effectivePersonaDir = personaDir ?? personaSetup.personaDir;

  // ── 内置 Prompt 同步 ─────────────────────────────────────────────
  // 将所有内置 prompt 同步到 ~/.agent/prompts/ 下，
  // 使得 loadPrompt() 的查找优先级正确：外部覆盖 > 内置兜底。
  await ensureGlobalPromptDir('attention');
  await ensureGlobalPromptDir('tools');
  await ensureGlobalPromptDir('agents');
  await ensureGlobalPromptDir('flows');
  await ensureGlobalPromptDir('skills');
  await ensureGlobalPromptDir('precise');
  await ensureGlobalPromptDir('environment');
  // root 级文件 summary.md 由 loadPrompt 递归搜索找到，暂不单独同步

  // ── 注册 Flow（TODO + Spec）────────────────────────────────
  flowRegistry.register(new TodoFlow());
  flowRegistry.register(new SpecFlow());

  // ── Provider Config Loader（必须在 getDefaultConfig 之前，确保 providerDefault 读到 JSON） ──
  const providerConfigLoader = getProviderConfigLoader(cwd);
  await providerConfigLoader.load();

  // ── Runtime Config Center ──────────────────────────────────────────
  const configCenter = RuntimeConfigCenter.getInstance();
  configCenter.initialize(getDefaultConfig(), configManager);
  configCenter.merge(config as unknown as Partial<FullConfig>);

  // 同步 userId 前缀到 user-id 模块（后续所有 userId 生成使用此前缀）
  setUserIdPrefix(configCenter.get<string>('provider.userId') ?? DEFAULT_USER_ID);

  // 注入 configCenter 到 local-config 模块，此后所有本地模型配置读取统一走 configCenter
  injectConfigCenter(configCenter);

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

  // 初始化渠道信息缓存（供 channel_info 工具查询）
  setChannelsInfo(channelsInfo ?? []);

  // ── 渠道上下文（告诉模型当前在哪个渠道、哪个 session） ──────────────
  const currentChannel = options.channel;
  const currentSessionIdForCtx = currentSessionId;
  contextComposer.registerSource({
    name: 'channel_context',
    strategy: 'always_inline',
    cacheability: 'live',
    description: '当前渠道和会话上下文',
    getContent: () => {
      if (!currentChannel) return '';
      return `You are currently communicating via **${currentChannel}** channel (session: ${currentSessionIdForCtx.slice(0, 20)}...).`;
    },
  });

  // ── Flow 注入（Zone 5 flow_injection section）─────────────────────
  contextComposer.registerSource({
    name: 'flow',
    strategy: 'always_inline',
    cacheability: 'live',
    description: 'Flow 步骤注入（当前活跃 Flow 的步骤提示词）',
    getContent: () => {
      const active = flowRegistry.getActive();
      return active?.getInjection() ?? '';
    },
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

  // ── 陪伴模式 Memory ──────────────────────────────────────────────────
  // 从角色目录动态读取（~/.agent/companion/<name>/memory.md），
  // 不同角色各自独立的记忆文件。
  contextComposer.registerSource({
    name: 'companion_memory',
    strategy: 'always_inline',
    cacheability: 'manifest',
    description: '陪伴模式专属记忆（按角色隔离）',
    getContent: () => {
      const router = getActiveRouter();
      const name = (router as unknown as Record<string, unknown>)?.activeCompanionName;
      if (typeof name !== 'string' || !name) return '';
      const file = path.join(os.homedir(), '.agent', 'companion', name, 'memory.md');
      try {
        const content = fs.readFileSync(file, 'utf-8');
        return content.trim()
          ? `<!-- 陪伴角色记忆（${name}）-->\n\n${content}`
          : '';
      } catch {
        return ''; // 文件不存在，无记忆
      }
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
      return names.length > 0 ? `[Hot-added tools (session-scoped, additional to standard tools)]\n${names.join(', ')}` : '';
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
  // ── 创建各角色专用通道（独立 userId 实现 KVCache 隔离） ────────────
  // 每个角色有独立的 KVCache 池，避免压缩/旁路/旁白等场景污染主对话缓存
  // 同时为子Agent 工厂提取必要的配置
  let subProviderApiKey: string | undefined;
  let subProviderBaseType: string | undefined;
  let subProviderModel: string | undefined;
  let bypassProvider: Provider | undefined;
  try {
    if (providerActive) {
      const provLoader = getProviderConfigLoader(cwd);
      const envKey = provLoader.getProvider(providerActive as import('../types.js').ProviderType)?.envKey;
      const apiKey = envKey ? process.env[envKey] : undefined;
      if (apiKey) {
        const model = provider.getModel();
        const baseType = providerActive as import('../types.js').ProviderType;

        // 保存供子Agent 工厂使用
        subProviderApiKey = apiKey;
        subProviderBaseType = baseType;
        subProviderModel = model;

        // 压缩器：独立 Provider（可能与主Agent/旁路并发运行）
        const compressorProvider = ProviderManager.createProviderFromConfig({
          type: baseType, apiKey, model, userId: compressorUserId(),
        });
        compressorProvider.setThinking?.(false);
        channelRegistry.upsertChannel('compression', { provider: providerActive, model });
        channelRegistry.setChannelProvider('compression', compressorProvider);
        channelRegistry.setRoleMapping('compression', 'compression');

        // 旁路Agent（narration + orchestrator）：共享一个 Provider，模式切换时 setUserId
        bypassProvider = ProviderManager.createProviderFromConfig({
          type: baseType, apiKey, model,
          userId: orchestratorUserId(),  // 默认普通模式
        });
        bypassProvider.setThinking?.(false);
        for (const channel of ['narration', 'orchestrator']) {
          channelRegistry.upsertChannel(channel, { provider: providerActive, model });
          channelRegistry.setChannelProvider(channel, bypassProvider);
          channelRegistry.setRoleMapping(channel, channel);
        }
      }
    }
  } catch {
    // 通道创建失败不影响主流程
  }
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
  // 环境信息按需查询工具（替代 Zone 1 静态注入）
  toolRegistry.register(createSystemInfoTool());
  toolRegistry.register(createChannelInfoTool());
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

  // ── 定时任务调度器（提前构造，start 放入并行块）───────────────────
  const persistedSchedule = configCenter.get('schedule') as Record<string, unknown> | undefined;
  const scheduleConfig = persistedSchedule ?? config.schedule;
  const heartbeatScheduler = new HeartbeatScheduler(undefined, scheduleConfig as any);
  heartbeatScheduler.subscribeConfig(configCenter);

  // ── MCP 系统 + 独立初始化（并行） ──────────────────────────────────
  const mcpSystem = new MCPSystem({ cwd });

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

  // ── 插件系统（依赖 MCP 就绪）───────────────────────────────────────
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

  // ── Provider 路由 ──────────────────────────────────────────────────
  const providerRouter = new ProviderRouter();
  providerRouter.register('main', provider);
  if (localModelProvider) {
    providerRouter.register('local', localModelProvider);
  }

  // ── Xref 交叉引用工具（AST 解析 + SQLite 索引） ─────────────────────
  // 注册链：
  //   XrefManager.init(rootDir) → ~/.agent/cache/xref-<projectKey>.sqlite
  //   → XrefBuildTool/XrefQueryTool/XrefGraphTool → toolRegistry
  //   解析器: TypeScript Compiler API (ts.createSourceFile) + 正则回退
  try {
    const { XrefManager, XrefBuildTool, XrefQueryTool, XrefGraphTool } = await import('../tools/xref/index.js');
    const xrefManager = new XrefManager();
    await xrefManager.init(cwd);
    toolRegistry.register(new XrefBuildTool(xrefManager));
    toolRegistry.register(new XrefQueryTool(xrefManager));
    toolRegistry.register(new XrefGraphTool(xrefManager));
  } catch {
    // xref 工具注册失败不影响核心功能（如 better-sqlite3 不可用等）
  }

  // ── 子 Agent 系统 ─────────────────────────────────────────────────
  const agentRegistry = new AgentRegistry();
  const agents = await loadAgentConfigs(cwd, config.agents);
  for (const agent of agents) {
    agentRegistry.register(agent);
  }
  // 异步子Agent 结果队列——先创建引用，后续赋给 loop
  const pendingAsyncResults: Array<{ handle: string; agentName: string; status: 'completed' | 'failed'; result?: string; error?: string }> = [];

  const delegateTool = new DelegateToAgentTool(agentRegistry, {
    modelRouter,
    toolRegistry,
    sessionDir,
    maxContextTokens: maxContext,
    dependencyAnalyzer,
    pendingAsyncResults,
    createSubProvider: (userId: string) => {
      if (!subProviderApiKey || !subProviderBaseType) {
        throw new Error('Cannot create sub-agent provider: main provider not configured.');
      }
      return ProviderManager.createProviderFromConfig({
        type: subProviderBaseType as import('../types.js').ProviderType,
        apiKey: subProviderApiKey,
        model: subProviderModel ?? '',
        userId,
      });
    },
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

  // ── 知识库（Zone 4，默认关闭）───────────────────────────────────────
  const kbDir = path.join(os.homedir(), '.agent', 'knowledge');
  const kbStorePath = path.join(kbDir, 'kb.sqlite');

  // 结构化存储 — 懒加载（不启用知识库时不创建，避免缺少 better-sqlite3 时报错）
  let _structuredStore: StructuredStore | null = null;
  function getStructuredStore(): StructuredStore {
    if (!_structuredStore) {
      _structuredStore = new StructuredStore(kbStorePath);
    }
    return _structuredStore;
  }

  // 旧版文件索引（保留兼容）
  const kbFilesDir = path.join(kbDir, 'files');
  fs.mkdirSync(kbFilesDir, { recursive: true });
  const knowledgeBase = new KnowledgeBase(kbStorePath);
  const kbState = { lastQuery: '' };

  // 从 config 恢复 KB/Zone4 状态（持久化）
  if (configCenter.get<boolean>('kb.enabled')) {
    knowledgeBase.enable();
  }
  if (configCenter.get<boolean>('kb.zone4')) {
    knowledgeBase.setZone4Enabled(true);
    contextComposer.activeConditions.add('zone4_enabled');
  }

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
      return getStructuredStore().formatResults(
        getStructuredStore().search(q, maxTotal),
        maxMain,
        maxRefs,
      );
    },
  });
  toolRegistry.register(createKbToggleTool(knowledgeBase, contextComposer));
  // 结构化知识库工具（4合1：add/update/delete/list）
  toolRegistry.register(createStructuredTool(getStructuredStore, () => knowledgeBase.enabled));

  // ── 知识库文件监控（后台自动索引 files/ 目录变更）─────────────────
  // 懒创建 — 只在知识库启用后才启动
  let _kbWatcher: KnowledgeWatcher | null = null;
  function getWatcher(): KnowledgeWatcher {
    if (!_kbWatcher) {
      _kbWatcher = new KnowledgeWatcher({
        filesDir: kbFilesDir,
        retriever: knowledgeBase.retriever,
      });
      _kbWatcher.start().catch(() => {});
    }
    return _kbWatcher;
  }

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
    flowRegistry,
    providerRouter,
    new Set(config.safety?.dangerousTools ?? ['write', 'bash']),
    new Set(),
    configCenter,
    modelRouter,
    turnRecorder,
  );

  // 注入知识库状态引用
  loop.kbState = kbState;
  loop.pendingAsyncResults = pendingAsyncResults; // 异步子Agent结果队列（和 delegateTool 共享引用）
  loopRef = loop; // wire fallback notification

  // 注入旁路 Provider 引用（供模式切换时 setBypassUserId 使用）
  if (bypassProvider) loop.setBypassProvider(bypassProvider);

  // 注册后台进程注册表到 LifecycleSupervisor（优雅关闭时自动清理）
  if (supervisor) {
    supervisor.registerBackgroundRegistry(backgroundRegistry);
  }

  // ── 陪伴模式 Session 管理（全局单例，所有渠道共享） ──────────────
  const companionSessionManager = CompanionSessionManager.getInstance();

  // 注入精确模式策略（默认普通模式）
  const composeStrategy = sessionType === 'precise'
    ? new PreciseStrategy(sessionDir)
    : new DefaultStrategy();
  loop.composeStrategy = composeStrategy;

  // 启动时恢复陪伴模式 Router + 上次角色名（session 切换由 syncRouter 首次调用触发）
  if (sessionType === 'companion') {
    const companionRouter = switchRouter('companion');
    try {
      const last = fs.readFileSync(
        path.join(os.homedir(), '.agent', 'companion', '.last-character'), 'utf-8'
      ).trim();
      if (last) (companionRouter as unknown as Record<string, unknown>).activeCompanionName = last;
    } catch {}
  }

  // ── 旁路Agent 管理器 ──────────────────────────────────────────
  const bypassManager = new (await import('../bypass/manager.js')).BypassManager();
  bypassManager.setModelRouter(modelRouter);
  // 注册 WorldEngine（陪伴模式旁路Agent）— 未设置角色时跳过
  const companionCharName = (() => {
    try {
      const last = fs.readFileSync(
        path.join(os.homedir(), '.agent', 'companion', '.last-character'), 'utf-8'
      ).trim();
      return last || '';
    } catch { return ''; }
  })();
  if (companionCharName) {
    bypassManager.register(new (await import('../bypass/agents/companion/index.js')).WorldEngine(companionCharName));
  }
  // 注册 Orchestrator（普通模式旁路Agent）— 已暂停（2026-07-10）
  // 待分层过滤策略成熟后重新启用，设计方案见：桌面/旁路Agent重构构想.md
  // bypassManager.register(new (await import('../bypass/agents/orchestrator/index.js')).ContextOrchestrator(memoryFilePath));
  loop.bypassManager = bypassManager;

  // 陪伴模式启动时自动激活 world-engine
  if (sessionType === 'companion' && companionCharName) {
    bypassManager.activateForMode('companion').catch(() => {});
  }

  // 普通模式：orchestrator 已暂停，不再激活
  // if (sessionType === 'normal') {
  //   const orchestratorEnabled = configCenter.get<boolean>('bypass.orchestratorEnabled') ?? true;
  //   if (orchestratorEnabled) {
  //     bypassManager.activateAgent('orchestrator').catch(() => {});
  //   }
  // }

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
  // registerRuntimeControlTools 内有 switch_provider / set_mode 等 30+ 工具依赖 loop 实例
  toolRegistry.registerRuntimeControlTools(loop, providerRouter, skillRegistry, agentRegistry, configCenter, cwd, heartbeatScheduler, mcpSystem, modelRouter);
  toolRegistry.register(createTriggerCompressionTool(loop));

  // destroy_sub_agent 需要 sessionDir，在此单独注册
  const { createDestroySubAgentTool } = await import('../tools/runtime-control.js');
  toolRegistry.register(createDestroySubAgentTool(agentRegistry, sessionDir));

  // ── 陪伴模式工具注册 ──────────────────────────────────────────────
  const { createCompanionModeTool, createResetCompanionSessionTool } = await import('../tools/runtime-control.js');
  toolRegistry.register(createCompanionModeTool(loop, companionSessionManager));
  toolRegistry.register(createResetCompanionSessionTool(loop, companionSessionManager));

  // ── 回合回滚工具 ──
  toolRegistry.register(createRollbackStatusTool(turnStore, () => loop.turnNumber));
  toolRegistry.register(createRollbackTool(turnStore, gitManager, () => loop.turnNumber));

  // ── Flow 控制工具 ──
  toolRegistry.register(createFlowStartTool(flowRegistry));
  toolRegistry.register(createFlowAddTool(flowRegistry));
  toolRegistry.register(createFlowCompleteTool(flowRegistry));

  // ── 用户交互工具 ──
  toolRegistry.register(createAskUserTool());

  // 注册 MCP 状态变更回调 — 消息通过 ContextSource (runtime:mcp_status) 自动注入 Zone 5，
  // 此处仅保留日志记录（未来可扩展为 TUI 状态栏更新）
  mcpSystem.onStatusChange(({ type, name, tools }) => {
    logger.info(`MCP status: ${type}`, { name, tools: tools?.join(',') });
  });

  loop.setScheduler(heartbeatScheduler);

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
  // 主 loop 注册为 'tui'（TUI 本地模式的默认渠道）
  channelLoops.set('tui', loop);

  /** 按降级链查找第一个在线的渠道 Loop */
  const resolveChannelLoop = (task: ScheduledTask) => {
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
    return { loop, channel: 'tui', level: 'last-resort' as const };
  };

  // 定时任务处理器：任务触发时根据 channel + 降级链路由到对应渠道的 Loop
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
      const { exec } = await import('node:child_process');
      exec(task.action.target, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) logger.error(`Task command failed: ${task.name}`, err, { stderr: stderr.trim() });
        else logger.info(`Task command OK: ${task.name}`, { stdout: stdout.trim() });
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
  // 上下文注册链路：
  //   manifest-defaults.ts Zone 1 → tool_bundles section (runtime:tool_bundles)
  //     → section-resolver.ts resolveRuntime() → ctx.sources.get('tool-bundles')
  //       → 本文件（ContextSource 注册，getContent 闭包）
  //         → src/tools/bundle-registry.ts (ToolBundleRegistry，持久化到 ~/.agent/tool-bundles.json)
  // 工具过滤链路：
  //   loop.ts runTurn() → bundleRegistry.getActiveToolNames() → 过滤 toolDefinitions
  const bundleRegistry = new ToolBundleRegistry(cwd);
  registerBundleTools(toolRegistry, bundleRegistry);

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
      const statusLine = bundleRegistry.isAllMode()
        ? '当前状态: 全量模式 — 所有工具均可用'
        : `当前激活: ${[...activeNames].join(', ')}`;
      return `${statusLine}\n\n${lines.join('\n')}`;
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
  // 清除上一 session 可能残留的热插拔标记，确保重启后工具归位 Zone 2
  toolRegistry.clearHotAdded();

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
    modelRouter,
    providerConfigLoader,
    knowledgeBase,
    kbState,
    kbWatcher: _kbWatcher,
    structuredStore: _structuredStore,
    composeStrategy,
    companionSessionManager,
    backgroundRegistry,
    scheduler: heartbeatScheduler,
    channelLoops,
  };
}
