/**
 * TUI Gateway — pi-tui component-based terminal UI for the Agent framework.
 *
 * Powered by @earendil-works/pi-tui.
 *
 * Layout (top to bottom):
 *   headerContainer — Agent · model · Turns · Mode · Provider
 *   contextBarText  — Context ████░░░░ 45%
 *   chatLog         — message history (grows to fill)
 *   footerText      — Ctrl+C exit | Ctrl+L clear | ...
 *   editor          — user input area
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {
  CombinedAutocompleteProvider,
  Container,
  Key,
  Loader,
  matchesKey,
  ProcessTerminal,
  Text,
  TUI,
} from '@earendil-works/pi-tui';
import type { Provider } from '../provider/interface.js';
import type { OutputHandler, TurnInfo } from '../orchestrator/loop.js';
import { StatsManager } from '../memory/stats.js';
import { ConfigManager } from '../setup/config.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { RuntimeConfigCenter } from '../runtime/config-center.js';
import { ProviderManager } from '../provider/manager.js';
import { REPLACEABLE_POINTS, togglePluginInManifest, loadExtensionManifest } from '../supervisor/extension-registry.js';
import { LifecycleSupervisor } from '../supervisor/shutdown.js';
import { createAgent } from './factory.js';
import { DEFAULT_PERSONA_DIR } from '../setup/persona-bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { TuiChannel } from '../channels/builtin/tui-channel.js';
import { ChannelManager } from '../channels/manager.js';
import { MessageQueue, QueueMessageMode } from '../channels/index.js';
import { registerConfigChannels, getChannelPlugins } from '../channels/auto-detect.js';
import type { AgentFactory, ChannelMessageEvent } from '../channels/interface.js';
import {
  filterCommands,
  getCommandsByCategory,
  getCategoryLabel,
} from '../ui/slash-commands.js';
import { SlashSubPanel } from '../ui/slash-panel.js';
import { CommandRegistry, type SlashCommandDef } from '../ui/command-registry.js';
import { ChatLog } from '../ui/chat-log.js';
import { CustomEditor } from '../ui/pi-tui-editor.js';
import { theme, editorTheme } from '../ui/theme.js';
import { readRecentEvents } from '../memory/events.js';
import { LocalModelModule } from '../local-model/index.js';
import type { BackgroundProcessInfo } from '../tools/background-registry.js';

import { SessionManager } from '../memory/session.js';
import { ModelChannelRegistry } from '../provider/model-channel-registry.js';
import { getProviderConfigLoader } from '../provider/config.js';
import { createInProcPair } from '../ui-protocol/adapter.js';
import { UiProtocolSession, type UiProtocolSessionBackend } from '../channels/builtin/ui-protocol-session.js';
import { UI_EVENT } from '../events.js';
import type { UiMessage, UiEvent, UiResponse } from '../ui-protocol/types.js';

const logger = createLogger('tui');

// TUI 纯格式化工具（阶段 C：从本文件拆出，见 tui-format.ts）
import {
  visualWidth,
  truncateByVisualWidth,
  formatStatusBar,
  formatContextBar,
  replayEvents,
  detectLegacyTerminal,
} from './tui-format.js';
import { createTuiSearch } from './tui-search.js';
import { createTuiPermission } from './tui-permission.js';
import { createTuiAskUser } from './tui-ask-user.js';
import { showWelcome } from './tui-welcome.js';
import { createModelLocalCmds } from './tui-model-local.js';
import { createModelCmds } from './tui-model-cmds.js';
import { createCompressCmds } from './tui-compress-cmds.js';
import { createChannelCmds, createChannelDispatch, type ChannelRegistryLike } from './tui-channel-cmds.js';
import { createSessionCmds } from './tui-session-cmds.js';

// ─── Main TUI ─────────────────────────────────────────────────────────────
export async function runTui(
  provider: Provider,
  sessionId: string | undefined,
  shouldContinue: boolean,
  maxTurns: number,
  maxContext: number,
  maxMessages: number = 10000,
  skipSetup?: boolean,
  personaDir: string = DEFAULT_PERSONA_DIR,
  localModelProvider?: Provider,
  continuationMessage?: string,
): Promise<void> {
  // ── Force UTF-8 console encoding on Windows ──
  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001 > nul', { stdio: 'ignore' });
    } catch {
      // non-fatal: terminal may still work with limited character support
    }
  }

  // ── Redirect stderr to file ──
  const logDir = path.join(os.homedir(), '.agent');
  await fs.promises.mkdir(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'tui.log'), { flags: 'a' });
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown, ...args: unknown[]): boolean => {
    logStream.write(typeof chunk === 'string' ? chunk : String(chunk));
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb();
    return true;
  };

  // ── Provider ──
  const configManager = new ConfigManager(process.cwd());
  await configManager.loadEnvKeys();

  let activeProvider = provider;
  if (!provider.getModel() || provider.getModel() === '') {
    try {
      const manager = await ProviderManager.createFromConfigFile(undefined, process.cwd());
      activeProvider = manager.getProvider();
    } catch {
      // fallback
    }
  }

  let providerTypeStart = activeProvider.getProviderType();
  let modelName = activeProvider.getModel();

  // ── Last known TurnInfo (updated each turn, used by /provider handler) ──
  let lastTurnCount = 0;
  let lastTokensUsed = 0;

  // ── Lifecycle ──
  const supervisor = new LifecycleSupervisor();
  supervisor.installSignalHandlers();

  // ── Local Model ──
  const localModel = LocalModelModule.getInstance();
  localModel.initialize(process.cwd());

  let slashSubPanelActive = false;  // 二级菜单激活时跳过主监听器的上下键处理

  // ── TUI — pi-tui setup ──
  const tui = new TUI(new ProcessTerminal());
  const root = new Container();

  // Header area: contains Text only (no Loader)
  const headerContainer = new Container();
  let headerText: Text = new Text('', 0, 0);
  headerContainer.addChild(headerText);

  const contextBarText = new Text('', 0, 0);

  const chatLog = new ChatLog();

  const footerText = new Text('', 0, 0);

  const editor = new CustomEditor(tui, editorTheme);

  // Permission selection bar — shown between chat and editor during tool permission prompts
  const permissionBar = new Text('', 0, 0);

  // ── Ask User 表单组件（表单状态与逻辑在 tui-ask-user.ts，tui.ts 深拆第三批）──
  const askUserBar = new Text('', 0, 0);
  const askUserContent = new Text('', 0, 0);

  root.addChild(headerContainer);
  root.addChild(chatLog);
  root.addChild(contextBarText);

  // Thinking indicator — below chatLog, above editor (prevents content jitter)
  const thinkingBar = new Container();
  let thinkingLoader: Loader | null = null;
  root.addChild(thinkingBar);

  root.addChild(footerText);
  root.addChild(permissionBar);
  root.addChild(askUserContent);
  root.addChild(askUserBar);
  root.addChild(editor);

  tui.addChild(root);
  tui.setFocus(editor);

  // ── Header helpers — header always shows text (never Loader) ──
  function updateHeaderText(text: string): void {
    headerText.setText(text);
  }

  // ── Thinking indicator helpers — Loader between chatLog and editor ──
  function showThinkingIndicator(message: string): Loader {
    if (thinkingLoader) {
      thinkingLoader.setMessage(message);
      return thinkingLoader;
    }
    const loader = new Loader(
      tui,
      (spinner: string) => theme.accent(spinner),
      (text: string) => theme.accent(text),
      message,
    );
    thinkingBar.addChild(loader);
    thinkingLoader = loader;
    return loader;
  }

  function hideThinkingIndicator(): void {
    if (thinkingLoader) {
      thinkingLoader.stop();
      thinkingBar.removeChild(thinkingLoader);
      thinkingLoader = null;
    }
  }

  // ── State for refreshStatus ──
  let prevCompressCount = 0;
  let compactionMessage: string | null = null;
  let compressionLoader: Loader | null = null;
  let compressionTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 旁路Agent（意图识别/簇归类）运行指示器 */
  let bypassLoader: Loader | null = null;
  let bypassTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 运行中后台进程数（footer 显示；经 process.list 协议异步刷新） */
  let bgRunningCount = 0;
  /** 当前正在执行的调度任务名（队列判断/状态栏用；经 schedule.runtime 协议刷新） */
  let pendingTaskLocal: string | null = null;
  let isThinking = false;

  function refreshStatus(info: TurnInfo): void {
    // ── Track last known values for /provider handler ──
    lastTurnCount = info.turnCount;
    lastTokensUsed = info.tokensUsed;

    // ── Read live config (overrides startup defaults) ──
    const liveCfg = RuntimeConfigCenter.getInstance();
    const liveMaxContext = liveCfg.get<number>('session.maxContext')!;
    const liveMaxTurns = liveCfg.get<number>('session.maxTurns') || maxTurns;

    const activeInfo: TurnInfo = {
      ...info,
      maxTurns: liveMaxTurns,
    };

    // Compaction detection
    if (info.compressCount > prevCompressCount) {
      prevCompressCount = info.compressCount;
      compactionMessage = '\u27f3 Compacting...';
      setTimeout(() => {
        compactionMessage = '\u2713 Compacted';
        tui.requestRender();
        setTimeout(() => {
          compactionMessage = null;
          tui.requestRender();
        }, 2000);
      }, 1000);
    }

    // Provider 显示：用本地缓存（modelName / providerTypeStart，由协议事件与
    // 命令维护——switch/fallback 均经服务端 status 消息 → refreshStatusFromProtocol
    // 更新缓存）。不再轮询/直读 loop（纯协议客户端化）。
    const currentModel = modelName;
    const currentProviderType = providerTypeStart;
    const currentProviderInfo = { providerLabel: currentProviderType, isLocal: false, mode: 'auto' as const };
    // Build mode label for header display
    let modeHeaderLabel: string | null = null;
    let statusContent = formatStatusBar(activeInfo, currentModel, currentProviderInfo, modeHeaderLabel);

    // Compaction message
    if (compactionMessage) {
      statusContent += ' ' + theme.warning(compactionMessage);
    }

    // Update header (always Text)
    if (isThinking && thinkingLoader) {
      thinkingLoader.setMessage(statusContent);
    } else if (!isThinking) {
      updateHeaderText(statusContent);
    }
    let ctxBar = formatContextBar(info.tokensUsed, liveMaxContext);
    // 优先使用最新轮次的缓存命中率，否则从累计值计算
    const hitRate = info.cacheHitRate != null
      ? info.cacheHitRate.toFixed(1)
      : (info.cacheHitTokens != null && info.cacheMissTokens != null)
        ? (() => { const t = info.cacheHitTokens + info.cacheMissTokens; return t > 0 ? (info.cacheHitTokens / t * 100).toFixed(1) : null; })()
        : null;
    if (hitRate != null) {
      ctxBar += theme.dim(` | Cache: ${hitRate}%`);
      if (info.cacheHistory && info.cacheHistory.length > 1) {
        ctxBar += theme.dim(` (${info.cacheHistory.length}t)`);
      }
    }
    // Background process count
    if (backgroundRegistry) {
      const bgProcs = backgroundRegistry.list();
      if (bgProcs.length > 0) {
        const running = bgProcs.filter((p: BackgroundProcessInfo) => p.status === 'running').length;
        ctxBar += theme.dim(' | ') + theme.accent(`⚙ ${running} bg`);
      }
    }
    contextBarText.setText(ctxBar);
    tui.requestRender();
    updateTokenEstimate(); // 同步刷新 footer（工作流状态等）
  }

  // ── Output handler ──
  let currentTextLine = '';
  let pendingThinking = '';
  let toolCounterFallback = 0;
  let showThinking = false;




  const tuiHandler: OutputHandler = {
    onText(content: string) {
      currentTextLine += content;
    },
    onThinking(content: string) {
      pendingThinking += content;
    },
    onTurnStart() {
      isThinking = true;
      pendingThinking = '';
      const label = pendingTaskLocal
        ? `⏰ ${pendingTaskLocal}`
        : 'Thinking...';
      showThinkingIndicator(theme.accent(label));
    },
    onToolUse(name: string, inputSummary: string, toolId?: string) {
      if (pendingThinking.trim()) {
        if (showThinking) {
          chatLog.addSystem(theme.thinking('\u{1F9E0} Thinking:\n') + theme.thinking(pendingThinking.trim()));
        }
        pendingThinking = '';
      }
      if (currentTextLine.trim()) {
        chatLog.finalizeAssistant(currentTextLine.trim());
        currentTextLine = '';
      }
      const summary =
        inputSummary.length > 100 ? inputSummary.slice(0, 97) + '...' : inputSummary;
      const id = toolId ?? `tool_${Date.now()}_${++toolCounterFallback}`;
      chatLog.startTool(id, name, summary);

      tui.requestRender();
    },
    onToolResult(content: string, isError: boolean, toolId?: string) {
      if (toolId) {
        chatLog.updateToolResult(toolId, content, { isError });
      }

      tui.requestRender();
    },
    onDiff(toolId: string, filePath: string, diffLines: Array<{ kind: string; text: string }>) {
      if (toolId) {
        chatLog.showDiff(toolId, filePath, diffLines);
      }

      tui.requestRender();
    },
    onStatus(message: string, level: string) {
      // 压缩指示器
      if (message === 'compress-start') {
        if (!compressionLoader) {
          compressionLoader = new Loader(
            tui,
            (spinner: string) => theme.accent(spinner),
            (text: string) => theme.accent(text),
            'Compressing...',
          );
          thinkingBar.addChild(compressionLoader);
        }
        // 超时保护：30 秒后自动清除 Loader
        if (compressionTimeout) clearTimeout(compressionTimeout);
        compressionTimeout = setTimeout(() => {
          if (compressionLoader) {
            compressionLoader.stop();
            thinkingBar.removeChild(compressionLoader);
            compressionLoader = null;
          }
          compressionTimeout = null;
        }, 30000);
        return;
      }
      if (message === 'compress-end') {
        if (compressionTimeout) {
          clearTimeout(compressionTimeout);
          compressionTimeout = null;
        }
        if (compressionLoader) {
          compressionLoader.stop();
          thinkingBar.removeChild(compressionLoader);
          compressionLoader = null;
        }
        return;
      }
      if (message.startsWith('compress-result:')) {
        const parts = message.split(':');
        const pre = parseInt(parts[1], 10);
        const post = parseInt(parts[2], 10);
        if (!isNaN(pre) && !isNaN(post)) {
          const ratio = Math.round((1 - post / pre) * 100);
          chatLog.addSystem(
            theme.success('Compressed: ') +
            theme.dim(`${pre.toLocaleString()} → ${post.toLocaleString()} tokens`) +
            theme.fg(` (${ratio}% reduced)`),
          );
          // 用压缩后的 token 数刷新 context bar（本地合成 TurnInfo，不读 loop）
          refreshStatus({ turnCount: lastTurnCount, maxTurns, tokensUsed: post, maxContextTokens: maxContext, sessionId: sessionDir, compressCount: 0 });
        }
        return;
      }
      // 旁路Agent 预处理指示器（意图识别/簇归类）
      if (message === 'bypass-start') {
        if (!bypassLoader) {
          bypassLoader = new Loader(
            tui,
            (spinner: string) => theme.accent(spinner),
            (text: string) => theme.dim(text),
            '预处理中...',
          );
          thinkingBar.addChild(bypassLoader);
        }
        if (bypassTimeout) clearTimeout(bypassTimeout);
        bypassTimeout = setTimeout(() => {
          if (bypassLoader) {
            bypassLoader.stop();
            thinkingBar.removeChild(bypassLoader);
            bypassLoader = null;
          }
          bypassTimeout = null;
        }, 60000); // 超时保护：60 秒后自动清除，防止残留
        return;
      }
      if (message === 'bypass-end') {
        if (bypassTimeout) {
          clearTimeout(bypassTimeout);
          bypassTimeout = null;
        }
        if (bypassLoader) {
          bypassLoader.stop();
          thinkingBar.removeChild(bypassLoader);
          bypassLoader = null;
        }
        return;
      }

      if (level === 'error') {
        // 原始 API 错误细节走日志，TUI 只显示简洁消息
        if (message.length > 150 || message.includes('{') || message.includes('\n')) {
          process.stderr.write(`[tui:error] ${message}\n`);
          chatLog.addSystem(theme.errorBright('[Error] ') + theme.dim('Provider request failed, auto-switching...'));
        } else {
          chatLog.addSystem(theme.errorBright('[Error] ') + theme.error(message));
        }
      } else if (level === 'warn') {
        chatLog.addSystem(theme.warning(message));
      } else {
        chatLog.addSystem(theme.fg(message));
        // 如果消息是 provider 切换，同步刷新 UI
        // onStatus 是同步回调，不能 await；fire-and-forget（InProc 下协议发送同步完成）
        if (message.startsWith('Provider switched to ')) {
          // 经协议 state.get 刷新 modelName/providerTypeStart + 状态栏（不读 loop）
          void refreshStatusFromProtocol();
        }
      }

      tui.requestRender();
    },
    onFlush() {
      hideThinkingIndicator();
      isThinking = false;

      // 陪伴模式自动切换 session 检测：经协议 state.get 对比 sessionId + sessionDir
      // （sessionDir 由后端 sessionStore 解析进快照 —— 纯协议客户端化，不直读 SessionManager）
      void (async () => {
        try {
          const snap = (await protocolSend('state.get')) as { sessionDir?: string } | undefined;
          const newDir = snap?.sessionDir;
          if (newDir && newDir !== sessionDir) {
            sessionDir = newDir;
            chatLog.clearAll();
            await replayEvents(chatLog, newDir);
            tui.requestRender();
          }
        } catch { /* ignore */ }
      })();

      updateHeaderText(modelName);
      if (pendingThinking.trim()) {
        if (showThinking) {
          chatLog.addSystem(theme.thinking('\u{1F9E0} Thinking:\n') + theme.thinking(pendingThinking.trim()));
        }
        // thinking-only 模型兜底：thinking 有内容但 text 为空时，将 thinking 作为回复显示
        if (!currentTextLine.trim()) {
          currentTextLine = pendingThinking.trim();
        }
        pendingThinking = '';
      }
      if (currentTextLine.trim()) {
        chatLog.finalizeAssistant(currentTextLine.trim());
        currentTextLine = '';
      }

      tui.requestRender();
    },
    onInterrupt() {
      hideThinkingIndicator();
      isThinking = false;
      pendingThinking = '';
      currentTextLine = '';
    },
    onAskUser(questions): Promise<string> {
      return new Promise<string>((resolve) => {
        tuiAskUser.open(questions, { resolve });
      });
    },
  };

  // ── Local Model (llama.cpp) ──
  try {
    const loadedModels = await supervisor.loadAndStartModels(process.cwd());
    if (loadedModels.length > 0) {
      chatLog.addSystem(theme.success('\uD83D\uDDA5  Local Model Server'));
      for (const m of loadedModels) {
        chatLog.addSystem(theme.success('   \u2022 ') + theme.accent(m.name) + theme.dim(' \u2192 ') + theme.accent(m.baseUrl));
      }
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    chatLog.addSystem(theme.warning('\u26a0  Local model server not available: ' + msg));
  }
  tui.requestRender();

  // ── 远程模式下跳过 createAgent，这些组件需手动初始化 ──
  try { CommandRegistry.getInstance(process.cwd()); } catch { /* already initialized */ }
  try {
    const { RuntimeConfigCenter } = await import('../runtime/config-center.js');
    const configCenter = RuntimeConfigCenter.getInstance();
    // 尝试读取配置——如果未初始化会抛异常
    configCenter.get<number>('session.maxTurns');
  } catch {
    // 初始化 RuntimeConfigCenter
    const { ConfigManager } = await import('../setup/config.js');
    const { getDefaultConfig } = await import('../runtime/defaults.js');
    const { RuntimeConfigCenter: RCC } = await import('../runtime/config-center.js');
    const cm = new ConfigManager(process.cwd());
    await cm.loadEnvKeys();
    const cfg = await cm.load();
    RCC.getInstance().initialize(getDefaultConfig(), cm);
    RCC.getInstance().merge(cfg as any);
  }

  // ── 检测统一后端是否已运行 ──
  let remoteWs: any = null;
  try {
    const healthy = await new Promise<boolean>((resolve) => {
      const req = http.get('http://127.0.0.1:3000/api/health', (res) => {
        let d = ''; res.on('data', (c: string) => d += c); res.on('end', () => resolve(d.includes('"ok"')));
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
    if (healthy) {
      const { default: WebSocket } = await import('ws');
      remoteWs = await new Promise<any>((resolve) => {
        const ws = new WebSocket('ws://127.0.0.1:3000/tui');
        ws.on('open', () => resolve(ws));
        ws.on('error', () => resolve(null));
        setTimeout(() => resolve(null), 3000);
      });
    }
  } catch { /* fall through to standalone */ }

  // ── Agent + Session（远程模式下跳过，使用 WebSocket 连接） ──
  // 本地模式的 SessionManager（协议层 backend 与 agentFactory 共用，保证会话目录一致）
  const sessionManager = new SessionManager(process.cwd());

  // 创建 AgentFactory（注入到渠道 + UiProtocolSession.initialize 创建 loop）
  // 本地模式协议化后，TUI 的 loop 由 UiProtocolSession 通过本 factory 创建，
  // 因此必须补全本地会话参数（shouldContinue / personaDir / localModelProvider 等）。
  const agentFactory: AgentFactory = {
    createAgent: async (options) => {
      return createAgent({
        cwd: process.cwd(),
        provider: activeProvider,
        maxTurns: maxTurns ?? 20,
        maxContext: maxContext ?? 40_000,
        outputHandler: options.outputHandler as OutputHandler,
        // 真实会话意图来自 cli（--session / .resume-session / restart marker），
        // 而非 UiProtocolSession 的协议连接标识（'tui' 兜底）。
        // 修复：此前把协议标识 'tui' 当真实会话 ID 传入 → boot 恒 resume('tui')，
        // 导致每次启动都复用同一个名为 tui 的旧会话。现在默认 undefined →
        // boot 走 shouldContinue/惰性新建分支，首条消息才物化。
        sessionId,
        channel: options.channel ?? 'tui',
        sessionManager,
        shouldContinue,
        maxMessages,
        personaDir,
        localModelProvider,
      }, supervisor);
    },
  };

  let sessionDir: string;
  /** 本地模式 initialize 后 agent 组件（backend 数据源 + 跨渠道工具注册用；远程为 null） */
  let localComponents: { knowledgeBase?: unknown; backgroundRegistry?: unknown; hotReloadManager?: unknown; gitManager?: unknown; extensionRegistry?: unknown; assemblyRegistry?: unknown; toolRegistry?: unknown; sessionDir?: string } | null = null;
  // protocolSend：本地模式协议化后由 client 端赋值（发协议请求）；远程模式走 WS 协议层
  let protocolSend: (method: string, params?: unknown) => Promise<unknown> = async () => undefined;

  // ── 权限对话框（tui-permission.ts，tui.ts 深拆第二批）──
  const tuiPermission = createTuiPermission({ tui, chatLog, permissionBar, protocolSend: (m, p) => protocolSend(m, p) });

  // ── Ask User 表单（tui-ask-user.ts，tui.ts 深拆第三批）──
  const tuiAskUser = createTuiAskUser({ tui, chatLog, askUserContent, askUserBar, protocolSend: (m, p) => protocolSend(m, p) });

  // client 端协议请求表（本地 InProc / 远程 WS 共用）：request id → resolve 回调
  const pendingRequests = new Map<string, (resp: UiResponse) => void>();
  let protocolSeq = 0;

  /**
   * 经协议层获取状态快照并刷新状态栏（替代 refreshStatus(loop.getTurnInfo(...)) 直连）。
   * state.get 快照含 loop 真实 turnCount/tokensUsed（buildStateSnapshot 优先取
   * loop.contextTokensUsed/turnNumber），用于命令处理后的通用状态刷新。
   * 注意：事件驱动渲染（onStatus 同步回调）与 stats 特定语义的刷新点不适用此 helper。
   */
  async function refreshStatusFromProtocol(): Promise<void> {
    const snap = await protocolSend('state.get') as import('../ui-protocol/types.js').StateSnapshot | undefined;
    if (!snap) return;
    // 同步更新 provider/model 本地缓存（provider 切换后状态栏与面板一致）
    if (snap.provider) providerTypeStart = snap.provider as typeof providerTypeStart;
    if (snap.model) modelName = snap.model;
    void refreshBgCountFromProtocol();
    void refreshPendingTaskFromProtocol();
    refreshStatus({
      turnCount: snap.turnCount,
      tokensUsed: snap.tokensUsed,
      maxTurns: snap.maxTurns,
      maxContextTokens: snap.maxContextTokens,
      compressCount: snap.compressCount,
      sessionId: snap.sessionId,
    } as unknown as TurnInfo);
  }

  /** 经协议 schedule.runtime 刷新当前调度任务名（队列判断/状态栏；异步容错） */
  async function refreshPendingTaskFromProtocol(): Promise<void> {
    try {
      const res = (await protocolSend('schedule.runtime')) as { pendingTaskName?: string | null } | null | undefined;
      pendingTaskLocal = res?.pendingTaskName ?? null;
    } catch { /* 协议不可用时保持旧值 */ }
  }

  /** 经协议 process.list 刷新运行中后台进程计数（footer 显示；异步容错） */
  async function refreshBgCountFromProtocol(): Promise<void> {
    try {
      const res = (await protocolSend('process.list')) as { list?: Array<{ status?: string }> } | Array<{ status?: string }> | null | undefined;
      const items = Array.isArray(res) ? res : res?.list;
      bgRunningCount = (items ?? []).filter((p) => p.status === 'running').length;
    } catch { /* 协议不可用时保持旧值 */ }
  }

  // client 端协议事件分发：把协议事件映射回 TUI 渲染/交互
  // （message.* → tuiHandler；permission.request → 权限队列；ask_user → 表单）
  const handleProtocolEvent = (ev: UiEvent): void => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case UI_EVENT.MESSAGE_TEXT: tuiHandler.onText?.(String(p.content ?? '')); break;
      case UI_EVENT.COMPANION_SAY:
        // 陪伴表达：与普通回复同形展示（payload.text 已是 [动作]（心声）话术 渲染结果）
        tuiHandler.onText?.(String(p.text ?? ''));
        break;
      case UI_EVENT.MESSAGE_THINKING: tuiHandler.onThinking?.(String(p.content ?? '')); break;
      case UI_EVENT.MESSAGE_TOOL_USE:
        tuiHandler.onToolUse?.(String(p.name ?? ''), String(p.inputSummary ?? ''), p.id ? String(p.id) : undefined);
        break;
      case UI_EVENT.MESSAGE_TOOL_RESULT:
        tuiHandler.onToolResult?.(String(p.content ?? ''), Boolean(p.isError), p.id ? String(p.id) : undefined);
        break;
      case UI_EVENT.MESSAGE_DIFF:
        tuiHandler.onDiff?.(String(p.id ?? ''), String(p.filePath ?? ''), (p.diffLines ?? []) as Array<{ kind: string; text: string }>);
        break;
      case UI_EVENT.MESSAGE_STATUS:
        tuiHandler.onStatus?.(String(p.message ?? ''), (p.level as 'info' | 'warn' | 'error') ?? 'info');
        break;
      case UI_EVENT.MESSAGE_ERROR:
        tuiHandler.onStatus?.(String(p.message ?? ''), 'error');
        break;
      case UI_EVENT.MESSAGE_TURN_START: tuiHandler.onTurnStart?.(); break;
      case UI_EVENT.MESSAGE_FLUSH: tuiHandler.onFlush?.(); break;
      case UI_EVENT.MESSAGE_INTERRUPT: tuiHandler.onInterrupt?.(); break;
      case UI_EVENT.MESSAGE_TURN_INFO: {
        const info = p as { turnCount?: number; tokensUsed?: number };
        lastTurnCount = Number(info.turnCount ?? lastTurnCount);
        lastTokensUsed = Number(info.tokensUsed ?? lastTokensUsed);
        refreshStatus({ turnCount: lastTurnCount, maxTurns, tokensUsed: lastTokensUsed, maxContextTokens: maxContext, sessionId: '', compressCount: 0 });
        break;
      }
      case UI_EVENT.PERMISSION_REQUEST: {
        const req = p as { id?: string; toolName?: string; input?: Record<string, unknown> };
        const inputStr = Object.entries(req.input ?? {})
          .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
          .join(', ');
        tuiPermission.enqueue({ id: String(req.id ?? ''), toolName: String(req.toolName ?? ''), inputStr });
        break;
      }
      case UI_EVENT.MESSAGE_ASK_USER: {
        const au = p as { id?: string; questions?: Array<{ question: string; header?: string; options?: string[]; multiSelect?: boolean; customInput?: boolean }> };
        if (!au.id || !au.questions || au.questions.length === 0) break;
        tuiAskUser.open(au.questions, { id: au.id });
        break;
      }
      default: break;
    }
  };

  if (!remoteWs) {
    // 本地模式：通过 UiProtocolSession(InProc) 走协议层，与 WebUI 对称。
    // loop 由 UiProtocolSession.initialize 通过 agentFactory 创建，
    // outputHandler 是 ProtocolOutputHandler（loop 回调 → message.* 协议事件）。
    const [protocolClient, protocolServer] = createInProcPair('tui-client', 'ui-server');
    const registry = new ModelChannelRegistry(process.cwd());
    try { registry.load(activeProvider); } catch { /* 加载失败不阻塞 */ }
    const manager = {
      switchProvider: (config: { type: string; apiKey?: string; model?: string; baseUrl?: string }): void => {
        try { registry.setChannelModel('main', config.type, config.model); } catch { /* noop */ }
      },
    };
    const historyProvider = async (sid: string, limit?: number) => {
      const dir = sessionManager.getSessionDir(sid);
      const events = await readRecentEvents(dir, limit ?? 50);
      return events.map((e) => ({
        type: e.type, content: e.content, name: e.name, id: e.id, input: e.input,
        toolUseId: e.tool_use_id, message: e.message, reason: e.reason,
        inputTokens: e.input_tokens, outputTokens: e.output_tokens, timestamp: e.timestamp,
      }));
    };
    // 会话统计真实来源：sessionId → sessionDir → stats.json（StatsManager）
    const statsProvider = async (sid: string) => {
      const { StatsManager } = await import('../memory/stats.js');
      return new StatsManager(process.cwd()).get(sessionManager.getSessionDir(sid));
    };
    // kb / process / orchestrator 域依赖 agent 组件（initialize 后才就绪）：可变引用延迟解析
    const uiSession = new UiProtocolSession(protocolServer, sessionId ?? 'tui', {
      cwd: process.cwd(),
      configCenter: RuntimeConfigCenter.getInstance() as unknown as UiProtocolSessionBackend['configCenter'],
      sessionStore: sessionManager,
      registry,
      // model 域 registry 运行时重绑已内聚到 UiProtocolSession.initialize
      // （loop.modelRouter 内部实例），TUI 不再提供 getRuntimeRegistry
      manager,
      commandRegistry: CommandRegistry.getInstance(process.cwd()),
      listProvidersMeta: () => getProviderConfigLoader(process.cwd()).getAll(),
      listLocalModels: () => LocalModelModule.getInstance().list().map((e) => ({
        name: e.name, modelFile: e.modelFile, backend: e.backend, port: e.port,
        host: e.host, ctxSize: e.ctxSize, nGpuLayers: e.nGpuLayers, enabled: e.enabled,
      })),
      statsProvider,
      getKb: () =>
        (localComponents?.knowledgeBase as import('../ui-protocol/domains/kb.js').KnowledgeBaseLike | undefined) ?? null,
      getComposerConditions: () =>
        ((localComponents as Record<string, unknown> | null)?.contextComposer as { activeConditions?: Set<string> } | undefined)?.activeConditions ?? null,
      getRegistry: () =>
        (localComponents?.backgroundRegistry as import('../ui-protocol/domains/process.js').BackgroundRegistryLike | undefined) ?? null,
      // supervisor 域（S5 可观测面）：watcher 健康度来自装配组件；git 摘要用
      // 组件里的 GitManager 现算（异步摘要，域侧 await + 异常降级 null）
      getWatcherStatus: () => {
        const mgr = localComponents?.hotReloadManager as
          | { getStatus(): { started: boolean; watcherCount: number; debounceMs: number } }
          | undefined;
        return mgr ? mgr.getStatus() : null;
      },
      getGitSummary: async () => {
        const gitManager = localComponents?.gitManager as
          | import('../evolution/git-manager.js').GitManager
          | undefined;
        if (!gitManager) return null;
        const isRepo = await gitManager.isRepo().catch(() => false);
        if (!isRepo) return { isRepo: false, dirty: false, lastAutoCommit: null };
        const dirty = await gitManager.hasUncommittedChanges().catch(() => false);
        const autoCommits = await gitManager.logGrep('auto:', 1).catch(() => []);
        return { isRepo: true, dirty, lastAutoCommit: autoCommits[0]?.message ?? null };
      },
      // arch 域（架构监督）：目录/名单/生效条目来自装配组件；toggle 写项目级名单
      getArch: () => {
        const ext = localComponents?.extensionRegistry as
          import('../supervisor/extension-registry.js').ExtensionRegistry | undefined;
        if (!ext) return null;
        const cwd = process.cwd();
        return {
          getCatalog: () => REPLACEABLE_POINTS.map((p) => ({ id: p.id, kind: p.kind, defaultImpl: p.defaultImpl, description: p.description })),
          getEntries: () => ext.list().map((e) => ({ ...e })),
          getManifest: () => ext.getManifest(),
          getAssemblyDescribe: () =>
            (localComponents?.assemblyRegistry as
              import('../supervisor/assembly-registry.js').AssemblyRegistry | undefined)?.describe() ?? null,
          togglePlugin: (pluginId: string, enabled: boolean) => {
            const r = togglePluginInManifest(cwd, pluginId, enabled);
            if (r.ok) ext.setManifest(loadExtensionManifest(cwd).manifest);
            return r;
          },
        };
      },
      configureLocalModel: (config) => {
        if (config.ollamaUrl) {
          // 经协议层写配置（fire-and-forget：内存写同步、落盘异步，与原直连语义等价）
          void protocolSend('config.set', { path: 'localModel.ollamaUrl', value: config.ollamaUrl });
        }
      },
      localModelOps: {
        start: (name) => LocalModelModule.getInstance().start(name),
        stop: (name) => LocalModelModule.getInstance().stop(name),
        switch: (name) => LocalModelModule.getInstance().switch(name),
        register: (opts) => LocalModelModule.getInstance().registerModel(opts as unknown as Parameters<LocalModelModule['registerModel']>[0]),
        unregister: (name) => LocalModelModule.getInstance().unregisterModel(name),
        scanUnregistered: () => LocalModelModule.getInstance().scanUnregistered(),
      },
      historyProvider,
    });
    await uiSession.initialize(agentFactory);
    const components = uiSession.getComponents<Awaited<ReturnType<typeof createAgent>>>();
    sessionDir = components?.sessionDir ?? '';
    // initialize 后 agent 组件就绪：供 kb/process 域延迟解析
    localComponents = components ?? null;
    // model 域 registry 重绑、orchestrator 域 bypassManager 均已内聚到
    // UiProtocolSession.initialize —— TUI 不再持有组件/loop 引用
    // ask_user 已由 UiProtocolSession 桥接到协议层（message.ask_user 事件 →
    // handleProtocolEvent → 表单 → message.askUserResolve 应答），此处不再直驱本地表单。
    // client 端发送协议请求（request-response 映射：id → resolve 回调表，经 InProc 传输）
    protocolSend = (method: string, params?: unknown): Promise<unknown> => {
      const id = `tui_${Date.now()}_${++protocolSeq}`;
      return new Promise((resolve) => {
        pendingRequests.set(id, (resp) => resolve(resp.result));
        protocolClient.send({ kind: 'request', id, method, params });
      });
    };
    // client 端接收协议消息：response → resolve 请求；event → handleProtocolEvent
    protocolClient.onMessage((msg: UiMessage) => {
      if (msg.kind === 'response') {
        const cb = pendingRequests.get(msg.id);
        if (cb) {
          pendingRequests.delete(msg.id);
          cb(msg as UiResponse);
        }
        return;
      }
      if (msg.kind !== 'event') return;
      handleProtocolEvent(msg as UiEvent);
    });
  } else {
    // 远程模式：协议发送走 WS（/tui 端点，统一协议层，与本地模式对称）
    protocolSend = (method: string, params?: unknown): Promise<unknown> => {
      const id = `tui_${Date.now()}_${++protocolSeq}`;
      return new Promise((resolve) => {
        pendingRequests.set(id, (resp) => resolve(resp.result));
        if (remoteWs && remoteWs.readyState === 1) {
          remoteWs.send(JSON.stringify({ kind: 'request', id, method, params }));
        } else {
          resolve(undefined);
        }
      });
    };
    sessionDir = '';
  }
  // 纯协议客户端化后 TUI 不持有 loop/组件：以下适配层仅承载「本地模式下
  // 与宿主进程内共享组件（components）同源」的只读数据（backgroundRegistry
  // 由斜杠命令读取本地进程表；远程模式为 null）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const backgroundRegistry: any = (localComponents as Record<string, unknown> | null)?.backgroundRegistry ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // (sessionManager 已在上面统一创建，供协议层 backend 与 agentFactory 共用)
  // knowledgeBase / contextComposer 直连引用已移除（T11-P2：kb 域承载
  // 持久化 + composer 运行时条件），UI 不再持有组件对象

  const statsManager = new StatsManager();

  // ── Channel bridge ──
  const tuiChannel = new TuiChannel();
  const channelManager = new ChannelManager();
  channelManager.register(tuiChannel, { enabled: true });

  // 自动检测配置驱动渠道（飞书等），有配置则自动注册
  await registerConfigChannels(channelManager, process.cwd());

  // 调用所有插件的 onGatewayInit 钩子（如飞书 SDK 日志拦截）
  const cleanupFns: Array<() => void> = [];
  for (const plugin of getChannelPlugins()) {
    if (plugin.onGatewayInit) {
      const cleanup = plugin.onGatewayInit();
      if (cleanup) cleanupFns.push(cleanup);
    }
  }

  // 为所有渠道注入 TUI 同步回调（渠道自行决定是否启用 tuiSync）
  for (const state of channelManager.getAll()) {
    if (state.handler.id === 'tui') continue;
    state.config = {
      ...state.config,
      onUserMessage: (label: string, content: string) => {
        chatLog.addSystem(`💬 [${state.handler.name}:${label}] ${content}`);
        tui.requestRender();
      },
      onAgentReply: (content: string) => {
        chatLog.addSystem(`📤 [${state.handler.name}回复] ${content}`);
        tui.requestRender();
      },
    };
  }

  tuiChannel.onReply = (content: string) => {
    chatLog.addSystem(content);
    tui.requestRender();
  };

  // (agentFactory 已在上面统一定义，供 UiProtocolSession.initialize 创建 loop)

  // 设置 TUI 渠道的消息处理回调
  if (remoteWs) {
    // ── 远程模式：通过 WebSocket 连接统一后端（协议层 message.*）──
    chatLog.addSystem(theme.success('🔗 Connected to running backend (port 3000)'));

    // client 端接收协议消息：response → resolve 请求；event → handleProtocolEvent
    // （与本地模式 protocolClient.onMessage 完全一致的协议分发）
    remoteWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as UiMessage;
        if (msg.kind === 'response') {
          const cb = pendingRequests.get(msg.id);
          if (cb) {
            pendingRequests.delete(msg.id);
            cb(msg as UiResponse);
          }
          return;
        }
        if (msg.kind !== 'event') return;
        handleProtocolEvent(msg as UiEvent);
      } catch { /* ignore */ }
    });

    remoteWs.on('close', () => {
      chatLog.addSystem(theme.warning('⚠ Backend connection lost. Restart to reconnect.'));
    });
  }

  // 消息发送统一走协议层 message.chat → server 端 loop.run →
  // message.* 事件回传 → handleProtocolEvent 驱动 UI（本地 InProc / 远程 WS 一致）。
  // 状态栏刷新由 turn_info 事件（MESSAGE_TURN_INFO）驱动，无需本地直读 stats。
  tuiChannel.onHandleMessage = async (event: ChannelMessageEvent) => {
    await protocolSend('message.chat', { content: event.content });
  };

  // 启动所有渠道（每个渠道自行处理消息）
  await channelManager.startAll(agentFactory);

  // ── 跨渠道消息发送工具 ────────────────────────────────────
  //
  // 在 channelManager.startAll() 之后注册，此时所有渠道已启动。
  // 工具内通过 ChannelManager.get() 查找目标渠道并调用其 send()。
  // 仅在本地 TUI 模式下注册——远程模式（remoteWs）下工具由服务端提供。
  if (localComponents) {
    // 跨渠道发送工具注册到共享组件 toolRegistry（本地 InProc 模式下
    // components 即 UiProtocolSession 持有的同一组组件）
    const { MessageDispatcher, createSendChannelMessageTool } = await import('../channels/dispatcher.js');
    const dispatcher = new MessageDispatcher(channelManager);
    const toolRegistry = (localComponents as unknown as { toolRegistry?: { register(t: unknown): void } }).toolRegistry;
    toolRegistry?.register(createSendChannelMessageTool(dispatcher));
  }

  // ── Welcome（tui-welcome.ts，tui.ts 深拆第四批）──
  await showWelcome({ tui, chatLog, personaDir, sessionDir });
  // ── Input state ──
  let isProcessing = false;
  const messageQueue = new MessageQueue();
  let inputHistory: string[] = [];
  let historyIndex = -1;

  // ── History persistence ──
  const historyFilePath = path.join(os.homedir(), '.agent', 'history.json');
  const HISTORY_MAX = 500;
  try {
    if (fs.existsSync(historyFilePath)) {
      const raw = fs.readFileSync(historyFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        inputHistory = parsed.slice(-HISTORY_MAX);
      }
    }
  } catch { /* ignore corrupt history */ }

  function saveHistory(): void {
    try {
      const dir = path.dirname(historyFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(historyFilePath, JSON.stringify(inputHistory.slice(-HISTORY_MAX), null, 2), 'utf-8');
    } catch { /* ignore write errors */ }
  }

  function updateTokenEstimate(): void {
    const text = editor.getText();
    const estimated = Math.ceil(text.length / 4);
    // provider/model 用本地缓存（纯协议客户端化，不读 loop）
    let footer = theme.dim(
      `Ctrl+C exit | Ctrl+L clear | Ctrl+P provider | Ctrl+F search | Ctrl+T tools`,
    );

    // Context-aware hints
    if (isThinking) {
      footer += theme.accent(' | Esc to stop');
    }
    if (tuiPermission.hasPending()) {
      footer += theme.warning(' | \u2190\u2192 select  Enter confirm');
    }
    if (bgRunningCount > 0) {
      footer += theme.accent(` | \u2699 ${bgRunningCount} bg process(es)`);
    }

    footer += theme.dim(`\n${providerTypeStart} \u00b7 ${modelName} \u00b7 ~${estimated} tokens`);

    if (messageQueue.size > 0) {
      footer += theme.fg(` | Queue: ${messageQueue.size}`);
    }
    footerText.setText(footer);
  }

  function truncateMsg(text: string, max = 40): string {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  /**
   * Process one message through the agent loop, then drain any queued messages.
   * Called by handleInput when the agent is idle.
   */
  async function processBatch(initialText: string): Promise<void> {
    let text: string | undefined = initialText;

    while (text !== undefined) {
      isProcessing = true;
      editor.setText('');

      chatLog.addUser('❯ ' + text);
      chatLog.addSystem(theme.dim('─'.repeat(30)));

      try {
        const sid = sessionDir.split(/[\\/]/).pop() ?? 'tui-default';
        await tuiChannel.sendMessage(sid, text);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        chatLog.addSystem(theme.errorBright('[Error] ') + theme.error(message));
      }

      isProcessing = false;

      // Check queue for pending messages
      const next = messageQueue.dequeue();
      text = next?.text;
    }

    updateTokenEstimate();
    tui.requestRender();
  }

  async function handleInput(text: string): Promise<void> {
    let input = text.trim();
    if (!input) {
      // 定时任务完成后队列中有待处理消息 → 空回车触发队列消费
      if (!isProcessing && !pendingTaskLocal && messageQueue.size > 0) {
        const next = messageQueue.dequeue();
        if (next) await processBatch(next.text);
      }
      return;
    }

    // Push to history
    if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== input) {
      inputHistory.push(input);
      if (inputHistory.length > HISTORY_MAX) {
        inputHistory.shift();
      }
      saveHistory();
    }
    historyIndex = -1;

    if (input === 'exit' || input === 'quit') {
      chatLog.addSystem(theme.dim('Goodbye.'));
      tui.requestRender();
      await channelManager.stopAll();
      // 清理插件钩子
      for (const cleanup of cleanupFns) cleanup();
      await supervisor.shutdownAll();
      tui.stop();
      process.exit(0);
    }

    // ── model/local/* 命令处理器（tui-model-local.ts，tui.ts 深拆第五批）──
    const modelLocalCmds = createModelLocalCmds({
      tui,
      chatLog,
      localModel,
      supervisor,
      protocolSend,
      setConfig,
      refreshStatusFromProtocol,
    });

    // ── model 非 local 命令处理器（tui-model-cmds.ts，tui.ts 深拆第六批）──
    const modelCmds = createModelCmds({
      tui,
      chatLog,
      localModel,
      protocolSend,
      setConfig,
      refreshStatusFromProtocol,
      getProviderType: () => providerTypeStart,
      getModelName: () => modelName,
      applyThinking,
      updateTokenEstimate,
      getShowThinking: () => showThinking,
      setShowThinking: (v) => { showThinking = v; },
    });

    // ── compress/* 命令处理器（tui-compress-cmds.ts，tui.ts 深拆第七批）──
    const compressCmds = createCompressCmds({
      tui,
      chatLog,
      setConfig,
      updateTokenEstimate,
    });

    // ── channel/* 命令处理器（tui-channel-cmds.ts，tui.ts 深拆第八批）──
    const channelCmds = createChannelCmds({
      tui,
      chatLog,
      // 协议发送器（lazy getter：protocolSend 在 initialize 后才赋值，取最新值）
      getProtocolSend: () => protocolSend,
      // 通道 registry 降级源：本地模式读共享组件（components.loop.modelRouter，
      // 与宿主进程内同一实例）；远程模式为 null（纯协议路径）
      getChannelRegistry: () => {
        const compLoop = (localComponents as Record<string, unknown> | null)?.loop as
          | { modelRouter?: { getRegistry(): ChannelRegistryLike } }
          | undefined;
        return compLoop?.modelRouter?.getRegistry() ?? null;
      },
    });

    // ── 通用渠道命令分发（tui-channel-cmds.ts createChannelDispatch，第十批）──
    const channelDispatch = createChannelDispatch({
      tui,
      chatLog,
      getChannelManager: () => channelManager,
    });

    // ── session/* 命令处理器（tui-session-cmds.ts，tui.ts 深拆第九批）──
    const sessionCmds = createSessionCmds({
      tui,
      chatLog,
      updateTokenEstimate,
      protocolSend,
      statsManager,
      refreshStatus,
      // 会话切换后的即时状态刷新：本地合成 TurnInfo（不再经 loop，纯协议客户端化）
      getLoop: () => ({
        getTurnInfo: (tc: number, tu: number) => ({
          turnCount: tc, maxTurns, tokensUsed: tu, maxContextTokens: maxContext, sessionId: sessionDir, compressCount: 0,
        }),
      }),
      getSessionDir: () => sessionDir,
      setSessionDir: (d) => { sessionDir = d; },
      setLastTurnCount: (n) => { lastTurnCount = n; },
      setLastTokensUsed: (n) => { lastTokensUsed = n; },
    });
    // 二级菜单：检查命令是否有 children
    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
      const cmdDef = CommandRegistry.getInstance().find(cmdName);
      if ((cmdDef?.children && cmdDef.children.length > 0) || !!cmdDef?.childrenProvider) {
        const args = spaceIdx > 0 ? input.slice(spaceIdx + 1).trim() : '';

        // Build dynamic entries for /model L1 panel
        let effectiveDef = cmdDef;
        if (cmdName === 'model') {
          const dynamicChildren: SlashCommandDef[] = [];
          // a) Current online model
          // a) Current online model（本地缓存 providerTypeStart/modelName）
          dynamicChildren.push({
            name: 'current_online',
            description: `${providerTypeStart} (online) - ${modelName}`,
            icon: '\u2601',
            category: 'model',
          });
          // b) Local models
          for (const m of localModel.list()) {
            const isRunning = localModel.getBridge().isRunning(m.name);
            const status = isRunning ? '\u25C9 running' : '\u25CB stopped';
            dynamicChildren.push({
              name: 'local_' + m.name,
              description: `${m.name} (local) - ${status}`,
              icon: '\u{1F4BB}',
              category: 'model',
            });
          }
          effectiveDef = {
            ...cmdDef,
            children: [...dynamicChildren, ...(cmdDef.children ?? [])],
          };
        }

        if (!args) {
          // 无参数 → 弹出二级面板
          slashSubPanelActive = true;
          const panel = new SlashSubPanel(effectiveDef);
          panel.show(tui, (result) => {
            slashSubPanelActive = false;
            if (result) {
              // 如果叶子命令有 args 占位符 → 自动填充到输入框，让用户继续输入
              const leafDef = CommandRegistry.getInstance().find(result.path);
              if (leafDef?.args && !leafDef.children && !leafDef.childrenProvider) {
                editor.setText(`/${result.path} `);
                updateTokenEstimate();
                return;
              }
              handleSlashSubCommand(result.path, '');
            }
          });
          return;
        }

        // 有参数 → 解析子命令路径并直接执行
        const subSpaceIdx = args.indexOf(' ');
        const subCmdName = subSpaceIdx > 0 ? args.slice(0, subSpaceIdx) : args;
        const subArgs = subSpaceIdx > 0 ? args.slice(subSpaceIdx + 1) : '';
        const subCmd = cmdDef?.children?.find(
          (c: { name: string }) => c.name.toLowerCase() === subCmdName.toLowerCase(),
        );
        if (subCmd) {
          handleSlashSubCommand(`${cmdName}/${subCmd.name}`, subArgs);
          return;
        }

        const childNames = (cmdDef?.children ?? []).map((c: { name: string }) => c.name).join(', ');
        chatLog.addSystem(
          theme.warning(`Unknown sub-command: /${cmdName} ${subCmdName}`) +
            theme.dim(`\nAvailable: /${cmdName} ${childNames}`),
        );
        tui.requestRender();
        return;
      }
    }

    // ===== Sub-Command Handler =====
    /**
     * 经协议层写配置（config.set 自动持久化到 configCenter.save()，
     * 替代直连 cfg.set + cfg.save / persistConfigField 的组合）。
     * 与直连期语义差异：持久化优先写项目级配置（ConfigManager 设计），
     * 而非固定写全局 ~/.agent/config.json——与 cfg.save() 既有行为一致。
     */
    async function setConfig(path: string, value: unknown): Promise<void> {
      await protocolSend('config.set', { path, value });
    }

    /** /model thinking 公共逻辑 */
    async function applyThinking(action: string): Promise<void> {
      // provider 类型用本地缓存（providerTypeStart，由事件/命令维护，不读 loop）
      const providerType = providerTypeStart;

      const effortOptions: Record<string, { label: string; effort: string | number }> = {};
      if (providerType === 'deepseek') {
        effortOptions.high = { label: 'high', effort: 'high' };
        effortOptions.max = { label: 'max', effort: 'max' };
      } else if (providerType === 'anthropic') {
        effortOptions['4k'] = { label: '4K', effort: 4000 };
        effortOptions['8k'] = { label: '8K', effort: 8000 };
        effortOptions['16k'] = { label: '16K', effort: 16000 };
        effortOptions['32k'] = { label: '32K', effort: 32000 };
      }

      if (action === 'on') {
        await setConfig('provider.enableThinking', true);
        // 运行时热改经协议层 model.setThinking（与 WebUI 同路径，域委托活跃 Provider）
        await protocolSend('model.setThinking', { enabled: true });
        chatLog.addSystem(theme.success('Thinking enabled'));
      } else if (action === 'off') {
        await setConfig('provider.enableThinking', false);
        await protocolSend('model.setThinking', { enabled: false });
        chatLog.addSystem(theme.success('Thinking disabled'));
      } else if (effortOptions[action]) {
        const opt = effortOptions[action];
        await setConfig('provider.enableThinking', true);
        await protocolSend('model.setThinking', { enabled: true, effort: opt.effort });
        chatLog.addSystem(theme.success(`Thinking enabled (${opt.label})`));
      } else {
        const optsStr = Object.entries(effortOptions)
          .map(([k, v]) => `  ${k}  → ${v.label}`)
          .join('\n');
        chatLog.addSystem(theme.warning(`Usage: /model thinking <on|off${optsStr ? '|' + Object.keys(effortOptions).join('|') : ''}>` + (optsStr ? '\n' + optsStr : '')));
      }
      tui.requestRender();
      updateTokenEstimate();
    }

    /**
     * 通用 handler 路由：根据 "module.method" 格式的 handler 字符串，
     * 动态查找并调用对应模块的方法。
     */
    function resolveHandler(
      handlerStr: string,
      args: string | undefined,
      localModel: LocalModelModule,
      chatLog: ChatLog,
      themeObj: typeof theme,
      tui: TUI,
    ): boolean {
      const parts = handlerStr.split('.');
      if (parts.length < 2) return false;

      const moduleName = parts[0];
      const methodChain = parts.slice(1);

      let target: unknown;
      if (moduleName === 'localModel') {
        target = localModel;
      } else {
        return false;
      }

      let fn: unknown = target;
      for (const prop of methodChain) {
        if (fn && typeof fn === 'object' && prop in fn) {
          fn = (fn as Record<string, unknown>)[prop];
        } else {
          chatLog.addSystem(themeObj.error(`Command handler not found: ${handlerStr}`));
          tui.requestRender();
          return true;
        }
      }

      if (typeof fn !== 'function') {
        chatLog.addSystem(themeObj.error(`Command handler not found: ${handlerStr}`));
        tui.requestRender();
        return true;
      }

      try {
        const result = args ? (fn as (a: string) => unknown)(args) : (fn as () => unknown)();
        if (result instanceof Promise) {
          result.then((val) => {
            if (val !== undefined && val !== null) {
              const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
              chatLog.addSystem(themeObj.success(display));
            }
            tui.requestRender();
          }).catch((err: Error) => {
            chatLog.addSystem(themeObj.error(`Handler error: ${err.message}`));
            tui.requestRender();
          });
        } else if (result !== undefined && result !== null) {
          const display = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
          chatLog.addSystem(themeObj.success(display));
        }
      } catch (err) {
        chatLog.addSystem(themeObj.error(`Handler error: ${(err as Error).message}`));
        tui.requestRender();
        return true;
      }

      return true;
    }

    /**
     * 处理二级菜单子命令的执行。
     * path 格式: "model/switch" / "model/provider" 等
     */

    async function handleSlashSubCommand(cmdPath: string, restArgs: string): Promise<void> {
      // ── session/* 会话管理（tui-session-cmds.ts，tui.ts 深拆第九批）──
      if (cmdPath.startsWith('session/')) {
        await sessionCmds.handle(cmdPath, restArgs);
        return;
      }

      switch (cmdPath) {
        // ── model 非 local 命令（tui-model-cmds.ts，tui.ts 深拆第六批）──
        case 'model/settings/switch':
        case 'model/switch':
        case 'model/settings/provider':
        case 'model/provider':
        case 'model/settings/source':
        case 'model/source':
        case 'model/settings/thinking':
        case 'model/thinking':
        case 'model/settings/thinking/on':
        case 'model/thinking/on':
        case 'model/settings/thinking/off':
        case 'model/thinking/off':
        case 'model/settings/thinking/high':
        case 'model/thinking/high':
        case 'model/settings/thinking/max':
        case 'model/thinking/max':
        case 'model/settings/thinking/4k':
        case 'model/thinking/4k':
        case 'model/settings/thinking/8k':
        case 'model/thinking/8k':
        case 'model/settings/thinking/16k':
        case 'model/thinking/16k':
        case 'model/settings/thinking/32k':
        case 'model/thinking/32k':
        case 'model/settings/show-thinking':
        case 'model/show-thinking':
        case 'model/settings/info':
        case 'model/info':
        case 'model/settings/context': {
          await modelCmds.handle(cmdPath, restArgs);
          return;
        }

        // ── 本地模型 L2（tui-model-local.ts，tui.ts 深拆第五批）──
        case 'model/local/start':
        case 'model/local/stop':
        case 'model/local/status':
        case 'model/local/switch':
        case 'model/local/register':
        case 'model/local/unregister':
        case 'model/local/detect': {
          await modelLocalCmds.handle(cmdPath, restArgs);
          return;
        }

        default: {
          // model 在线/L1 + 压缩器控制（tui-model-cmds / tui-compress-cmds，第七批）──
          if (cmdPath.startsWith('model/')) {
            await modelCmds.handle(cmdPath, restArgs);
            return;
          }
          if (cmdPath.startsWith('compress/')) {
            await compressCmds.handle(cmdPath, restArgs);
            return;
          }

          // ── channel/* 通道管理（tui-channel-cmds.ts，tui.ts 深拆第八批）──
          if (cmdPath.startsWith('channel/')) {
            await channelCmds.handle(cmdPath, restArgs);
            return;
          }

          // 通用渠道命令分发（tui-channel-cmds.ts createChannelDispatch，第十批）──
          if (await channelDispatch.handle(cmdPath, restArgs)) return;

          // 通用 handler 路由：查找命令定义的 handler 字段
          const cmdDef = CommandRegistry.getInstance().find(cmdPath);
          if (cmdDef?.handler) {
            resolveHandler(cmdDef.handler, restArgs, localModel, chatLog, theme, tui);
            return;
          }
          chatLog.addSystem(theme.warning(`Unknown sub-command: /${cmdPath}`));
          tui.requestRender();
        }
      }
    }

    // Local slash commands
    if (input === '/help') {
      const grouped = getCommandsByCategory();
      const BOX_H_L = '\u2500';
      chatLog.addSystem(theme.fg('\u256d' + BOX_H_L.repeat(56) + '\u256e'));
      chatLog.addSystem(theme.fg('\u2502  Available Commands'));
      chatLog.addSystem(theme.fg('\u2570' + BOX_H_L.repeat(56) + '\u256f'));
      chatLog.addSystem('');
      for (const [category, cmds] of grouped) {
        const catLabel = getCategoryLabel(category);
        chatLog.addSystem(theme.accent('\u2500\u2500 ' + catLabel + ' \u2500\u2500'));
        for (const c of cmds) {
          if (c.deprecated) {
            chatLog.addSystem(
              '  ' + theme.dim(c.icon) + ' ' + theme.dim('/' + c.name) +
              theme.dim(' ' + c.description) + theme.warning(' [deprecated]'),
            );
          } else {
            const args = c.args ? theme.dim(' ' + c.args) : '';
            const hasChildren = c.children ? theme.accent(' \u25B8') : '';
            chatLog.addSystem(
              '  ' + theme.accent(c.icon) + ' ' + theme.fg('/' + c.name) +
              hasChildren + args + theme.dim(' ' + c.description),
            );
          }
        }
        chatLog.addSystem('');
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    if (input === '/clear') {
      chatLog.clearAll();
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    if (input === '/collapse') {
      const expanded = chatLog.toggleToolsExpanded();
      chatLog.addSystem(
        theme.dim('Tool outputs ') + theme.fg(expanded ? 'expanded' : 'collapsed'),
      );
      tui.requestRender();
      return;
    }

    if (input === '/orchestrator on') {
      // orchestrator 域 setEnabled：激活旁路 Agent + 同步持久化 bypass 状态
      // （bypass 管理器不可用时域层报错，前置检查移除 —— 纯协议客户端化）
      await protocolSend('orchestrator.setEnabled', { enabled: true });
      chatLog.addSystem(theme.success('上下文编排旁路Agent 已开启'));
      tui.requestRender();
      return;
    }
    if (input === '/orchestrator off') {
      await protocolSend('orchestrator.setEnabled', { enabled: false });
      chatLog.addSystem(theme.dim('上下文编排旁路Agent 已关闭'));
      tui.requestRender();
      return;
    }

    if (input === '/default-mode companion') {
      await setConfig('startup.defaultMode', 'companion');
      chatLog.addSystem(theme.success('启动默认模式已设为 陪伴模式 💫（下次启动生效）'));
      tui.requestRender();
      return;
    }
    if (input === '/default-mode normal') {
      await setConfig('startup.defaultMode', 'normal');
      chatLog.addSystem(theme.dim('启动默认模式已设为 普通模式 💻（下次启动生效）'));
      tui.requestRender();
      return;
    }

    if (input === '/zone4 on') {
      // kb.setZone4：域层同时持久化 kb.zone4 + 同步 composer 运行时条件
      // （zone4_enabled），本地不再补 activeConditions（纯协议客户端化）
      await protocolSend('kb.setZone4', { enabled: true });
      chatLog.addSystem(theme.success('Zone 4 已开启'));
      tui.requestRender();
      return;
    }
    if (input === '/zone4 off') {
      await protocolSend('kb.setZone4', { enabled: false });
      chatLog.addSystem(theme.dim('Zone 4 已关闭（知识库同步停用）'));
      tui.requestRender();
      return;
    }

    if (input === '/kb on') {
      // 当前 zone4 状态经协议 kb.get 读取（不再持有 knowledgeBase 引用）
      const kbRes = (await protocolSend('kb.get')) as { kb?: { zone4Enabled?: boolean } } | null | undefined;
      if (!(kbRes?.kb?.zone4Enabled ?? true)) {
        await protocolSend('kb.setZone4', { enabled: true });
        chatLog.addSystem(theme.dim('Zone 4 已同步开启'));
      }
      await protocolSend('kb.setEnabled', { enabled: true });
      chatLog.addSystem(theme.success('知识库已开启 — Zone 4 将注入检索结果'));
      tui.requestRender();
      return;
    }
    if (input === '/kb off') {
      await protocolSend('kb.setEnabled', { enabled: false });
      chatLog.addSystem(theme.dim('知识库已关闭'));
      tui.requestRender();
      return;
    }


    if (input === '/exit') {
      chatLog.addSystem(theme.dim('Goodbye.'));
      tui.requestRender();
      await channelManager.stopAll();
      await supervisor.shutdownAll();
      tui.stop();
      process.exit(0);
    }

    const cfg = RuntimeConfigCenter.getInstance();

    if (input === '/status') {
      const s = cfg.getAll();
      const items: [string, unknown][] = [
        ['Provider', s.provider.active],
        ['Model', s.provider[s.provider.active as keyof typeof s.provider] as { model?: string } | string[] | undefined],
        ['Active Workflow', 'none'],
        ['Max Context', `${s.session.maxContext.toLocaleString()} tokens`],
        ['Max Turns', s.session.maxTurns],
        ['Compress Threshold', s.context.compressThreshold.toFixed(2)],
        ['Confirmation', s.safety.requireConfirmation ? 'on' : 'off'],
        ['Scavenge', s.repair.scavenge.enabled ? 'on' : 'off'],
        ['Storm', s.repair.storm.enabled ? 'on' : 'off'],
        ['Storm Window', s.repair.storm.windowSize],
        ['Storm Threshold', s.repair.storm.threshold],
        ['Log Level', s.logging.level],
      ];
      chatLog.addSystem(theme.accent('\u2500\u2500 Status \u2500\u2500'));
      for (const [label, value] of items) {
        let display: string;
        if (typeof value === 'object' && value !== null && 'model' in value) {
          display = String((value as { model: string }).model);
        } else {
          display = String(value ?? 'N/A');
        }
        chatLog.addSystem('  ' + theme.fg(label) + theme.dim(': ') + theme.fg(display));
      }

      // 各角色模型来源经协议 model.sources 读取（不读 loop）
      const srcRes = (await protocolSend('model.sources')) as
        | { sources?: Record<string, string> | null }
        | null
        | undefined;
      const sources = srcRes?.sources ?? null;
      if (sources) {
        chatLog.addSystem('');
        chatLog.addSystem(theme.accent('\u2500\u2500 Model Routing \u2500\u2500'));
        const labels: Record<string, string> = {
          assessment: '评估',
          planning: '规划',
          compression: '压缩',
        };
        const sourceColor = (src: string) => src === 'local' ? theme.success(src) : theme.accent(src);
        for (const [role, source] of Object.entries(sources)) {
          const label = labels[role] ?? role;
          chatLog.addSystem('  ' + theme.fg(label) + theme.dim(': ') + sourceColor(String(source)));
        }
      }
      chatLog.addSystem('');
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /context <tokens> ──
    if (input.startsWith('/context ')) {
      const tokens = parseInt(input.slice(9).trim(), 10);
      const modelCtxWindow = getModelContextWindow(providerTypeStart, modelName);
      const upper = modelCtxWindow; // 当前模型支持的最大上下文
      if (isNaN(tokens) || tokens < 1 || tokens > upper) {
        chatLog.addSystem(theme.warning(`Usage: /context <1-${upper.toLocaleString()}>`) + theme.dim(` (model: ${modelName})`));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      await setConfig('session.maxContext', tokens);
      chatLog.addSystem(theme.success('Max context set to ') + theme.fg(tokens.toLocaleString() + ' tokens'));
      await refreshStatusFromProtocol();
      updateTokenEstimate();
      return;
    }

    // ── /turns <n> ──
    if (input.startsWith('/turns ')) {
      const n = parseInt(input.slice(7).trim(), 10);
      if (isNaN(n) || n < 1 || n > 100) {
        chatLog.addSystem(theme.warning('Usage: /turns <1-100>'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      await setConfig('session.maxTurns', n);
      chatLog.addSystem(theme.success('Max turns set to ') + theme.fg(String(n)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /threshold <0.0-1.0> ──
    
    // ── /compress sub-commands (handled via handleSlashSubCommand) ──

    // ── /threshold <0.0-1.0> (deprecated: use /compress threshold) ──
if (input.startsWith('/threshold ')) {
      const val = parseFloat(input.slice(11).trim());
      if (isNaN(val) || val < 0 || val > 1) {
        chatLog.addSystem(theme.warning('Usage: /threshold <0.0-1.0>'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      await setConfig('context.compressThreshold', val);
      chatLog.addSystem(theme.success('Compression threshold set to ') + theme.fg(val.toFixed(2)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /confirm on|off ──
    if (input.startsWith('/confirm ')) {
      const arg = input.slice(9).trim();
      if (arg === 'on') {
        await setConfig('safety.requireConfirmation', true);
        chatLog.addSystem(theme.success('Tool confirmation ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        await setConfig('safety.requireConfirmation', false);
        chatLog.addSystem(theme.warning('Tool confirmation ') + theme.fg('disabled'));
      } else {
        chatLog.addSystem(theme.warning('Usage: /confirm <on|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /log <level> ──
    if (input.startsWith('/log ')) {
      const arg = input.slice(5).trim();
      const validLevels = ['debug', 'info', 'warn', 'error', 'off'];
      if (validLevels.includes(arg)) {
        await setConfig('logging.level', arg as 'debug' | 'info' | 'warn' | 'error' | 'off');
        chatLog.addSystem(theme.success('Log level set to ') + theme.fg(arg));
      } else {
        chatLog.addSystem(theme.warning('Usage: /log <debug|info|warn|error|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /scavenge on|off ──
    if (input.startsWith('/scavenge ')) {
      const arg = input.slice(10).trim();
      if (arg === 'on') {
        await setConfig('repair.scavenge.enabled', true);
        chatLog.addSystem(theme.success('Scavenge repair ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        await setConfig('repair.scavenge.enabled', false);
        chatLog.addSystem(theme.warning('Scavenge repair ') + theme.fg('disabled'));
      } else {
        chatLog.addSystem(theme.warning('Usage: /scavenge <on|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /storm on|off ──
    if (input.startsWith('/storm ')) {
      const arg = input.slice(7).trim();
      if (arg === 'on') {
        await setConfig('repair.storm.enabled', true);
        chatLog.addSystem(theme.success('Storm protection ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        await setConfig('repair.storm.enabled', false);
        chatLog.addSystem(theme.warning('Storm protection ') + theme.fg('disabled'));
      } else {
        chatLog.addSystem(theme.warning('Usage: /storm <on|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /storm-win <2-20> ──
    if (input.startsWith('/storm-win ')) {
      const n = parseInt(input.slice(11).trim(), 10);
      if (isNaN(n) || n < 2 || n > 20) {
        chatLog.addSystem(theme.warning('Usage: /storm-win <2-20>'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      await setConfig('repair.storm.windowSize', n);
      chatLog.addSystem(theme.success('Storm window size set to ') + theme.fg(String(n)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /storm-th <1-10> ──
    if (input.startsWith('/storm-th ')) {
      const n = parseInt(input.slice(10).trim(), 10);
      if (isNaN(n) || n < 1 || n > 10) {
        chatLog.addSystem(theme.warning('Usage: /storm-th <1-10>'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      await setConfig('repair.storm.threshold', n);
      chatLog.addSystem(theme.success('Storm threshold set to ') + theme.fg(String(n)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /schedule ──
    if (input === '/schedule') {
      // 经协议层 schedule.list 读取（与未来 WebUI 定时任务面板同路径）
      let tasks: Array<{ name: string; enabled?: boolean; nextRunAt?: unknown; scheduleType?: string; runCount?: number }> = [];
      try {
        const res = (await protocolSend('schedule.list')) as { tasks?: typeof tasks } | null | undefined;
        tasks = res?.tasks ?? [];
      } catch {
        chatLog.addSystem(theme.dim('No scheduler configured'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      const activeTasks = tasks.filter(
        (t: { enabled?: boolean; nextRunAt?: unknown }) => t.enabled && t.nextRunAt !== null,
      );
      const disabledCount = tasks.length - activeTasks.length;
      if (activeTasks.length === 0) {
        chatLog.addSystem(theme.dim('No active scheduled tasks'));
        if (disabledCount > 0) {
          chatLog.addSystem(
            theme.dim(`(+${disabledCount} disabled/expired tasks)`),
          );
        }
      } else {
        chatLog.addSystem(
          theme.accent(`Scheduled Tasks (${activeTasks.length} active)`),
        );
        for (const task of activeTasks) {
          const nextRun = task.nextRunAt
            ? new Date(task.nextRunAt as string).toLocaleString()
            : 'N/A';
          const typeLabel = theme.dim(`[${task.scheduleType}]`);
          const runInfo = theme.dim(` | runs: ${task.runCount}`);
          chatLog.addSystem(
            '  ' +
              theme.fg(task.name) +
              ' ' +
              typeLabel +
              theme.dim(' | next: ') +
              theme.fg(nextRun) +
              runInfo,
          );
        }
        if (disabledCount > 0) {
          chatLog.addSystem(
            theme.dim(`(+${disabledCount} disabled/expired tasks not shown)`),
          );
        }
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /schedule-add <name> <time> ──
    if (input.startsWith('/schedule-add ')) {
      const args = input.slice(14).trim();
      const spaceIdx = args.lastIndexOf(' ');
      if (spaceIdx < 0) {
        chatLog.addSystem(
          theme.warning('Usage: /schedule-add <name> <HH:mm>'),
        );
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      const name = args.slice(0, spaceIdx).trim();
      const time = args.slice(spaceIdx + 1).trim();

      if (!/^\d{2}:\d{2}$/.test(time)) {
        chatLog.addSystem(
          theme.warning('Time must be in HH:mm format (e.g., 02:00)'),
        );
        tui.requestRender();
        updateTokenEstimate();
        return;
      }

      // 定时任务添加经协议层 schedule.addDaily（与 schedule 域同路径）
      try {
        await protocolSend('schedule.addDaily', { name, time });
      } catch (err) {
        chatLog.addSystem(theme.warning(`Task add failed: ${(err as Error).message}`));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      chatLog.addSystem(
        theme.success('Task added: ') +
          theme.fg(name) +
          theme.dim(' at ') +
          theme.fg(time) +
          theme.dim(' daily'),
      );
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /restart ──
    if (input === '/restart') {
      chatLog.addSystem(theme.accent('Restarting...'));
      tui.requestRender();
      const fsSync = (await import('node:fs')).default;
      const restartFile = path.join(os.homedir(), '.agent', '.restart-session');
      fsSync.mkdirSync(path.dirname(restartFile), { recursive: true });
      fsSync.writeFileSync(restartFile, path.basename(sessionDir), 'utf-8');
      setTimeout(() => process.exit(42), 200);
      return;
    }

    // ── /new ──
    if (input === '/new') {
      chatLog.addSystem(theme.accent('Starting new session...'));
      tui.requestRender();
      const fsSync = (await import('node:fs')).default;
      const newFlag = path.join(os.homedir(), '.agent', '.new-session');
      fsSync.mkdirSync(path.dirname(newFlag), { recursive: true });
      fsSync.writeFileSync(newFlag, 'true', 'utf-8');
      setTimeout(() => process.exit(42), 200);
      return;
    }

    // ── Message Queue Integration ──
    /** 中断当前回合：统一经协议 message.stop（域转发 loop.interrupt），
     *  本地/远程一致，不直接持有 loop */
    const interruptNow = async (): Promise<void> => {
      try { await protocolSend('message.stop'); } catch { /* ignore */ }
    };

    const mode = MessageQueue.detectMode(input);
    const cleanText = MessageQueue.stripMarkers(input);

    if (isProcessing || pendingTaskLocal) {
      messageQueue.enqueue(cleanText, mode);
      if (mode === QueueMessageMode.Insert) {
        chatLog.addSystem(theme.warning(`\u23e9 Inserting: ${truncateMsg(cleanText)}`));
        await interruptNow();
      } else {
        chatLog.addSystem(theme.dim(`\u23f3 Queued (#${messageQueue.size}): ${truncateMsg(cleanText)}`));
      }
      updateTokenEstimate();
      tui.requestRender();
      return;
    }

    await processBatch(cleanText);
  }

  // ── Editor callbacks ──
  editor.onSubmit = (text: string) => {
    void handleInput(text);
  };

  editor.onCtrlC = () => {
    editor.setText('');
    if (isProcessing) {
      // 经协议 message.stop 中断当前回合（不直接持有 loop）
      void protocolSend('message.stop').catch(() => {});
    } else {
      chatLog.addSystem(theme.warning('Ctrl+C \u2014 press again to exit'));
    }
    tui.requestRender();
  };


  // ── 搜索浮层（tui-search.ts，tui.ts 深拆第一批）──
  const tuiSearch = createTuiSearch({ tui, chatLog });
  editor.onEscape = () => {
    tuiSearch.closeIfOpen();
    tui.requestRender();
  };

  editor.onCtrlL = () => {
    chatLog.clearAll();
    tui.requestRender();
  };

  editor.onCtrlP = () => {
    void (async () => {
      try {
        // 循环切换主 provider：经协议 model.toggle（委托 loop.toggleProvider）
        await protocolSend('model.toggle');
      } catch {
        chatLog.addSystem(theme.dim('Provider toggle failed (model.toggle unavailable)'));
        tui.requestRender();
        return;
      }
      // 切换后经 state.get 读回当前 provider/model 快照（不再直读 loop）
      const snap = (await protocolSend('state.get')) as
        | { provider?: string; model?: string; providerLabel?: string; routeMode?: string }
        | null
        | undefined;
      if (snap?.provider) {
        modelName = snap.model ?? '';
        providerTypeStart = snap.provider as typeof providerTypeStart;
        chatLog.addSystem(
          theme.accent('Provider toggled to ') +
            theme.fg(snap.providerLabel ?? snap.provider) +
            theme.dim(` (${snap.routeMode ?? ''})`),
        );
      } else {
        chatLog.addSystem(theme.dim('No ProviderRouter configured.'));
      }
      tui.requestRender();
    })();
  };

  // ── Queue cancellation: Backspace on empty input pops last queued message ──
  editor.onBackspaceOnEmpty = () => {
    if (messageQueue.isEmpty()) return;
    const removed = messageQueue.pop();
    if (removed) {
      chatLog.addSystem(
        theme.dim(
          `[queue] removed: "${truncateMsg(removed.text)}" (${messageQueue.size} remaining)`,
        ),
      );
      updateTokenEstimate();
      tui.requestRender();
    }
  };

  // ── Slash command autocomplete ──
  const slashCommands = filterCommands('').map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    argumentHint: cmd.args,
  }));

  const autocomplete = new CombinedAutocompleteProvider(slashCommands, process.cwd());
  editor.setAutocompleteProvider(autocomplete);

  // ── Global input listeners (for shortcuts not caught by the editor) ──
  let ctrlCCount = 0;
  let lastCtrlCTime = 0;

  tui.addInputListener((data) => {
    // ── Slash autocomplete: Space → accept completion + insert space (never submit) ──
    // 只有回车键才发送消息，空格键仅用于接受补全并插入空格
    if (matchesKey(data, Key.space)) {
      const text = editor.getText().trimStart();
      if (text.startsWith('/') && !text.includes(' ') && editor.isShowingAutocomplete()) {
        // 接受补全并插入空格，让用户继续输入参数
        editor.handleInput('\t');
        editor.handleInput(' ');
        return { consume: true };
      }
    }

    // ── Ask User form: full keyboard navigation（tui-ask-user.ts 深拆第三批）──
    if (tuiAskUser.hasPending()) {
      tuiAskUser.handleKey(data);
      return { consume: true };
    }

    // ── Permission bar: Left/Right arrows + Enter ──
    if (tuiPermission.hasPending()) {
      if (matchesKey(data, Key.left)) {
        tuiPermission.moveLeft();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.right)) {
        tuiPermission.moveRight();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        tuiPermission.confirm();
        return { consume: true };
      }
      return { consume: true }; // consume all other keys during permission
    }

    // Ctrl+C double-tap exit (global, catches the case when editor is not the source)
    if (matchesKey(data, Key.ctrl('c'))) {
      const now = Date.now();
      if (now - lastCtrlCTime < 1000) {
        ctrlCCount++;
      } else {
        ctrlCCount = 1;
      }
      lastCtrlCTime = now;
      // Note: editor.onCtrlC handles the first press; this handles the second
      return undefined; // let editor handle Ctrl+C
    }

    // Ctrl+T: toggle tools expanded/collapsed
    if (matchesKey(data, Key.ctrl('t'))) {
      const expanded = chatLog.toggleToolsExpanded();
      chatLog.addSystem(
        theme.dim('Tools ') + theme.fg(expanded ? 'expanded' : 'collapsed'),
      );

      tui.requestRender();
      return { consume: true };
    }

    // Ctrl+F: toggle search overlay
    if (matchesKey(data, Key.ctrl('f'))) {
      tuiSearch.toggle();
      return { consume: true };
    }

    // PgUp: scroll chat up
    if (matchesKey(data, Key.pageUp)) {
      chatLog.scrollToLine(-10);
      tui.requestRender();
      return { consume: true };
    }

    // PgDn: scroll chat down
    if (matchesKey(data, Key.pageDown)) {
      chatLog.scrollToLine(10);
      tui.requestRender();
      return { consume: true };
    }

    // Home: jump to top
    if (matchesKey(data, Key.home)) {
      chatLog.scrollToLine(0);
      tui.requestRender();
      return { consume: true };
    }

    // End: jump to bottom
    if (matchesKey(data, Key.end)) {
      chatLog.pinToBottom();

      tui.requestRender();
      return { consume: true };
    }

    // Arrow Up: history browse (when editor text is empty)
    if (matchesKey(data, Key.up)) {
      if (slashSubPanelActive) return undefined;
      const currentText = editor.getText();
      if (currentText === '' && inputHistory.length > 0) {
        if (historyIndex === -1) {
          historyIndex = inputHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        editor.setText(inputHistory[historyIndex]);
        tui.requestRender();
        return { consume: true };
      }
    }

    // Arrow Down: history browse
    if (matchesKey(data, Key.down)) {
      if (slashSubPanelActive) return undefined;
      if (historyIndex >= 0) {
        if (historyIndex < inputHistory.length - 1) {
          historyIndex++;
          editor.setText(inputHistory[historyIndex]);
        } else {
          historyIndex = -1;
          editor.setText('');
        }
        tui.requestRender();
        return { consume: true };
      }
    }

    return undefined;
  });


  // ── Initial render ──
  // 初始状态经协议 state.get 获取（启动同步 provider/model 缓存 + 状态栏）
  const snap0 = (await protocolSend('state.get')) as
    | { provider?: string; model?: string; turnCount?: number; tokensUsed?: number; maxTurns?: number; maxContextTokens?: number; compressCount?: number; sessionId?: string }
    | null
    | undefined;
  if (snap0?.provider) providerTypeStart = snap0.provider as typeof providerTypeStart;
  if (snap0?.model) modelName = snap0.model;
  const stats0 = await statsManager.get(sessionDir);
  const initialInfo: TurnInfo = snap0
    ? {
        turnCount: snap0.turnCount ?? 0,
        tokensUsed: snap0.tokensUsed ?? 0,
        maxTurns: snap0.maxTurns ?? maxTurns,
        maxContextTokens: snap0.maxContextTokens ?? maxContext,
        compressCount: snap0.compressCount ?? 0,
        sessionId: snap0.sessionId ?? sessionDir,
      }
    : { turnCount: 0, tokensUsed: stats0.current_context_tokens ?? 0, maxTurns, maxContextTokens: maxContext, sessionId: sessionDir, compressCount: 0 };
  refreshStatus(initialInfo);
  updateTokenEstimate();

  // ── Start TUI ──
  tui.start();

  // ── Auto-send continuation message after restart ──
  if (continuationMessage) {
    // Use setImmediate to let the TUI render its initial frame first
    setImmediate(() => {
      handleInput(continuationMessage);
    });
  }

  // ── Wait for exit (Ctrl+C double-tap or Ctrl+D) ──
  const exitPromise = new Promise<void>((resolve) => {
    const checkExitInterval = setInterval(() => {
      if (ctrlCCount >= 2) {
        clearInterval(checkExitInterval);
        resolve();
      }
    }, 200);
  });

  await exitPromise;

  // ── Cleanup ──
  tui.stop();
  await channelManager.stopAll();
  // 清理插件钩子
  for (const cleanup of cleanupFns) cleanup();
  await supervisor.shutdownAll();
  process.stderr.write = origStderrWrite;
  logStream.end();
}










