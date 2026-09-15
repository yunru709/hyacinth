// ============================================================
// UiProtocolSession — 传输无关的 UI 协议会话
// ============================================================
// 把一条 UI 连接（InProc / WebSocket / 未来渠道）接入 ui-protocol
// 协议层，屏蔽具体传输差异：
//   1. 构造：创建 UiProtocolServer + ProtocolOutputHandler +
//      注册不依赖 AgentLoop 的静态域（config/session/model/command/permission）
//   2. initialize(agentFactory)：通过 createAgent 拿到 AgentLoop，
//      注册依赖 loop 的域（message/state/schedule），attach 适配器
//
// 与旧 TuiWsSession 的区别：不再使用 WebUIOutputHandler 把回调
// 直发传输层，而是复用统一的 ui-protocol 7 域协议，使 TUI /
// WebUI / 桌面端 / 未来渠道共享同一套协议、同一套后端能力。
// 传输差异由 UIAdapter 抽象（WsAdapter / InProcAdapter）承载。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import type { UIAdapter } from '../../ui-protocol/adapter.js';
import type { AgentFactory, ChannelOutputHandler } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';
import { UiProtocolServer } from '../../ui-protocol/server.js';
import { ProtocolOutputHandler } from '../../ui-protocol/domains/message.js';
import { PendingRequestRegistry } from '../../ui-protocol/domains/permission.js';
import { createConfigDomain, type ConfigCenterLike } from '../../ui-protocol/domains/config.js';
import { createSessionDomain, type SessionManagerLike } from '../../ui-protocol/domains/session.js';
import {
  createModelDomain,
  type LocalModelOpsLike,
  type ModelRegistryLike,
  type ProviderManagerLike,
  type ProviderMetaLike,
  type ProviderView,
} from '../../ui-protocol/domains/model.js';
import { createCommandDomain, type CommandRegistryLike, type CommandExecutor } from '../../ui-protocol/domains/command.js';
import { createMessageDomain } from '../../ui-protocol/domains/message.js';
import { createStateDomain, type LoopLike } from '../../ui-protocol/domains/state.js';
import { createPermissionDomain } from '../../ui-protocol/domains/permission.js';
import { createScheduleDomain, type SchedulerLike } from '../../ui-protocol/domains/schedule.js';
import { createKbDomain, type KnowledgeBaseLike } from '../../ui-protocol/domains/kb.js';
import { createProcessDomain, type BackgroundRegistryLike } from '../../ui-protocol/domains/process.js';
import { createOrchestratorDomain, type BypassManagerLike } from '../../ui-protocol/domains/orchestrator.js';
import { createContextDomain, type ContextLoopLike, type ManifestLike } from '../../ui-protocol/domains/context.js';
import { createToolDomain, type ToolRegistryLike } from '../../ui-protocol/domains/tool.js';
import { createBundleDomain, type BundleRegistryLike } from '../../ui-protocol/domains/bundle.js';
import { createPluginDomain, type PluginStatusLike } from '../../ui-protocol/domains/plugin.js';
import { createSupervisorDomain } from '../../ui-protocol/domains/supervisor.js';
import { createArchDomain } from '../../ui-protocol/domains/arch.js';
import { createMCPDomain, type MCPSystemLike } from '../../ui-protocol/domains/mcp.js';
import { createCompanionDomain, type SceneReaderLike, type CompanionSceneMeta } from '../../ui-protocol/domains/companion.js';
import { getVoiceLibrary } from '../../companion/voice-library.js';
import { getGeneratedVoiceStore, DEFAULT_KEEP_PER_CHARACTER } from '../../companion/voice-store.js';
import { getSayHistoryStore } from '../../companion/say-history.js';
import { getSceneDir } from '../../generation/index.js';
import { getManifestLoader } from '../../hot-reload/manifest-watcher.js';
import { createLogger } from '../../logging/logger.js';
import { UI_EVENT } from '../../events.js';
import type { HistoryMessage, LocalModelEntry } from '../../ui-protocol/types.js';

const logger = createLogger('ui-protocol-session');

/** 静态后端依赖（不依赖 AgentLoop 的部分） */
export interface UiProtocolSessionBackend {
  configCenter: ConfigCenterLike;
  sessionStore: SessionManagerLike;
  registry: ModelRegistryLike;
  manager: ProviderManagerLike;
  commandRegistry: CommandRegistryLike;
  /**
   * 运行时通道注册表（loop.modelRouter 内部实例；initialize 完成后经
   * rebindRuntimeRegistry 重绑 model 域）。缺省时 model 域持续使用 registry
   * ——调用方需保证两者同源，否则协议写不作用于运行时路由。
   */
  getRuntimeRegistry?: () => ModelRegistryLike | null;
  /** 工作目录（context 域 manifest 读写 / 场景读取用；可选）。 */
  cwd?: string;
  /** 提供商元数据列表（model.listProviders 数据源，可选） */
  listProvidersMeta?: () => ProviderMetaLike[];
  /** 本地模型列表（model.listLocalModels 数据源；对应 LocalModelModule.list，可选） */
  listLocalModels?: () => LocalModelEntry[];
  /** 历史消息提供者（message.history 用；sessionId → events.jsonl 读取） */
  historyProvider?: (sessionId: string, limit?: number) => Promise<HistoryMessage[]>;
  /** 后端命令执行器（command.execute 用；缺省用内置 channel executor） */
  commandExecutor?: CommandExecutor;
  /** 本地模型配置写回调（model.setLocalConfig 用；对应 LocalModelModule / configCenter 持久化）。可选。 */
  configureLocalModel?: (config: { ollamaUrl?: string }) => void;
  /** 本地模型写操作（model.local* 用；对应 LocalModelModule 的 start/stop/switch/register/unregister/scan）。可选。 */
  localModelOps?: LocalModelOpsLike;
  /** 会话统计提供者（state.stats 用；对应 StatsManager.get(sessionDir)，可选）。 */
  statsProvider?: (sessionId: string) => Promise<unknown>;
  /** 动态获取知识库（kb 域用；对应 AgentComponents.knowledgeBase，可选）。 */
  getKb?: () => KnowledgeBaseLike | null;
  /** 动态获取上下文合成器条件开关集（kb.setZone4 同步 composer 用；对应 AgentComponents.contextComposer.activeConditions，可选）。 */
  getComposerConditions?: () => Set<string> | null;
  /** 动态获取后台进程注册表（process 域用；对应 AgentComponents.backgroundRegistry，可选）。 */
  getRegistry?: () => BackgroundRegistryLike | null;
  /** 动态获取旁路 manager（orchestrator 域用；对应 loop.bypassManager，可选）。 */
  getBypassManager?: () => BypassManagerLike | null;
  /** 热重载 watcher 健康度（supervisor 域用；对应 AgentComponents.hotReloadManager.getStatus()，可选）。 */
  getWatcherStatus?: () => import('../../ui-protocol/domains/supervisor.js').SupervisorWatchersLike | null;
  /** git 工作区摘要（supervisor 域用；由装配侧注入 GitManager 摘要闭包，可为异步，可选）。 */
  getGitSummary?: () => import('../../ui-protocol/domains/supervisor.js').SupervisorGitLike | null | Promise<import('../../ui-protocol/domains/supervisor.js').SupervisorGitLike | null>;
  /** 架构监督数据（arch 域用；对应 AgentComponents 的扩展/本体注册表，可选）。 */
  getArch?: () => import('../../ui-protocol/domains/arch.js').ArchDataLike | null;
  /** 动态获取工具注册表（tool 域用；对应 AgentComponents.toolRegistry，可选）。 */
  getToolRegistry?: () => ToolRegistryLike | null;
  /** 动态获取工具包注册表（bundle 域用；对应 AgentComponents.bundleRegistry，可选）。 */
  getBundleRegistry?: () => BundleRegistryLike | null;
  /** 动态获取 MCP 系统（mcp 域用；对应 AgentComponents.mcpSystem，可选）。 */
  getMCP?: () => MCPSystemLike | null;
  /** 动态获取陪伴会话管理器（companion 域用；对应 CompanionSessionManager，可选）。 */
  getCompanionMgr?: () => import('../../ui-protocol/domains/companion.js').CompanionMgrLike | null;
  /** 动态获取 Router 切换器（companion 域用；对应 switchRouter/getActiveRouterName，可选）。 */
  getRouterSwitcher?: () => import('../../ui-protocol/domains/companion.js').RouterSwitcherLike | null;
  /** 音色库（companion.voices/voiceBind/voiceRegister 用；缺省全局单例，可选）。 */
  getVoiceLibrary?: () => import('../../ui-protocol/domains/companion.js').VoiceLibraryLike | null;
  /** 生成语音库（companion.voiceList/voiceStats/voicePrune 用；缺省全局单例，可选）。 */
  getVoiceGenStore?: () => import('../../ui-protocol/domains/companion.js').VoiceGenStoreLike | null;
  /** 台词历史库（companion.sayHistory 用；缺省全局单例，可选）。 */
  getSayHistoryStore?: () => import('../../ui-protocol/domains/companion.js').SayHistoryStoreLike | null;
  /** 场景读取器（companion.scene 用；缺省读 ~/.agent/companion/<角色>/scene.json，可选）。 */
  getSceneReader?: () => SceneReaderLike | null;
  /** 每角色保留的生成语音条数（voicePrune 缺省；缺省 300，可选）。 */
  keepPerCharacter?: number;
  /** 生成语音可播放 URL 构造器（voiceList.url 用；缺省硬编码 /api/companion/voice/:id/file，可选）。 */
  makeVoiceUrl?: (id: string) => string;
  /** 场景图 URL 构造器（scene.imageUrl 用；缺省 /api/companion/:character/scene.png，可选）。 */
  makeSceneUrl?: (character: string) => string;
}

/**
 * manifest 适配器：把 ManifestLoader（getManifestLoader 单例）包装成
 * 协议层 ManifestLike。zone 开关落盘后由 manifest-watcher 热重载自动生效；
 * 未跑 watcher 的进程因内存对象已被修改同样即时生效。
 */
export function createManifestAdapter(cwd: string): ManifestLike {
  const loader = getManifestLoader(cwd);
  return {
    getZones() {
      const m = loader.getManifest();
      return Object.entries(m.zones)
        .map(([name, z]) => ({
          name,
          order: z.order,
          enabled: z.enabled,
          sectionCount: z.sections.length,
        }))
        .sort((a, b) => a.order - b.order);
    },
    setZoneEnabled(zone: string, enabled: boolean) {
      loader.setZoneEnabled(zone, enabled);
    },
  };
}

/**
 * 默认场景读取器：读 ~/.agent/companion/<角色>/scene.json（scene_render 产出）。
 * 文件不存在 / JSON 损坏 / 缺 signature 字段 → null（无场景，前端回落默认背景）。
 * 纯读取、无副作用；角色名安全由 getSceneDir 调用方（scene-render 规则）保证。
 */
export function createDefaultSceneReader(): SceneReaderLike {
  return {
    read(character: string) {
      try {
        const metaPath = path.join(getSceneDir(character), 'scene.json');
        if (!fs.existsSync(metaPath)) return null;
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<CompanionSceneMeta>;
        if (!raw || typeof raw.signature !== 'string') return null;
        return {
          signature: raw.signature,
          prompt: raw.prompt ?? '',
          provider: raw.provider ?? '',
          createdAt: raw.createdAt ?? '',
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * 内置默认命令执行器：识别后端命令（model/online/*、channel/*），委托真实后端来源。
 *
 * @deprecated channel/* 字符串命令分支已无 UI 客户端调用（T1/T3 收口后
 * TUI 与 WebUI 均走 model 域的 `model.*Channel` 方法），且 `command.execute`
 * 因 CommandRegistry.find 无法解析 childrenProvider 子命令 + `executeLocal`
 * 拦截而触达不到 executor（验收回执 §3.3「遗留双轨」）。保留仅兼容
 * model/online/* 与潜在旧客户端；新调用方一律使用 model 域方法。
 */
export function createBackendExecutor(
  registry: ModelRegistryLike,
  getLoop: () => LoopLike | null,
  /** 事件广播（channel/* 写分支变更后同步广播 MODEL_CHANGE，供其他 UI 刷新） */
  emit?: (type: string, payload?: unknown) => void,
): CommandExecutor {
  return (cmd, args, fullName) => {
    const name = fullName ?? cmd.name;

    // ── model/online/<provider>/<model> —— 切在线模型（与 TUI /model 同源）──
    if (name.startsWith('model/online/')) {
      const parts = name.split('/');
      if (parts.length >= 4) {
        const provider = parts[2]!;
        const model = parts[3]!;
        if (model === 'config') {
          return { ok: true, message: `Configure ${provider}: use /model settings context` };
        }
        const loop = getLoop();
        if (loop?.switchProvider) {
          return loop.switchProvider(provider, model).then(() => {
            // registry 同步是辅助：ProviderConfigLoader 未就绪时失败不阻断（loop 已真实切换）
            try {
              registry.setChannelModel('main', provider, model);
            } catch { /* 同步失败不阻断 */ }
            return { ok: true, provider, model };
          });
        }
        try {
          registry.setChannelModel('main', provider, model);
        } catch { /* 同上 */ }
        return { ok: true, provider, model };
      }
    }

    // ── channel/* —— 通道管理（委托真实 ModelChannelRegistry）──
    // 写分支变更后广播 MODEL_CHANGE（action: 'channel.*'），与 model 域的
    // model.*Channel 写方法（action: 'upsertChannel' 等）语义一致。
    if (name === 'channel/list') {
      return {
        channels: registry.listChannels(),
        roles: registry.listRoles?.() ?? {},
      };
    }
    if (name === 'channel/add') {
      const [chName, provider, model] = (args ?? '').trim().split(/\s+/).filter(Boolean);
      if (!chName) throw new Error('Usage: /channel add <name> [provider] [model]');
      registry.upsertChannel(chName, { provider, model });
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'channel.add', name: chName, provider, model });
      return { ok: true, name: chName };
    }
    if (name === 'channel/remove') {
      const chName = (args ?? '').trim();
      if (!chName) throw new Error('Usage: /channel remove <name>');
      registry.removeChannel(chName);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'channel.remove', name: chName });
      return { ok: true, name: chName };
    }
    if (name === 'channel/role') {
      const [role, channel] = (args ?? '').trim().split(/\s+/).filter(Boolean);
      if (!role || !channel) throw new Error('Usage: /channel role <role> <channel>');
      if (!registry.setRoleMapping) throw new Error('setRoleMapping not supported');
      registry.setRoleMapping(role, channel);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'channel.role', role, channel });
      return { ok: true, role, channel };
    }
    // channel/<name>/info | /model | /reset
    const m = name.match(/^channel\/([^/]+)\/(info|model|reset)$/);
    if (m) {
      const [, chName, action] = m;
      if (action === 'info') return { info: registry.getChannelInfo(chName) };
      if (action === 'model') {
        const [provider, model] = (args ?? '').trim().split(/\s+/).filter(Boolean);
        if (!provider) throw new Error(`Usage: /channel/${chName}/model <provider> [model]`);
        registry.setChannelModel(chName, provider, model);
        emit?.(UI_EVENT.MODEL_CHANGE, { action: 'channel.model', name: chName, provider, model });
        return { ok: true, name: chName, provider, model };
      }
      if (action === 'reset') {
        registry.resetChannelModel(chName);
        emit?.(UI_EVENT.MODEL_CHANGE, { action: 'channel.reset', name: chName });
        return { ok: true, name: chName };
      }
    }
    // 未识别的后端命令：标记 unsupported，避免前端误以为已执行
    return { unsupported: true, reason: 'backend-not-wired', command: name };
  };
}

/**
 * 传输无关的协议会话：把一条 UIAdapter 接入 7 域协议服务器。
 * UI 侧（TUI 本地 / WebUI / 桌面端）与后端均只通过 save 协议交互。
 */
export class UiProtocolSession {
  readonly sessionId: string;
  /** 协议服务器（已注册全部 17 域；动态域在 initialize 后生效） */
  readonly server: UiProtocolServer;
  /** 事件桥（后端 AgentLoop 回调 → 协议事件广播） */
  readonly outputHandler: ProtocolOutputHandler;
  /** 请求-应答关联表（permission + ask_user 共用） */
  readonly pending: PendingRequestRegistry;
  private adapter: UIAdapter;
  private loop: AgentLoop | null = null;
  /** createAgent 返回的完整后端组件（sessionManager/registry 等），供同进程 UI 读取 */
  private components: unknown = null;
  private historyProvider?: (sessionId: string, limit?: number) => Promise<HistoryMessage[]>;
  private statsProvider?: (sessionId: string) => Promise<unknown>;
  /** 后端依赖存档（rebindRuntimeRegistry 重绑 model 域时复用其余 options） */
  private backend: UiProtocolSessionBackend;

  constructor(adapter: UIAdapter, sessionId: string, backend: UiProtocolSessionBackend) {
    this.adapter = adapter;
    this.sessionId = sessionId;
    this.server = new UiProtocolServer();
    this.pending = new PendingRequestRegistry();
    this.historyProvider = backend.historyProvider;
    this.statsProvider = backend.statsProvider;
    this.backend = backend;

    const emit = (type: string, payload?: unknown) => this.server.broadcast(type, payload);
    this.outputHandler = new ProtocolOutputHandler(emit, this.pending);

    // 静态域：不依赖 AgentLoop
    this.server.registerDomain('config', createConfigDomain({ configCenter: backend.configCenter, emit }));
    this.server.registerDomain('session', createSessionDomain({
      sessionManager: backend.sessionStore,
      emit,
      // loop 在 initialize 后才就绪，通过闭包延迟解析（session.switch 用）
      getLoop: () => this.loop as unknown as LoopLike,
    }));
    this.registerModelDomain(backend.registry);
    this.server.registerDomain('command', createCommandDomain({
      registry: backend.commandRegistry,
      executor: backend.commandExecutor
        ?? createBackendExecutor(backend.registry, () => this.loop as unknown as LoopLike, emit),
    }));
    this.server.registerDomain('permission', createPermissionDomain({ pending: this.pending }));
    // kb / process 域：依赖 agent 组件（knowledgeBase / backgroundRegistry），
    // 由桥接层注入闭包延迟解析（initialize 后可用）。
    this.server.registerDomain('kb', createKbDomain({
      getKb: () => backend.getKb?.() ?? null,
      // setEnabled/setZone4 同步持久化 kb.enabled / kb.zone4（重启后开关保留）
      configCenter: backend.configCenter,
      // setZone4 同步 composer 运行时条件（立即生效；吸收 TUI 直连期本地补丁）
      getComposerConditions: () => backend.getComposerConditions?.() ?? null,
    }));
    this.server.registerDomain('process', createProcessDomain({ getRegistry: () => backend.getRegistry?.() ?? null }));
    // orchestrator 域：依赖 agent 组件（loop.bypassManager），由桥接层注入闭包延迟解析（initialize 后可用）。
    // orchestrator 域：优先 backend 注入（既有装配/测试提供），回退本会话
    // loop.bypassManager（initialize 后 this.loop 就绪，TUI 无需持有组件）
    this.server.registerDomain('orchestrator', createOrchestratorDomain({
      getBypassManager: () => {
        const fromBackend = backend.getBypassManager?.() ?? null;
        if (fromBackend) return fromBackend;
        const loop = this.loop as unknown as { bypassManager?: import('../../ui-protocol/domains/orchestrator.js').BypassManagerLike } | null;
        return loop?.bypassManager ?? null;
      },
    }));
    // context 域：依赖 AgentLoop（previewContextZone 组装真实 Zone 文本），延迟解析；
    // zone 开关走 ManifestLoader 适配（.agent/context-manifest.json 真实开关源）
    this.server.registerDomain('context', createContextDomain({
      getLoop: () => this.loop as unknown as ContextLoopLike,
      getManifest: () => (backend.cwd ? createManifestAdapter(backend.cwd) : null),
    }));
    // tool / bundle / mcp 域：依赖 agent 组件（toolRegistry / bundleRegistry / mcpSystem），延迟解析
    this.server.registerDomain('tool', createToolDomain({
      getToolRegistry: () => backend.getToolRegistry?.() ?? null,
      getBundleRegistry: () => backend.getBundleRegistry?.() ?? null,
    }));
    this.server.registerDomain('bundle', createBundleDomain({ getBundleRegistry: () => backend.getBundleRegistry?.() ?? null }));
    this.server.registerDomain('plugin', createPluginDomain({
      getPluginHosts: () => (this.loop?.pluginHost?.list() as unknown as PluginStatusLike[]) ?? [],
    }));
    // supervisor 域（S5 可观测面）：uptime/guardian/lastRestart 来自 supervisor/protocol
    // 契约叶；plugins 复用 plugin 域数据源；watchers/git 由 backend 可选注入。
    this.server.registerDomain('supervisor', createSupervisorDomain({
      getPluginHosts: () => (this.loop?.pluginHost?.list() as unknown as PluginStatusLike[]) ?? [],
      getWatcherStatus: () => backend.getWatcherStatus?.() ?? null,
      getGitSummary: () => backend.getGitSummary?.() ?? null,
    }));
    // arch 域（架构监督，第 20 域）：目录/名单/生效视图来自装配组件（extensionRegistry/
    // assemblyRegistry），延迟解析；toggle 写项目级名单（supervisor/extension-registry）。
    this.server.registerDomain('arch', createArchDomain({ getArch: () => backend.getArch?.() ?? null }));
    this.server.registerDomain('mcp', createMCPDomain({ getMCP: () => backend.getMCP?.() ?? null }));
    // companion 域：依赖 loop / companionMgr / routerSwitcher，延迟解析。
    // 音色库 / 生成语音库 / 台词历史 / 场景读取 / keepPerCharacter 由桥接层注入默认值
    // （全局单例 / 默认文件读取），协议层零业务依赖（P5-2）。
    this.server.registerDomain('companion', createCompanionDomain({
      getLoop: () => this.loop as unknown as import('../../ui-protocol/domains/companion.js').CompanionLoopLike,
      getCompanionMgr: () => backend.getCompanionMgr?.() ?? null,
      getRouterSwitcher: () => backend.getRouterSwitcher?.() ?? null,
      getVoiceLibrary: () => backend.getVoiceLibrary?.() ?? getVoiceLibrary(),
      getVoiceGenStore: () => backend.getVoiceGenStore?.() ?? getGeneratedVoiceStore(),
      getSayHistoryStore: () => backend.getSayHistoryStore?.() ?? getSayHistoryStore(),
      getSceneReader: () => backend.getSceneReader?.() ?? createDefaultSceneReader(),
      keepPerCharacter: backend.keepPerCharacter ?? DEFAULT_KEEP_PER_CHARACTER,
      makeVoiceUrl: backend.makeVoiceUrl ?? ((id: string) => `/api/companion/voice/${id}/file`),
      makeSceneUrl: backend.makeSceneUrl ?? ((character: string) => `/api/companion/${encodeURIComponent(character)}/scene.png`),
    }));
  }

  /**
   * 注册（或重绑）model 域。registry 缺省用 backend.registry；initialize
   * 完成后可经 rebindRuntimeRegistry 切换为 loop 运行时实例，使协议写
   * 直接作用于当前路由（registerDomain 覆盖同名域，方法表随之更新）。
   */
  private registerModelDomain(registry: ModelRegistryLike): void {
    const backend = this.backend;
    this.server.registerDomain('model', createModelDomain({
      registry,
      manager: backend.manager,
      listProvidersMeta: backend.listProvidersMeta,
      listLocalModels: backend.listLocalModels,
      configureLocalModel: backend.configureLocalModel,
      localModelOps: backend.localModelOps,
      emit: (type, payload) => this.server.broadcast(type, payload),
      // 配置中心：model.switch 是 provider 选择唯一的写入口，由它把
      // provider.active / provider.<name>.model / provider.routeMode 落盘
      // （UI 不再自行 setConfig —— 两端各写一份是历史分叉的根源）。
      configCenter: backend.configCenter,
      // 动态获取 loop：model.switch 委托 loop.switchProvider（真实来源），
      // loop 在 initialize 后才就绪，通过闭包延迟解析。
      getLoop: () => this.loop as unknown as LoopLike,
      // 动态获取活跃 Provider：model.setThinking 委托 provider.setThinking
      getActiveProvider: () => (this.loop?.getActiveProvider() as unknown as ProviderView) ?? null,
    }));
  }

  /**
   * 把 model 域的 registry 重绑到 loop 运行时实例（backend.getRuntimeRegistry）。
   * TUI 本地模式下 backend.registry 与 loop.modelRouter 内部 registry 是两个
   * 实例：不重绑则协议写只落盘不作用于运行时路由。应在 initialize 返回、
   * 调用方拿到 agent 组件后调用一次；未提供 getRuntimeRegistry 时为 no-op。
   */
  rebindRuntimeRegistry(): void {
    const runtime = this.backend.getRuntimeRegistry?.() ?? null;
    if (runtime) this.registerModelDomain(runtime);
  }

  /**
   * 通过 agentFactory 创建 AgentLoop 并注册依赖 loop 的域，
   * 然后 attach 适配器开始服务协议消息。
   */
  async initialize(agentFactory: AgentFactory): Promise<void> {
    try {
      const result = await agentFactory.createAgent({
        sessionId: this.sessionId,
        outputHandler: this.outputHandler as unknown as ChannelOutputHandler,
      });
      this.components = result;
      this.loop = (result as { loop: AgentLoop }).loop;

      // ask_user 工具 → 协议层：loop 构造时已绑定本会话 ProtocolOutputHandler.onAskUser
      // （emit message.ask_user → UI 表单 → message.askUserResolve → pending.resolve 返回）。
      // handler 按 loop 实例注入，多路 UI 并发各 loop 各答各的（不再覆盖全局单例）。

      const emit = (type: string, payload?: unknown) => this.server.broadcast(type, payload);
      // 真实运行时值：优先读 loop 内部 getter（turnNumber / contextTokensUsed），
      // 缺失时回退 0（测试 mock / 非 AgentLoop 后端）。buildStateSnapshot 内部会再次优先 getter。
      const turnCount = () => (this.loop as unknown as { turnNumber?: number })?.turnNumber ?? 0;
      const tokensUsed = () => (this.loop as unknown as { contextTokensUsed?: number })?.contextTokensUsed ?? 0;
      this.server.registerDomain('message', createMessageDomain({
        loop: this.loop as unknown as LoopLike,
        emit,
        pending: this.pending,
        turnCount,
        tokensUsed,
        historyProvider: this.historyProvider,
      }));
      this.server.registerDomain('state', createStateDomain({
        loop: this.loop as unknown as LoopLike,
        turnCount,
        tokensUsed,
        statsProvider: this.statsProvider,
        // 会话目录解析统一走后端 sessionStore（TUI 侧不再直读 SessionManager）
        sessionDirProvider: (sid) => this.backend.sessionStore.getSessionDir(sid),
      }));
      this.server.registerDomain('schedule', createScheduleDomain({
        // 调度器来自 loop.getScheduler()（真实 AgentLoop），initialize 后就绪
        getScheduler: () => {
          const loop = this.loop as unknown as { getScheduler?: () => SchedulerLike | null } | null;
          return loop?.getScheduler?.() ?? null;
        },
        // 运行时状态（schedule.runtime）读取 loop.pendingTaskName
        getLoop: () => this.loop as unknown as LoopLike,
      }));

      // model 域重绑到 loop 运行时 registry：协议写（model.*Channel / switch）
      // 直接作用于当前路由（原 rebindRuntimeRegistry 职责内聚到 initialize，
      // 调用方不再需要持有 agent 组件引用）
      const runtimeRegistry = (this.loop as unknown as {
        modelRouter?: { getRegistry(): ModelRegistryLike };
      })?.modelRouter?.getRegistry?.();
      if (runtimeRegistry) this.registerModelDomain(runtimeRegistry);

      // attach 协议服务器 → 消息自动进入 7 域路由
      this.server.attach(this.adapter);
      this.server.broadcast('ui.connected', { sessionId: this.sessionId });
      logger.info('UI protocol session initialized', { sessionId: this.sessionId });
    } catch (err) {
      logger.error('UI protocol session init failed', err instanceof Error ? err : new Error(String(err)));
      this.server.broadcast('ui.error', {
        message: `Init failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** 底层 loop（供同进程 UI 读取活跃 provider / 本地能力） */
  getLoop(): AgentLoop | null {
    return this.loop;
  }

  /** createAgent 返回的完整后端组件（SessionManager / registry / 等），供同进程 UI 直接复用 */
  getComponents<T = unknown>(): T | null {
    return this.components as T | null;
  }

  async close(): Promise<void> {
    this.adapter.close();
    this.loop = null;
  }
}