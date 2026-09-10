/**
 * assembly-graph.ts —— Agent 装配声明表（P6-0 交付物，P6 收官后为最终形态存档）。
 *
 * 定位：把装配顺序变成**可 diff 的声明数据** + 守卫测试（assembly-graph.test.ts）。
 * P6 收官后装配已声明化：factory.ts 为 34 行对外薄壳（类型 re-export + createAgent
 * 委托），编排主体在 agent-assembly.ts，组件创建在 *-contributions.ts 贡献批，
 * 接线在 *-wiring.ts。本表保留为**装配全景图**：每条目的 anchor 指向其实际落点
 * （守卫 A 扫描 factory + agent-assembly + 全部贡献批/接线模块）。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 三类依赖盘点（P6 收官后的最终处置）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 【类 1：依赖注入】—— 已落地为贡献批 needs/provides（AssemblyRunner 拓扑排序 +
 *   环检测 + 缺依赖 fail-fast）。getContent 闭包里的前向引用（session-tools 用
 *   toolRegistry 等）是**懒求值**依赖，保留闭包注入语义（与 StageServiceMap 的
 *   「每轮取当前值」同构）。
 *
 * 【类 2：配置值】—— 未服务化，随 AgentLoopConfigOptions（P6-2）留在配置层。
 *   cwd / sessionDir / personaDir / maxTurns / maxContext / dangerousTools /
 *   allowlistTools / channel / sessionId / denyTools 等字面量与策略集合。
 *
 * 【类 3：共享可变引用】—— 最终处置：懒求值容器（loopRefBox = {current}，声明期
 *   null、运行期取当前值、构造后回填——与 StageServiceMap「每轮取当前值」同构）
 *   或原位回填（registerLoopBackfill）。逐项：
 *   - loopRef → loopRefBox 容器（P6-15 规范化），wireFallbackNotifications /
 *     intent_cluster_summary 消费
 *   - kbStateRef：knowledge 贡献 provides 传出 → registerLoopBackfill 回填
 *     loop.kbState，components.kbState 共享同一引用（§5.2 收敛）
 *   - pendingAsyncResults：factory 建 → delegateTool 与 loop 共享（回填批）
 *   - bypassManager：bypass 插件 activate 注入 loop，mountBypassPlugins 取回
 *   - loop.companionVoice：generation 贡献 mount 内回填
 *   - loop.pendingImageInjections / loop.imageStore：wireReadToolImageHandler
 *   - channelLoops / channelSessions：setupChannelRegistries（globalThis 单例）
 *   - inject*ConfigCenter ×5：wireConfigCenter（config-wiring.ts）
 *   - activeProvider/模式切换等 loop 内部 getter：随 loop 一起提供
 *
 * ─────────────────────────────────────────────────────────────────────
 * 装配时序（原 factory 62+ 步压缩为 6 相；现为 agent-assembly.ts 的调用序）
 * ─────────────────────────────────────────────────────────────────────
 *   P-A 配置与基础    boot→base 批→persona/bootstrap 批→provider loader→
 *                     config-wiring 批→model catalog→fallback 接线
 *   P-B 核心服务      infra 批→channel 批→context-chain 批→toolRegistry→
 *                     orchestrator 批→core 批（stores/skills）→pluginManager 批
 *   P-C loop          AgentLoop 构造（AgentLoopServices + AgentLoopConfigOptions）
 *   P-D 插件+回填     setHooks→loadAll→plugin 贡献批（knowledge/xref/generation）
 *                     →回填批→bypass-wiring（permission-chain/bypass/world-engine）
 *                     →registerLoopDependentTools（工具批）
 *   P-E 收敛          setupChannelRegistries→scheduler handler→config 订阅→
 *                     runtime 批（bundle/hotReload）→ContextSource×11
 *   P-F 热重载+返回    hotReloadManager.start→return components
 *
 * 时序注释现状（P6 收官）：装配顺序由 agent-assembly.ts 的调用序 + 贡献批
 * needs/provides 拓扑承载；保留 2 条非缺陷时序锚（守卫 C2 监护）：
 *   「Provider Config Loader（时序锚：必须在 getDefaultConfig 之前」
 *   「不依赖 loop 的工具在 AgentLoop 之前注册」（随接线迁至 tool-registration.ts）
 */

// ─── 装配组件声明表 ────────────────────────────────────────────────────

export type AssemblyKind = 'instance' | 'plugin' | 'shared-ref' | 'phase';

/** 一个装配条目。anchor 必须是 factory.ts 中可唯一命中的文本片段（守卫用）。 */
export interface AssemblyEntry {
  id: string;
  kind: AssemblyKind;
  /** factory.ts 锚文本（守卫断言其存在；P6 迁移时随代码同步更新） */
  anchor: string;
  /** 类 1 依赖（contribute needs 候选）；'-' = 无 */
  needs: string;
  /** 产出句柄 / 注册面（contribute provides 候选）；'-' = 无 */
  provides: string;
  /** 所属相 */
  phase: 'P-A' | 'P-B' | 'P-C' | 'P-D' | 'P-E' | 'P-F';
  /** 备注：共享引用 / 懒闭包 / 插件（类 3 标记 @shared，懒求值标记 @lazy） */
  note: string;
}

export const ASSEMBLY_GRAPH: AssemblyEntry[] = [
  // ── P-A 配置与基础 ──────────────────────────────────────────────
  { id: 'configManager', kind: 'instance', anchor: 'new ConfigManager(cwd)', needs: 'cwd', provides: 'config.json 原文', phase: 'P-A', note: 'boot.ts 引导' },
  { id: 'sessionManager', kind: 'instance', anchor: 'new SessionManager(cwd)', needs: 'cwd', provides: 'sessionDir/sessionId/sessionType', phase: 'P-A', note: 'boot.ts 引导' },
  { id: 'gitManager', kind: 'instance', anchor: 'new GitManager(cwd as string)', needs: 'cwd', provides: 'turnRecorder/工具回滚', phase: 'P-A', note: 'P-A 贡献批（base-contributions.ts）' },
  { id: 'turnRecorder', kind: 'instance', anchor: 'new TurnRecorder(', needs: 'gitManager, turnStore', provides: 'rollback 记录', phase: 'P-A', note: 'P-A 贡献批（base-contributions.ts）' },
  { id: 'flowRegistry', kind: 'instance', anchor: 'new MachineRegistry()', needs: 'sessionDir(load)', provides: 'flow 注入/控制工具', phase: 'P-A', note: 'P-A 贡献批；getContextInjection 懒取' },
  { id: 'personaSetup', kind: 'instance', anchor: 'ensureGlobalPersonaFiles', needs: '-', provides: 'personaDir', phase: 'P-A', note: 'async 引导（bootstrap-wiring.ts）' },
  { id: 'providerConfigLoader', kind: 'instance', anchor: 'getProviderConfigLoader(cwd)', needs: 'cwd', provides: 'providers.json 读取', phase: 'P-A', note: '时序锚 :240' },
  { id: 'configCenter', kind: 'instance', anchor: 'RuntimeConfigCenter.getInstance()', needs: 'getDefaultConfig, configManager', provides: '全部运行时配置', phase: 'P-A', note: '全局单例 + inject×5 @shared（config-wiring.ts）' },
  { id: 'loopRef', kind: 'shared-ref', anchor: "const loopRefBox: { current: AgentLoop | null } = { current: null }", needs: 'AgentLoop', provides: 'fallback 回调/意图簇摘要/imageStore', phase: 'P-A', note: '@shared 后置回填（loopRefBox 懒求值容器）' },

  // ── P-B 核心服务 ────────────────────────────────────────────────
  { id: 'contextComposer', kind: 'instance', anchor: 'new LayeredContextComposer', needs: 'effectiveMaxContext', provides: 'ContextSource 注册面', phase: 'P-B', note: '压缩链贡献批（context-chain-contributions.ts）；门槛 2 替换件已证接口可换' },
  { id: 'contextSources', kind: 'phase', anchor: 'contextComposer.registerSource', needs: 'contextComposer + 各数据源', provides: 'env-info/channel_context/flow/memory/companion_memory/session-tools/skill-*/agent-*/intent_cluster_summary/image_store/tool-bundles', phase: 'P-B', note: '11 个源已抽离 context-sources.ts（注册顺序不影响输出）' },
  { id: 'channelRegistry', kind: 'instance', anchor: 'new ModelChannelRegistry', needs: 'config(models/local), provider', provides: '角色通道（compression/narration/orchestrator）', phase: 'P-B', note: '' },
  { id: 'modelRouter', kind: 'instance', anchor: 'new ModelRouter', needs: 'provider, config, channelRegistry', provides: '模型路由/降级链上下文', phase: 'P-B', note: '' },
  { id: 'compressor', kind: 'instance', anchor: 'new CompressorOrchestrator', needs: 'tokenCounter, summarizer, maxContext', provides: '后台/紧急压缩', phase: 'P-B', note: '压缩链贡献批' },
  { id: 'toolRegistry', kind: 'instance', anchor: 'createBuiltInTools', needs: 'gitManager, sessionId, cwd', provides: '工具注册面（全量）', phase: 'P-B', note: '注册分两批：loop 前 5 个 + loop 后 20+（时序锚 :863）' },
  { id: 'toolExecutor', kind: 'instance', anchor: 'new ToolExecutor', needs: 'toolRegistry', provides: '工具执行', phase: 'P-B', note: '' },
  { id: 'backgroundRegistry', kind: 'instance', anchor: 'new BackgroundProcessRegistry', needs: '-', provides: '异步进程工具', phase: 'P-B', note: '' },
  { id: 'stores', kind: 'phase', anchor: 'new ConversationStore', needs: 'maxMessages/cwd', provides: 'conversation/event/stats/summary/memory', phase: 'P-B', note: '5 个存储实例' },
  { id: 'skillRegistry', kind: 'instance', anchor: 'new SkillRegistry()', needs: '-', provides: 'skills 注册面', phase: 'P-B', note: '' },
  { id: 'heartbeatScheduler', kind: 'instance', anchor: 'new HeartbeatScheduler', needs: 'configCenter(schedule)', provides: '定时任务', phase: 'P-B', note: 'start 并行；handler 在 P-E 才 set' },
  { id: 'mcpSystem', kind: 'instance', anchor: 'new MCPSystem', needs: 'cwd', provides: 'MCP server 生命周期/工具', phase: 'P-B', note: 'start 并行（慢）' },
  { id: 'pluginManager', kind: 'instance', anchor: 'new PluginManager', needs: 'toolRegistry, skillRegistry, contextComposer, mcpSystem', provides: '目录插件生命周期', phase: 'P-B', note: '' },

  // ── P-C loop ────────────────────────────────────────────────────
  { id: 'orchestrator', kind: 'instance', anchor: 'new LLMOrchestrator', needs: 'provider, planStore, sessionDir, modelRouter', provides: '旁路编排', phase: 'P-C', note: '' },
  { id: 'providerRouter', kind: 'instance', anchor: 'new ProviderRouter()', needs: 'provider(+local)', provides: '主/备 Provider 路由', phase: 'P-C', note: '' },
  { id: 'agentRegistry', kind: 'instance', anchor: 'new AgentRegistry', needs: 'cwd(loadAgentConfigs)', provides: '子 Agent 系统', phase: 'P-C', note: '' },
  { id: 'delegateTool', kind: 'instance', anchor: 'new DelegateToAgentTool', needs: 'agentRegistry, modelRouter, toolRegistry, sessionDir, dependencyAnalyzer', provides: 'delegate_to_agent 工具', phase: 'P-C', note: '@shared 共享 pendingAsyncResults' },
  { id: 'loop', kind: 'instance', anchor: 'new AgentLoop({', needs: '26 字段：provider/contextComposer/compressor/orchestrator/toolExecutor/toolRegistry/conversationStore/eventStore/statsManager/sessionDir/summaryStore/maxTurns/maxContextTokens/outputHandler/skillRegistry/mcpBridge/dependencyAnalyzer/agentRegistry/personaDir/flowRegistry/providerRouter/dangerousTools/allowlistTools/configCenter/modelRouter/turnRecorder', provides: 'runTurn/插件宿主/旁路体系', phase: 'P-C', note: 'P6-2 拆分对象（~20 服务 + ~6 配置）' },

  // ── P-D 插件与后置回填 ───────────────────────────────────────────
  { id: 'dirPlugins', kind: 'plugin', anchor: 'pluginManager.setHooks', needs: 'loop(loopHooks)', provides: '目录插件钩子', phase: 'P-D', note: 'P6-1：追加注入宿主不重建（PluginHost.setHooks），时序约束消失' },
  { id: 'knowledgePlugin', kind: 'plugin', anchor: 'mount(createKnowledgePlugin', needs: 'configCenter, contextComposer, loopHooks', provides: 'knowledge.api/kbState', phase: 'P-D', note: 'mount 失败降级 idle' },
  { id: 'xrefPlugin', kind: 'plugin', anchor: 'mount(createXrefPlugin', needs: 'cwd', provides: 'xref 工具×3', phase: 'P-D', note: '' },
  { id: 'kbStateRef', kind: 'shared-ref', anchor: 'kbStateRef = kbApi?.kbState', needs: 'knowledgePlugin', provides: 'loop.kbState + components.kbState 共享引用', phase: 'P-D', note: '@shared §5.2 收敛' },
  { id: 'permissionChain', kind: 'plugin', anchor: 'mountPlugin(createPermissionChainPlugin', needs: 'loop, denyTools', provides: '安全治理层', phase: 'P-D', note: 'fail-fast：失败抛错（bypass-wiring.ts）' },
  { id: 'bypassPlugin', kind: 'plugin', anchor: 'mountPlugin(createBypassPlugin', needs: 'loop, modelRouter, memoryFilePath', provides: 'bypassManager(注入 loop)', phase: 'P-D', note: 'fail-fast（bypass-wiring.ts）' },
  { id: 'worldEngineService', kind: 'plugin', anchor: "register('world-engine.createAgent'", needs: 'worldEngine 实现类', provides: '世界引擎工厂服务', phase: 'P-D', note: '内核只供能力服务（轻量引用）；世界引擎 agent 由 companion 目录插件创建驱动（agent-assembly.ts）' },
  { id: 'generationPlugin', kind: 'plugin', anchor: 'getHost().mount(createGenerationPlugin', needs: 'cwd, configCenter', provides: 'generation.api/TTS', phase: 'P-D', note: 'TTS 回填 loop.companionVoice @shared' },
  { id: 'pluginContribBatch', kind: 'phase', anchor: 'runPluginContributions(', needs: 'pluginManager, configCenter, contextComposer, cwd, loop', provides: 'kbApi', phase: 'P-D', note: 'P6-1 装配贡献批（已外移 plugin-contributions.ts）：knowledge/xref/generation 挂载点，顺序由 needs/provides 承载' },
  { id: 'runtimeTools', kind: 'phase', anchor: 'toolRegistry.registerRuntimeControlTools', needs: 'loop, providerRouter, skillRegistry, agentRegistry, configCenter, scheduler, mcpSystem, modelRouter', provides: '30+ 运行时工具', phase: 'P-D', note: '接线抽离 tool-registration.ts（时序锚随迁）' },
  { id: 'toolBatch2', kind: 'phase', anchor: 'createTriggerCompressionTool({', needs: 'loop/flowRegistry/turnStore/agentRegistry/companionSessionManager', provides: 'compression/rollback/flow/askUser/companion 工具', phase: 'P-D', note: '接线抽离 tool-registration.ts' },
  { id: 'pendingAsyncResults', kind: 'shared-ref', anchor: 'pendingAsyncResults', needs: 'delegateTool, loop', provides: '子 Agent 结果队列', phase: 'P-D', note: '@shared 先建引用后赋 loop（:597/:700）' },
  { id: 'loopRefBackfill', kind: 'shared-ref', anchor: 'loopRefBox.current = loop', needs: 'loop', provides: 'P-A 闭包回填', phase: 'P-D', note: '@shared（loopRefBox 懒求值容器回填）' },

  // ── P-E 收敛 ────────────────────────────────────────────────────
  { id: 'channelLoops', kind: 'shared-ref', anchor: '__channelLoopRegistry', needs: 'loop', provides: '渠道感知定时任务路由', phase: 'P-E', note: '@shared globalThis 单例' },
  { id: 'channelSessions', kind: 'shared-ref', anchor: '__channelSessionRegistry', needs: 'loop', provides: '重启快照恢复', phase: 'P-E', note: '@shared globalThis 单例' },
  { id: 'bundleRegistry', kind: 'instance', anchor: 'new ToolBundleRegistry', needs: 'cwd, configCenter', provides: '工具包展开', phase: 'P-E', note: 'loop.setBundleRegistry 回填 @shared' },

  // ── P-F 热重载与返回 ────────────────────────────────────────────
  { id: 'hotReloadManager', kind: 'instance', anchor: 'new HotReloadManager', needs: 'toolRegistry, skillRegistry, agentRegistry, pluginManager, configCenter, contextComposer, mcpSystem, bundleRegistry, channelRegistry, providerConfigLoader, modelCatalog', provides: '配置/插件热重载', phase: 'P-F', note: '依赖面最大的实例（11 个）' },
];

/** 全量清单 id（守卫：唯一性） */
export const ASSEMBLY_IDS: string[] = ASSEMBLY_GRAPH.map((e) => e.id);
