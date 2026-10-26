// ============================================================
// UiProtocolSession — 传输无关的 UI 契约会话
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
import os from 'node:os';
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
import { createModeDomain, type ModeLoopLike } from '../../ui-protocol/domains/mode.js';
import { createScheduleDomain, type SchedulerLike } from '../../ui-protocol/domains/schedule.js';
import { createKbDomain, type KnowledgeBaseLike } from '../../ui-protocol/domains/kb.js';
import { createProcessDomain, type BackgroundRegistryLike } from '../../ui-protocol/domains/process.js';
import { createOrchestratorDomain, type BypassManagerLike } from '../../ui-protocol/domains/orchestrator.js';
import { createContextDomain, type ContextLoopLike, type ManifestLike } from '../../ui-protocol/domains/context.js';
import { createToolDomain, type ToolRegistryLike } from '../../ui-protocol/domains/tool.js';
import { createSkillDomain, type SkillRegistryLike } from '../../ui-protocol/domains/skill.js';
import { createBundleDomain, type BundleRegistryLike } from '../../ui-protocol/domains/bundle.js';
import { createPluginDomain, type PluginStatusLike } from '../../ui-protocol/domains/plugin.js';
import { createSupervisorDomain } from '../../ui-protocol/domains/supervisor.js';
import { createArchDomain } from '../../ui-protocol/domains/arch.js';
// 联动段的渲染与快照读取（纯函数 + 只读快照，无副作用；分层若不允由 verify:layers 报出）
import { readSnapshot, formatLinksSection } from '../../utils/reference-analysis-state.js';
import { createMCPDomain, type MCPSystemLike } from '../../ui-protocol/domains/mcp.js';
import { createCompanionDomain, type SceneReaderLike, type CompanionSceneMeta } from '../../ui-protocol/domains/companion.js';
import { createPreviewDomain, type PreviewServiceLike } from '../../ui-protocol/domains/preview.js';
import { createSttDomain } from '../../ui-protocol/domains/stt.js';
import { createTtsDomain } from '../../ui-protocol/domains/tts.js';
import { getSttService } from '../../stt/index.js';
import { getTtsService, listVoices } from '../../tts/cosyvoice.js';
// 引擎清单与切换：设置页/TUI 的「say 接哪个引擎」（voice.tts.engine）数据源
import { getTtsEngine, listAvailableEngines } from '../../tts/index.js';
import { voicesDir } from '../../tts/voice-dir.js';
import { getVoiceLibrary } from '../../companion/voice-library.js';
import { getGeneratedVoiceStore, DEFAULT_KEEP_PER_CHARACTER } from '../../companion/voice-store.js';
import { getSayHistoryStore } from '../../companion/say-history.js';
import { getSceneDir, getSceneRoot } from '../../generation/index.js';
import { watchCompanionScenes, type CompanionSceneWatchHandle } from './companion-scene-watch.js';
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
  /**
   * 本 UI 会话承载的**会话归属渠道**（决定 Agent 会话的前缀、meta.channel
   * 以及「按渠道恢复」的键）。缺省 'webui'（WebUI / 浏览器端，与 http-webhook 同源）。
   * **TUI 本地模式必须显式传 'tui'**：此前这里对 TUI 与 WebUI 一律硬编码 'webui'，
   * TUI 的会话因此被贴成 webui_ 前缀（标签漂移）—— 重启快照的键（注册表里存 'webui'）
   * 与 cli.ts 的 launchChannel（'tui'）对不上、且 TUI 进程内没有登记 webui_ 前缀
   * （meta.channel 反解失败）⇒ TUI 恢复不到自己的会话 ⇒ 每次重启都新开会话。
   * 2026-09-17「跨渠道串台」事故的直接成因。
   */
  channel?: string;
  /** 懒登记会话（见 AgentFactory.createAgent.lazySession）：只记 id 与路径，不建目录不写文件 */
  lazySession?: boolean;
  /**
   * 会话占用表（多标签互斥）。装配侧传进程级实例；
   * 未传时不做占用校验（TUI 本地路径行为零变更）。
   */
  claims?: import('../../ui-protocol/domains/session.js').SessionClaimPort;
  /** 本连接的占用令牌（每条 UI 连接唯一） */
  claimOwner?: string;
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
  /**
   * 把 provider 的 API Key 落进 `~/.agent/.env`（对应 ConfigManager.saveApiKey）。
   * 可选：装配侧不传时，model.upsertChannel 只写 channel（旧行为）。
   * 传了才能让「WebUI 配置密钥」与「TUI 配置密钥」落在同一处、彼此可见。
   */
  persistApiKey?: (provider: string, apiKey: string) => void | Promise<void>;
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
  /** 联动清单的声明态文本（可选；由 gateway 后端提供 —— 协议层不得直连 supervisor） */
  getToolLinks?: () => string | null;
  /** 动态获取工具注册表（tool 域用；对应 AgentComponents.toolRegistry，可选）。 */
  getToolRegistry?: () => ToolRegistryLike | null;
  /** 动态获取技能注册表（skill 域用；对应 AgentComponents.skillRegistry，可选）。 */
  getSkillRegistry?: () => SkillRegistryLike | null;
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
  /**
   * STT 引擎（stt 域用）：进程级单例（getSttService），模型/识别器只初始化一次。
   * 可选：缺省即单例，预留多引擎/测试注入位。
   */
  getSttEngine?: () => import('../../ui-protocol/domains/stt.js').SttEngineLike | null;
  /** TTS 服务（tts 域用）：CosyVoice3 单例（模型下载/python 服务/合成）。 */
  getTtsService?: () => import('../../ui-protocol/domains/tts.js').TtsServiceLike | null;
  /**
   * 目录插件管理面（plugin.listDirectory/activate/deactivate/reload 用）：装配侧把
   * PluginManager 映射成窄形状注入（manifest 字段拍平 + PluginManager 方法直通）。
   * 可选：未注入时目录插件查询返回空、写操作报错（fail-closed）。
   */
  getDirectoryPlugins?: () => import('../../ui-protocol/domains/plugin.js').PluginManagerLike | null;
  /**
   * 文件预览服务（preview 域用）：与 gateway/preview-routes 的 HTTP 路由共享
   * 同一实例（根状态只有一份）。fs 安全校验全在服务里，协议域零 fs 依赖。
   * 可选：未装配时 preview.* 报"服务未装配"（TUI 无预览栏，不传即可）。
   */
  previewService?: () => PreviewServiceLike | null;
  /**
   * 预览原始字节 URL 签发器（preview.read 的 url 字段 / preview.rawUrl 用）。
   * 契约层签发地址、前端不硬编码 HTTP 路径（与 makeVoiceUrl/makeSceneUrl 同一
   * 模式）。缺省相对路径 /api/fs/raw?path=…；带钥匙部署时应由装配侧覆盖以
   * 嵌入 ?token=（<img>/<iframe> 无法带 Authorization 头）。
   */
  makePreviewRawUrl?: (rel: string) => string;
  /**
   * 连接是否来自回环（preview.browse / preview.setRoot 仅限本机，与 HTTP 路由
   * 同一安全边界）。缺省 false = fail-closed：装配侧不确定时一律拒绝。
   */
  previewLoopback?: boolean;
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
              registry.setChannelModel('chat', provider, model);
            } catch { /* 同步失败不阻断 */ }
            return { ok: true, provider, model };
          });
        }
        try {
          registry.setChannelModel('chat', provider, model);
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
  readonly sessionId: string | undefined;
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
  /** 陪伴场景目录监视句柄（scene_render 落盘 → COMPANION_SCENE 事件；close 时释放） */
  private sceneWatch: CompanionSceneWatchHandle | null = null;
  /** 本连接当前占用的 sessionId（switch 后更新；close 时释放） */
  private claimedSessionId: string | null = null;

  constructor(adapter: UIAdapter, sessionId: string | undefined, backend: UiProtocolSessionBackend) {
    this.adapter = adapter;
    this.sessionId = sessionId;
    this.claimedSessionId = sessionId ?? null;
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
      // 占用表：连接级互斥（每个标签各自持有一条连接，同一会话只能被一条连接占用）
      claims: backend.claims,
      claimOwner: backend.claimOwner,
      getClaimedSessionId: () => this.claimedSessionId,
      setClaimedSessionId: (id: string) => { this.claimedSessionId = id; },
    }));
    this.registerModelDomain(backend.registry);
    this.server.registerDomain('command', createCommandDomain({
      registry: backend.commandRegistry,
      executor: backend.commandExecutor
        ?? createBackendExecutor(backend.registry, () => this.loop as unknown as LoopLike, emit),
    }));
    this.server.registerDomain('permission', createPermissionDomain({ pending: this.pending }));
    // mode 域：会话级执行模式（权限档位 / goal）。loop 在 initialize 后才就绪 ⇒ 闭包延迟解析。
    this.server.registerDomain('mode', createModeDomain({
      getLoop: () => this.loop as unknown as ModeLoopLike,
    }));
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
    // skill 域：技能列表 / 详情 / 启停。禁用列表落 skills.disabled（重启保留），
    // 与 toggle_skill 工具共用同一份配置真源。
    this.server.registerDomain('skill', createSkillDomain({
      getSkillRegistry: () => backend.getSkillRegistry?.() ?? null,
      persistDisabled: async (names) => {
        const cc = backend.configCenter as ConfigCenterLike & { save?: () => void | Promise<void> };
        cc.set('skills.disabled', names);
        await cc.save?.();
      },
    }));
    this.server.registerDomain('bundle', createBundleDomain({ getBundleRegistry: () => backend.getBundleRegistry?.() ?? null }));
    this.server.registerDomain('plugin', createPluginDomain({
      getPluginHosts: () => (this.loop?.pluginHost?.list() as unknown as PluginStatusLike[]) ?? [],
      // 目录插件管理面（PluginManager 映射）：initialize 后 agentComponents 就绪，
      // 闭包延迟解析；未接入的通道（如 TUI 未传）查询返回空、写操作报错。
      getDirectoryManager: () => backend.getDirectoryPlugins?.() ?? null,
    }));
    // stt 域（语音转文字）：引擎是进程级单例（模型/识别器只初始化一次，多会话
    // 复用），与 getVoiceLibrary 同一注入模式 —— backend 可选覆盖，缺省用单例。
    this.server.registerDomain('stt', createSttDomain({
      getEngine: () => backend.getSttEngine?.() ?? getSttService(),
      getMirrorPref: () => {
        try { const v = backend.configCenter?.get('models.mirror'); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
      },
      emit: (type, payload) => this.server.broadcast(type, payload),
    }));
    // tts 域（语音合成）：CosyVoice3 本地推理服务（python 子进程），同为进程级单例；
    // 下载源偏好与 stt 共用 config models.mirror（经 getMirrorPref 同步到引擎）。
    // voices（音色目录）与 say（播报配置 voice.say.*）服务 say-voice 插件的 UI 面。
    this.server.registerDomain('tts', createTtsDomain({
      getService: () => backend.getTtsService?.() ?? getTtsService(),
      getMirrorPref: () => {
        try { const v = backend.configCenter?.get('models.mirror'); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
      },
      getVoices: () => listVoices(),
      getVoicesDir: () => voicesDir(),
      // ── 「say 接哪个引擎」（voice.tts.engine）──────────────────────
      // 清单由 TTS 工厂给出：每个实现自报 capabilities（emotion/speed/voice 支不支持）
      // 与 ready（模型在不在），UI 据此置灰。切换只写配置；工厂按配置指纹重建实例，
      // 下一回合 say 取引擎时自动换过去，不需要重启进程。
      listEngines: () => {
        const cc = backend.configCenter;
        return listAvailableEngines({
          get<T>(k: string): T | undefined {
            try { return cc?.get<T>(k); } catch { return undefined; }
          },
        });
      },
      getEngineKind: () => {
        try {
          const v = backend.configCenter?.get('voice.tts.engine');
          return typeof v === 'string' && v ? v : 'cosyvoice3';
        } catch { return 'cosyvoice3'; }
      },
      setEngineKind: (kind) => {
        const cc = backend.configCenter;
        if (!cc) throw new Error('config center not available');
        cc.set('voice.tts.engine', kind);
        // 与 setSayConfig 同语义：写后持久化（fire-and-forget，失败留痕不阻断）
        const save = (cc as { save?: () => Promise<void> }).save;
        if (save) void save.call(cc).catch((err) => console.error('[ui-protocol] voice.tts.engine persist failed:', err));
      },
      // 试听走「当前选中引擎」：切到在线/本地 GGUF 后，设置页试听要听到那家的声音。
      // 不这么做的话，UI 显示已切换、点试听却还是 CosyVoice3 ⇒ 界面对了行为没对。
      synthesizeViaEngine: (text, opts) => {
        const cc = backend.configCenter;
        const reader = {
          get<T>(k: string): T | undefined {
            try { return cc?.get<T>(k); } catch { return undefined; }
          },
        };
        return getTtsEngine(reader).synthesize(text, opts);
      },
      getSayConfig: () => {
        try {
          const cc = backend.configCenter;
          return {
            broadcast: cc?.get<boolean>('voice.say.broadcast') === true,
            voice: typeof cc?.get<string>('voice.say.voice') === 'string' ? cc.get<string>('voice.say.voice')! : '',
          };
        } catch { return { broadcast: false, voice: '' }; }
      },
      setSayConfig: (cfg) => {
        const cc = backend.configCenter;
        if (!cc) throw new Error('config center not available');
        if (typeof cfg.broadcast === 'boolean') cc.set('voice.say.broadcast', cfg.broadcast);
        if (typeof cfg.voice === 'string') cc.set('voice.say.voice', cfg.voice);
        // 与 config 域 set 同语义：写后持久化（fire-and-forget，失败留痕不阻断）
        const save = (cc as { save?: () => Promise<void> }).save;
        if (save) void save.call(cc).catch((err) => console.error('[ui-protocol] voice.say persist failed:', err));
      },
      emit: (type, payload) => this.server.broadcast(type, payload),
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
    this.server.registerDomain('arch', createArchDomain({
      getArch: () => backend.getArch?.() ?? null,
      // 联动段：读引用自检的运行态快照并渲染（快照由能力在每次分析后 best-effort 写入）。
      // 插件启用态此处传 null ⇒ 渲染为"状态未知"，不猜；能力是否注册以快照的 registered 为准。
      // 声明态（backend 提供；未提供则只剩运行态）+ 运行态（本地快照）
      getLinks: () =>
        [backend.getToolLinks?.(), formatLinksSection(readSnapshot(), null)]
          .filter(Boolean)
          .join('\n\n'),
    }));
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
    // preview 域（文件预览数据面）：fs 安全实现在 gateway/preview-service，经
    // backend 注入并与 HTTP 路由共享同一根状态；字节流不进 JSON 协议 —— read
    // 结果带服务端签发的 url（与 makeVoiceUrl/makeSceneUrl 同一模式）。
    this.server.registerDomain('preview', createPreviewDomain({
      getService: () => backend.previewService?.() ?? null,
      makeRawUrl: backend.makePreviewRawUrl ?? ((rel: string) => `/api/fs/raw?path=${encodeURIComponent(rel)}`),
      loopback: backend.previewLoopback ?? false,
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
      // 密钥落点统一：WebUI 配的 apiKey 也写进 ~/.agent/.env（与 TUI 同源）
      persistApiKey: backend.persistApiKey,
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
        // 会话归属渠道：由调用方决定 —— TUI 本地模式传 'tui'，浏览器 WebUI 走缺省 'webui'
        // （与 http-webhook 同源）。不得硬编码，理由见 UiProtocolSessionBackend.channel。
        channel: this.backend.channel ?? 'webui',
        // 懒登记：WS 连接时只登记 sessionId，不落盘；首条消息才物化（防刷新留空壳 ✗）
        lazySession: this.backend.lazySession,
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

      // 陪伴场景推送：scene_render 落盘（被动产物、无事件源）⇒ UI 侧监视目录，
      // 变化即广播 COMPANION_SCENE，前端据此即时换背景（替代此前的 15s 轮询）。
      // 监视不可用 ⇒ 句柄 inactive，记一条 warn（前端仍有首次 loadCompanionScene 兜底），
      // 绝不静默（2026-10-15 纪律：catch 不能把错误变成"看起来正常"）。
      this.sceneWatch = watchCompanionScenes({
        root: getSceneRoot(),
        onChange: (character) => {
          this.server.broadcast(UI_EVENT.COMPANION_SCENE, { character });
        },
      });
      if (!this.sceneWatch.active) {
        logger.warn('Companion scene watch unavailable (scene background will not auto-refresh)', {
          root: getSceneRoot(),
        });
      }

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
    // 释放场景目录监视（不释放会持续持有 fs 句柄；每个 WS 连接各有一份）
    this.sceneWatch?.close();
    this.sceneWatch = null;
    // 释放会话占用：连接断开后别的标签必须能再次打开这个会话
    if (this.backend.claims && this.backend.claimOwner && this.claimedSessionId) {
      this.backend.claims.release(this.claimedSessionId, this.backend.claimOwner);
      this.claimedSessionId = null;
    }
    this.adapter.close();
    this.loop = null;
  }
}
