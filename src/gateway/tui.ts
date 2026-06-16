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
import type { BootstrapStatus } from '../setup/persona-bootstrap.js';
import { StatsManager } from '../memory/stats.js';
import { ConfigManager } from '../setup/config.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import { RuntimeConfigCenter } from '../runtime/config-center.js';
import { ProviderManager } from '../provider/manager.js';
import { LifecycleSupervisor } from '../lifecycle/index.js';
import { createAgent } from './factory.js';
import { getBootstrapStatus, DEFAULT_PERSONA_DIR } from '../setup/persona-bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { TuiChannel } from '../channels/builtin/tui-channel.js';
import { ChannelManager } from '../channels/manager.js';
import { MessageQueue, QueueMessageMode } from '../channels/index.js';
import { registerConfigChannels, getChannelPlugins } from '../channels/auto-detect.js';
import type { AgentFactory, ChannelMessageEvent, ReplyFn } from '../channels/interface.js';
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
import { readRecentEvents, type ConversationEvent } from '../event-store.js';
import { LocalModelModule } from '../local-model/index.js';
import type { BackgroundProcessInfo } from '../tools/background-registry.js';
import { DownloadManager } from '../local-model/download-manager.js';

const logger = createLogger('tui');

// ─── Constants ────────────────────────────────────────────────────────────

const BOX_H = '\u2500'; // ─

// ─── Status Bar Formatters ────────────────────────────────────────────────

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK, fullwidth forms, emoji: count as 2
    w += (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) ||       // CJK Radicals, Kangxi, Ideographs
      (cp >= 0xac00 && cp <= 0xd7a3) ||       // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||       // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) ||       // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) ||       // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||       // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||       // Fullwidth Signs
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||     // Emoji & Symbols
      (cp >= 0x20000 && cp <= 0x2fa1f)        // CJK Extension
      ? 2 : 1;
  }
  return w;
}

function truncateByVisualWidth(s: string, maxVisualWidth: number): string {
  if (visualWidth(s) <= maxVisualWidth) return s;
  let w = 0;
  let result = '';
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (w + cw + 3 > maxVisualWidth) { result += '...'; break; }
    w += cw;
    result += ch;
  }
  return result;
}

function formatStatusBar(
  info: TurnInfo,
  modelName: string,
  providerInfo?: { providerLabel: string; isLocal: boolean; mode: string } | null,
  modeLabel?: string | null,
): string {
  const planInfo =
    info.planStepsTotal !== undefined
      ? `Plan: ${info.planStepsDone ?? 0}/${info.planStepsTotal}`
      : '';

  const modelDisplay = truncateByVisualWidth(modelName, 28);

  const providerPart = providerInfo
    ? theme.dim(' | ') +
      'Provider: ' +
      (providerInfo.isLocal ? theme.success : theme.accent)(providerInfo.providerLabel)
    : '';

  const parts = [
    theme.fg(' DeepThink'),
    theme.dim(' \u00b7 '),
    theme.accent(modelDisplay),
    theme.dim(' | '),
    `Turns: ${theme.fg(String(info.turnCount))}/${theme.fg(String(info.maxTurns))}`,
    providerPart,
  ];

  if (planInfo) {
    parts.push(theme.dim(' | '), planInfo);
  }

  if (modeLabel) {
    parts.push(theme.dim(' | '), theme.accent(modeLabel));
  }

  return parts.join('');
}

function formatContextBar(tokensUsed: number, maxTokens: number, width: number = 40): string {
  const ratio = Math.min(tokensUsed / maxTokens, 1);
  const filledW = Math.floor(ratio * width);
  const emptyW = width - filledW;
  const bar = '\u2588'.repeat(filledW) + '\u2591'.repeat(emptyW);

  let colorFn: (s: string) => string;
  if (ratio < 0.5) colorFn = theme.success;
  else if (ratio < 0.8) colorFn = theme.warning;
  else colorFn = theme.error;

  const usedK = (tokensUsed / 1000).toFixed(0) + 'K';
  const maxK = (maxTokens / 1000).toFixed(0) + 'K';
  const pct = (ratio * 100).toFixed(0) + '%';

  return theme.dim('Context: ') + colorFn(bar) + ' ' + theme.fg(pct) + theme.dim(` (${usedK} / ${maxK} tokens)`);
}

// ─── Event Replay ─────────────────────────────────────────────────────────

/**
 * Replay recent events from the previous session into the chat log.
 * Shows the last conversation on TUI re-entry.
 */
function replayEvents(chatLog: ChatLog, sessionDir: string): void {
  readRecentEvents(sessionDir, 50).then(events => {
    if (events.length === 0) return;

    chatLog.addSystem('── Previous Session ──');

    let pendingText = '';
    let pendingThinking = '';
    let userMsgSeen = false;

    for (const event of events) {
      switch (event.type) {
        case 'user_input':
          // Flush any pending thinking + text before showing user message
          if (pendingThinking) {
            pendingThinking = '';
          }
          if (pendingText) {
            chatLog.addSystem(pendingText);
            pendingText = '';
          }
          chatLog.addUser(event.content || '');
          userMsgSeen = true;
          break;

        case 'text':
          // Accumulate text chunks into one message
          pendingText += event.content || '';
          break;

        case 'thinking':
          pendingThinking += event.content || '';
          break;

        case 'tool_call':
          // Flush pending thinking + text before tool call
          if (pendingThinking) {
            pendingThinking = '';
          }
          if (pendingText) {
            chatLog.addSystem(pendingText);
            pendingText = '';
          }
          chatLog.startTool(
            event.id || 'replay',
            event.name || 'unknown',
            JSON.stringify(event.input || {}).slice(0, 100),
          );
          break;

        case 'tool_result':
          chatLog.updateToolResult(
            event.tool_use_id || 'replay',
            (event.content || '').slice(0, 500),
            { isError: event.name === 'error' },
          );
          break;

        case 'error':
          // 跳过回放中的原始错误日志（避免旧 session 的 API 错误 JSON 污染 UI）
          break;

        case 'stop':
          // Flush remaining thinking + text
          if (pendingThinking) {
            pendingThinking = '';
          }
          if (pendingText) {
            chatLog.addSystem(pendingText);
            pendingText = '';
          }
          break;

        default:
          break;
      }
    }

    // Flush any remaining thinking + text
    if (pendingThinking) {
      pendingThinking = '';
    }
    if (pendingText) {
      chatLog.addSystem(pendingText);
    }
  }).catch(() => {
    // Silently ignore replay errors — don't block TUI startup
  });
}

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
  bootstrapStatus?: BootstrapStatus,
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
  interface PermissionRequest {
    resolve: (result: 'yes' | 'no' | 'always') => void;
    toolName: string;
    inputStr: string;
  }
  const permissionQueue: PermissionRequest[] = [];
  let permissionSelection = 0; // 0=Yes, 1=Always, 2=No

  root.addChild(headerContainer);
  root.addChild(chatLog);
  root.addChild(contextBarText);

  // Thinking indicator — below chatLog, above editor (prevents content jitter)
  const thinkingBar = new Container();
  let thinkingLoader: Loader | null = null;
  root.addChild(thinkingBar);

  // Unread messages hint (shown when scrolled up) — P2-4
  const unreadHintText = new Text('', 0, 0);
  root.addChild(unreadHintText);

  root.addChild(footerText);
  root.addChild(permissionBar);
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

  function updateUnreadHint(): void {
    const count = chatLog.unreadCount;
    if (count > 0 && !chatLog.isPinnedToBottom) {
      unreadHintText.setText(
        theme.warning(`↓ ${count} new message${count > 1 ? 's' : ''} below  `) +
        theme.dim('(End to scroll down)'),
      );
    } else {
      unreadHintText.setText('');
    }
    tui.requestRender();
  }

  // ── State for refreshStatus ──
  let prevCompressCount = 0;
  let compactionMessage: string | null = null;
  let compressionLoader: Loader | null = null;
  let compressionTimeout: ReturnType<typeof setTimeout> | null = null;
  let prevProviderLabel: string | null = null;
  let prevProviderIsLocal = false;
  let fallbackMessage: string | null = null;
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

    // Provider fallback detection \u2014 event-driven from onFallback callback
    const providerInfo = loop.getProviderRoutingInfo();
    if (providerInfo) {
      if (prevProviderLabel !== null && providerInfo.providerLabel !== prevProviderLabel) {
        // Provider changed via fallback \u2014 one-time notification already sent by onFallback
        fallbackMessage = `\u26a0 Fallback: ${providerInfo.providerLabel}`;
        setTimeout(() => { fallbackMessage = null; tui.requestRender(); }, 5000);
      }
      prevProviderLabel = providerInfo.providerLabel;
      prevProviderIsLocal = providerInfo.isLocal;
    }

    const ap = loop.getActiveProvider();
    const currentModel = ap.getModel();
    const currentProviderType = ap.getProviderType();
    const currentProviderInfo = providerInfo ?? { providerLabel: currentProviderType, isLocal: false, mode: 'auto' };
    // Build mode label for header display
    let modeHeaderLabel: string | null = null;
    if (modeManager?.isActive()) {
      const mn = modeManager.getActive();
      if (mn) {
        const label = mn.charAt(0).toUpperCase() + mn.slice(1);
        const completed = modeManager.checkComplete();
        modeHeaderLabel = completed ? `${label} ✓` : label;
      }
    }
    let statusContent = formatStatusBar(activeInfo, currentModel, currentProviderInfo, modeHeaderLabel);

    // Compaction message
    if (compactionMessage) {
      statusContent += ' ' + theme.warning(compactionMessage);
    }

    // Fallback message
    if (fallbackMessage) {
      statusContent += ' ' + theme.warning(fallbackMessage);
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
  }

  // ── Output handler ──
  let currentTextLine = '';
  let pendingThinking = '';
  let toolCounterFallback = 0;
  let showThinking = false;

  function showPermissionDialog(toolName: string, inputStr: string) {
    permissionSelection = 0;
    chatLog.addSystem(
      theme.warning(`\u250c Permission Required \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510`),
    );
    chatLog.addSystem(
      theme.warning('\u2502 ') + theme.fg(`${toolName}(${inputStr})`) + theme.warning(' \u2502'),
    );
    chatLog.addSystem(
      theme.warning(`\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`),
    );
    updatePermissionBar();
    tui.requestRender();
  }

  function resolvePermission(result: 'yes' | 'no' | 'always') {
    const req = permissionQueue.shift();
    if (!req) return;

    permissionBar.setText('');
    chatLog.addSystem(
      result === 'no' ? theme.error('  \u25c6 Denied')
        : result === 'always' ? theme.success('  \u25c6 Always allowed')
        : theme.success('  \u25c6 Approved'),
    );
    req.resolve(result);

    if (permissionQueue.length > 0) {
      const next = permissionQueue[0];
      showPermissionDialog(next.toolName, next.inputStr);
    }
    tui.requestRender();
  }

  function updatePermissionBar() {
    const labels = ['Yes', 'Always', 'No'];
    const shortcuts = ['Y', 'A', 'N'];
    const parts = labels.map((l, i) => {
      const prefix = i === permissionSelection ? '\u25b6 ' : '  ';
      if (i === permissionSelection) {
        return theme.fg(`[ ${prefix}${l} (${shortcuts[i]}) ]`);
      }
      return theme.dim(`  ${prefix}${l} (${shortcuts[i]})  `);
    });
    permissionBar.setText(
      theme.warning('\u250c Permission Required \u2500 ') +
      parts.join(theme.dim(' \u2502 ')) +
      theme.warning(' \u2500\u2500 Use \u2190\u2192 to select, Enter to confirm')
    );
  }

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
      showThinkingIndicator(theme.accent('Thinking...'));
    },
    onToolUse(name: string, inputSummary: string, toolId?: string) {
      if (pendingThinking.trim()) {
        if (showThinking) {
          chatLog.addSystem(theme.dim('\u{1F9E0} Thinking:\n') + theme.dim(pendingThinking.trim()));
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
      updateUnreadHint();
      tui.requestRender();
    },
    onToolResult(content: string, isError: boolean, toolId?: string) {
      if (toolId) {
        chatLog.updateToolResult(toolId, content, { isError });
      }
      updateUnreadHint();
      tui.requestRender();
    },
    onDiff(toolId: string, filePath: string, diffLines: Array<{ kind: string; text: string }>) {
      if (toolId) {
        chatLog.showDiff(toolId, filePath, diffLines);
      }
      updateUnreadHint();
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
          // 用压缩后的 token 数刷新 context bar
          refreshStatus(loop.getTurnInfo(lastTurnCount, post));
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
        if (message.startsWith('Provider switched to ')) {
          modelName = loop.getActiveProvider().getModel();
          providerTypeStart = loop.getActiveProvider().getProviderType();
          refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
        }
      }
      updateUnreadHint();
      tui.requestRender();
    },
    onFlush() {
      hideThinkingIndicator();
      isThinking = false;
      updateHeaderText(modelName);
      const providerInfo = loop.getProviderRoutingInfo();
      if (pendingThinking.trim()) {
        if (showThinking) {
          chatLog.addSystem(theme.dim('\u{1F9E0} Thinking:\n') + theme.dim(pendingThinking.trim()));
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
      updateUnreadHint();
      tui.requestRender();
    },
    onPermissionRequest(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always'> {
      const inputStr = Object.entries(input)
        .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
        .join(', ');

      return new Promise<'yes' | 'no' | 'always'>((resolve) => {
        const isFirst = permissionQueue.length === 0;
        permissionQueue.push({ resolve, toolName, inputStr });

        if (isFirst) {
          showPermissionDialog(toolName, inputStr);
        }
      });
    },
    onInterrupt() {
      hideThinkingIndicator();
      isThinking = false;
      pendingThinking = '';
      currentTextLine = '';
    },
  };

  // ── Bootstrap detection ──
  const resolvedBootstrapStatus = bootstrapStatus ?? (await getBootstrapStatus(personaDir));

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

  // ── Agent + Session ──
  const agent = await createAgent({
    cwd: process.cwd(),
    provider: activeProvider,
    maxTurns,
    maxContext,
    outputHandler: tuiHandler,
    sessionId,
    shouldContinue,
    maxMessages,
    personaDir,
    bootstrapStatus: resolvedBootstrapStatus,
    localModelProvider,
  });
  const loop = agent.loop;
  let sessionDir = agent.sessionDir;
  const modeManager = agent.modeManager;
  const backgroundRegistry = agent.backgroundRegistry;
  const modelRouter = agent.modelRouter;
  const knowledgeBase = agent.knowledgeBase;
  const composeStrategy = agent.composeStrategy;
  const sessionManager = agent.sessionManager;
  const contextComposer = agent.contextComposer;
  let originalSessionDir: string | null = null;  // /precise on 前保存的原始 session
  let preciseModeActive = false;

  // 检测启动时恢复的 session 类型：如果是 precise session，自动激活精确模式
  const currentSessionId = path.basename(sessionDir);
  const sessions = await sessionManager.list();
  const resumedSession = sessions.find(s => s.id === currentSessionId);
  if (resumedSession?.type === 'precise') {
    const { PreciseStrategy } = await import('../context/precision/index.js');
    loop.composeStrategy = new PreciseStrategy(sessionDir);
    preciseModeActive = true;
    // 保存原始 session：精确模式通过 --session 启动时，originalSessionDir 需要指向一个有效的普通 session
    // 用于 /precise off 时恢复。如果当前项目有普通 session，就用最新的普通 session 作为 fallback。
    const normalSessions = sessions.filter(s => (s.type ?? 'normal') === 'normal');
    if (normalSessions.length > 0) {
      originalSessionDir = sessionManager.getSessionDir(normalSessions[0]!.id);
    }
    chatLog.addSystem(theme.dim('精确模式 session 已恢复'));
  }

  // 注入 LifecycleSupervisor，实现运行时 provider 切换时自动管理本地模型进程
  loop.setLifecycleSupervisor(supervisor);

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

  // 为飞书渠道注入 tuiSync 回调（如果已注册）
  const feishuState = channelManager.get('feishu');
  if (feishuState) {
    feishuState.config = {
      ...feishuState.config,
      onUserMessage: (label: string, content: string) => {
        chatLog.addUser(`📨 [飞书:${label}] ${content}`);
        tui.requestRender();
      },
      onAgentReply: (content: string) => {
        chatLog.addSystem(`📤 [飞书回复] ${content}`);
        tui.requestRender();
      },
    };
  }

  tuiChannel.onReply = (content: string) => {
    chatLog.addSystem(content);
    tui.requestRender();
  };

  // 创建 AgentFactory（注入到渠道，渠道通过此接口创建 AgentLoop）
  const agentFactory: AgentFactory = {
    createAgent: async (options) => {
      return createAgent({
        cwd: process.cwd(),
        provider: activeProvider,
        maxTurns: maxTurns ?? 20,
        maxContext: maxContext ?? 40_000,
        outputHandler: options.outputHandler as OutputHandler,
        sessionId: options.sessionId,
      });
    },
  };

  // 设置 TUI 渠道的消息处理回调（使用主 loop）
  tuiChannel.onHandleMessage = async (event: ChannelMessageEvent, replyFn: ReplyFn) => {
    await loop.run(event.content);
    const stats = await statsManager.get(sessionDir);
    const tc = stats.turn_count ?? 0;
    refreshStatus(loop.getTurnInfo(tc, stats.current_context_tokens ?? 0));
  };

  // 启动所有渠道（每个渠道自行处理消息）
  await channelManager.startAll(agentFactory);

  // ── ASCII Art loader ──────────────────────────────────────────────
  async function loadAsciiArt(maxWidth = 54): Promise<{ text: string; width: number } | null> {
    const asciiDir = path.join(os.homedir(), '.agent', 'ascii');
    const lastFile = path.join(asciiDir, '_last.txt');
    try {
      if (!fs.existsSync(asciiDir)) {
        fs.mkdirSync(asciiDir, { recursive: true });
        return null;
      }
      const files = fs.readdirSync(asciiDir);
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      const imageFiles = files.filter(f =>
        imageExts.includes(path.extname(f).toLowerCase()),
      );
      if (imageFiles.length === 0) return null;
      let prevName = '';
      try { prevName = fs.readFileSync(lastFile, 'utf-8').trim(); } catch { /* first */ }
      const candidates =
        imageFiles.length > 1 ? imageFiles.filter(f => f !== prevName) : imageFiles;
      const pool = candidates.length > 0 ? candidates : imageFiles;
      const picked = pool[Math.floor(Math.random() * pool.length)]!;
      try { fs.writeFileSync(lastFile, picked, 'utf-8'); } catch { /* ignore */ }
      const imgPath = path.join(asciiDir, picked);
      const cachePath = path.join(asciiDir, picked + '.txt');
      try {
        const imgStat = fs.statSync(imgPath);
        const cacheStat = fs.statSync(cachePath);
        if (cacheStat.mtimeMs >= imgStat.mtimeMs) {
          return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { text: string; width: number };
        }
      } catch { /* cache miss */ }
      const { imageToAscii } = await import('../orchestrator/loop.js');
      const result = await imageToAscii(imgPath, maxWidth);
      if (result) {
        try { fs.writeFileSync(cachePath, JSON.stringify(result), 'utf-8'); } catch { /* ignore */ }
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Welcome ──
  const asciiArt = await loadAsciiArt(54);
  const cwd = process.cwd();
  const cwdDisplay = cwd.length > 50 ? '...' + cwd.slice(-47) : cwd;
  const boxLines: string[] = [];
  boxLines.push(theme.fg('\u256d' + BOX_H.repeat(58) + '\u256e'));
  if (asciiArt) {
    const artWidth = asciiArt.width;
    const pad = Math.max(0, 56 - artWidth);
    for (const line of asciiArt.text.split('\n')) {
      boxLines.push(theme.fg('\u2502 ') + line + ' '.repeat(pad) + theme.fg(' \u2502'));
    }
  }
  // DeepThink \u6807\u9898\u884c
  const titleLine = theme.fg(' DeepThink');
  const titlePad = Math.max(0, 56 - 10); // ' DeepThink' = 10 chars visible
  boxLines.push(theme.fg('\u2502 ') + titleLine + ' '.repeat(titlePad) + theme.fg(' \u2502'));
  // CWD \u884c
  const cwdPad = Math.max(0, 56 - [...cwdDisplay].length);
  boxLines.push(theme.fg('\u2502 ') + theme.dim(cwdDisplay) + ' '.repeat(cwdPad) + theme.fg(' \u2502'));
  boxLines.push(theme.fg('\u2570' + BOX_H.repeat(58) + '\u256f'));
  chatLog.addSystem(boxLines.join('\n'));
  chatLog.addSystem('');
  chatLog.addSystem(theme.dim('Persona: ') + theme.accent(personaDir));
  chatLog.addSystem('');

  // ── Bootstrap ──
  if (resolvedBootstrapStatus === 'pending') {
    chatLog.addSystem(theme.warning('\u256d' + BOX_H.repeat(56) + '\u256e'));
    chatLog.addSystem(theme.warning('\u2502  \uD83D\uDD27 Bootstrap Init'));
    chatLog.addSystem(
      theme.warning('\u2502  AI will ask you setup questions to configure the persona.'),
    );
    chatLog.addSystem(theme.warning('\u2570' + BOX_H.repeat(56) + '\u256f'));
    chatLog.addSystem('');

    try {
      await loop.startBootstrap();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      chatLog.addSystem(theme.errorBright('[Bootstrap Error] ') + theme.error(message));
    }
  }

  chatLog.addSystem(
    theme.dim('Type ') +
      theme.success('exit') +
      theme.dim(' to quit. ') +
      theme.success('Ctrl+C') +
      theme.dim(' twice to force. ') +
      theme.success('Ctrl+P') +
      theme.dim(' to toggle provider.'),
  );
  chatLog.addSystem('');
  tui.requestRender();

  // Replay previous session events
  if (sessionDir) {
    replayEvents(chatLog, sessionDir);
  }

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
    const ap = loop.getActiveProvider();
    const providerLabel = `${ap.getProviderType()} \u00b7 `;
    let footer = theme.dim(
      `Ctrl+C exit | Ctrl+L clear | Ctrl+P provider | Ctrl+F search | Ctrl+T tools`,
    );

    // Context-aware hints
    if (isThinking) {
      footer += theme.accent(' | Esc to stop');
    }
    if (permissionQueue.length > 0) {
      footer += theme.warning(' | \u2190\u2192 select  Enter confirm');
    }
    if (backgroundRegistry) {
      const bgCount = backgroundRegistry.list().filter((p: BackgroundProcessInfo) => p.status === 'running').length;
      if (bgCount > 0) {
        footer += theme.accent(` | \u2699 ${bgCount} bg process(es)`);
      }
    }

    footer += theme.dim(`\n${providerLabel}${ap.getModel()} \u00b7 ~${estimated} tokens`);
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
          const activeP = loop.getActiveProvider();
          dynamicChildren.push({
            name: 'current_online',
            description: `${activeP.getProviderType()} (online) - ${activeP.getModel()}`,
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
      const cfg = RuntimeConfigCenter.getInstance();

      if (cmdPath.startsWith('session/')) {
        let sub = cmdPath.slice('session/'.length);
        // 支持嵌套路径: session/<id>/load → sub = "<id>/load"
        const subParts = sub.split('/');
        if (subParts.length === 2 && (subParts[1] === 'load' || subParts[1] === 'delete')) {
          // session/<id>/load 或 session/<id>/delete
          const sessionId = subParts[0];
          if (subParts[1] === 'load') {
            const SessionManager = (await import('../memory/session.js')).SessionManager;
            const sm = new SessionManager(process.cwd());
            const dir = sm.getSessionDir(sessionId);
            const fsPromises = await import('node:fs/promises');
            try {
              await fsPromises.access(dir);
            } catch {
              chatLog.addSystem(theme.warning(`Session "${sessionId}" not found. Use /session list to see available sessions.`));
              tui.requestRender();
              updateTokenEstimate();
              return;
            }
            // 就地切换，不重启
            await loop.switchSession(dir);
            sessionDir = dir;
            chatLog.clearAll();
            replayEvents(chatLog, dir);
            chatLog.addSystem(theme.success(`已切换到 session ${sessionId}`));
            updateTokenEstimate();
          } else {
            const SessionManager = (await import('../memory/session.js')).SessionManager;
            const sm = new SessionManager(process.cwd());
            const dir = sm.getSessionDir(sessionId);
            try {
              const fsPromises = await import('node:fs/promises');
              await fsPromises.access(dir);
              await fsPromises.rm(dir, { recursive: true, force: true });
              chatLog.addSystem(theme.success(`Session ${sessionId} deleted`));
            } catch {
              chatLog.addSystem(theme.warning(`Session ${sessionId} not found`));
            }
          }
          tui.requestRender();
          updateTokenEstimate();
          return;
        }
        if (sub === 'list') {
          const SessionManager = (await import('../memory/session.js')).SessionManager;
          const sm = new SessionManager(process.cwd());
          const sessions = await sm.list();
          const modeType = preciseModeActive ? 'precise' : 'normal';
          const filtered = sessions.filter(s => (s.type ?? 'normal') === modeType);
          if (filtered.length === 0) {
            chatLog.addSystem(theme.dim(`No ${modeType} sessions found`));
          } else {
            for (const s of filtered) {
              const isCurrent = s.id === path.basename(sessionDir);
              const marker = isCurrent ? theme.success(' ← current') : '';
              const typeLabel = s.type ? theme.dim(` [${s.type}]`) : '';
              chatLog.addSystem(
                theme.accent(s.id) +
                theme.dim(` | created: ${s.createdAt}`) +
                theme.dim(` | updated: ${s.updatedAt}`) +
                typeLabel + marker
              );
            }
            chatLog.addSystem(theme.dim('─'.repeat(60)));
            chatLog.addSystem(theme.dim('加载会话: /session <完整ID>/load   例如: /session ' + (filtered[0]?.id ?? '') + '/load'));
          }
        } else if (sub === 'new') {
          chatLog.addSystem(theme.warning('请使用 deepthink start 启动新会话（当前会话需要退出）'));
        } else if (sub === 'load') {
          const id = restArgs?.trim();
          if (!id) {
            chatLog.addSystem(theme.warning('用法: /session load <sessionId>'));
          } else {
            chatLog.addSystem(theme.warning(`请使用 deepthink start --session ${id} 加载会话`));
          }
        } else if (sub === 'delete') {
          const id = restArgs?.trim();
          if (!id) {
            chatLog.addSystem(theme.warning('用法: /session delete <sessionId>'));
          } else {
            const SessionManager = (await import('../memory/session.js')).SessionManager;
            const sm = new SessionManager(process.cwd());
            // 检查 session 类型是否匹配当前模式
            const sessions = await sm.list();
            const target = sessions.find(s => s.id === id);
            if (!target) {
              chatLog.addSystem(theme.warning(`Session ${id} not found`));
            } else if ((target.type ?? 'normal') !== (preciseModeActive ? 'precise' : 'normal')) {
              chatLog.addSystem(theme.warning(`Session ${id} 是 [${target.type ?? 'normal'}] 类型，当前为 [${preciseModeActive ? 'precise' : 'normal'}] 模式，无法跨模式操作`));
            } else {
              const dir = sm.getSessionDir(id);
              try {
                const fsPromises = await import('node:fs/promises');
                await fsPromises.access(dir);
                await fsPromises.rm(dir, { recursive: true, force: true });
                chatLog.addSystem(theme.success(`Session ${id} deleted`));
              } catch {
                chatLog.addSystem(theme.warning(`Session ${id} not found`));
              }
            }
          }
        }
        tui.requestRender();
        return;
      }

      switch (cmdPath) {
        case 'model/settings/switch':
        case 'model/switch': {
          if (!restArgs) {
            chatLog.addSystem(theme.warning('Usage: /model switch <model-name>'));
            tui.requestRender();
            return;
          }
          const activeP = loop.getActiveProvider();
          const providerType = activeP.getProviderType();
          cfg.set(`provider.${providerType}.model`, restArgs);
          cfg.save().catch(() => {});
          chatLog.addSystem(
            theme.success('Model name set to ') + theme.fg(String(restArgs)) + theme.dim(` (provider: ${providerType})`),
          );
          tui.requestRender();
          refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
          return;
        }

        case 'model/settings/provider':
        case 'model/provider': {
          if (!restArgs) {
            chatLog.addSystem(theme.warning('Usage: /model provider <anthropic|openai|deepseek|gemini|groq|xai|mistral|openrouter|moonshot|qwen|zhipu|minimax|mimo|local>'));
            tui.requestRender();
            return;
          }

          if (restArgs === 'local') {
            const lmList = localModel.list();

            // 无已注册模型 → 检查 local-provider.json 或直接切
            if (lmList.length === 0) {
              const { getLocalProviderConfigLoader } = await import('../provider/local-config.js');
              const localCfg = getLocalProviderConfigLoader();
              if (localCfg?.defaultModel) {
                // local-provider.json 已配置 → 直接切换
                try {
                  await loop.switchProvider('local');
                  modelName = loop.getActiveProvider().getModel();
                  providerTypeStart = loop.getActiveProvider().getProviderType();
                  chatLog.addSystem(theme.success(`Switched to local (${localCfg.baseUrl}, ${localCfg.defaultModel})`));
                  chatLog.addSystem(theme.dim('Register models via /model local/register for process management.'));
                  refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
                } catch (err) {
                  chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
                }
              } else {
                chatLog.addSystem(theme.warning('No local models registered and no local-provider.json configured.'));
                chatLog.addSystem(theme.dim('Configure ~/.agent/local-provider.json or register models via /model local/register.'));
              }
              tui.requestRender();
              return;
            }

            const targetName = localModel.getActive() ?? lmList[0].name;

            localModel.switch(targetName).then(async (info) => {
              if (info) {
                cfg.set('provider.local', {
                  type: 'local',
                  model: info.modelFile ?? targetName,
                  baseUrl: info.baseUrl,
                });
                cfg.set('provider.local.modelKey', targetName);
                cfg.save().catch(() => {});
                try {
                  await loop.switchProvider('local');
                  modelName = loop.getActiveProvider().getModel();
                  providerTypeStart = loop.getActiveProvider().getProviderType();
                  chatLog.addSystem(theme.success(`Switched to local model: ${targetName} (port ${info.port})`));
                  refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
                } catch (swErr) {
                  chatLog.addSystem(theme.error(`Failed: ${(swErr as Error).message}`));
                }
              } else {
                chatLog.addSystem(theme.error(`Failed to start ${targetName}`));
              }
              tui.requestRender();
            }).catch((e) => {
              chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
              tui.requestRender();
            });
            return;
          }

          localModel.getBridge().stopAll().catch(() => {});
          try {
            await loop.switchProvider(restArgs);
          } catch (e) {
            chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
            tui.requestRender();
            return;
          }
          modelName = loop.getActiveProvider().getModel();
          providerTypeStart = loop.getActiveProvider().getProviderType();
          chatLog.addSystem(
            theme.success('Provider switched to ') + theme.fg(String(restArgs)) + theme.dim(' (persisted)'),
          );
          tui.requestRender();
          refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
          return;
        }

        case 'model/settings/source':
        case 'model/source': {
          if (!restArgs) {
            chatLog.addSystem(theme.warning('Usage: /model source <role> <main|local|channel-name>'));
            tui.requestRender();
            return;
          }
          const parts2 = restArgs.split(/\s+/).filter(Boolean);
          if (parts2.length < 2) {
            chatLog.addSystem(theme.warning('Usage: /model source <assessment|planning|compression|sub-agent|all> <main|local|channel-name>'));
            tui.requestRender();
            return;
          }
          const roleArg = parts2[0].toLowerCase();
          const sourceArg = parts2[1];
          const validRoles = ['assessment', 'planning', 'compression', 'sub-agent', 'all'];
          if (!validRoles.includes(roleArg)) {
            chatLog.addSystem(theme.warning('Role must be: assessment, planning, compression, sub-agent, or all'));
            tui.requestRender();
            return;
          }
          // 尝试用 ModelChannelRegistry 的 setRoleMapping（多通道模式）
          const modelRouter = (loop as any).modelRouter;
          const registry = modelRouter?.getRegistry();
          const channelNames = registry ? registry.listChannelNames() : [];
          const isChannelName = channelNames.includes(sourceArg);

          try {
            if (isChannelName && registry) {
              // 映射到已注册的通道
              const roles = roleArg === 'all'
                ? ['assessment', 'planning', 'compression', 'sub-agent']
                : [roleArg];
              for (const r of roles) {
                registry.setRoleMapping(r, sourceArg);
              }
              chatLog.addSystem(theme.success(`Mapped ${roles.join(', ')} → channel "${sourceArg}"`));
            } else {
              chatLog.addSystem(theme.warning(`Channel "${sourceArg}" not found. Available: ${channelNames.join(', ') || '(none)'}. Use /channel add ${sourceArg} <provider> [model] to create it.`));
            }
          } catch (e) {
            chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
          }
          tui.requestRender();
          refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
          return;
        }

        case 'model/settings/thinking':
        case 'model/thinking': {
          if (restArgs !== 'on' && restArgs !== 'off') {
            chatLog.addSystem(theme.warning('Usage: /model thinking <on|off>'));
            tui.requestRender();
            return;
          }
          const enabled = restArgs === 'on';
          cfg.set('provider.enableThinking', enabled);
          cfg.save().catch(() => {});
          loop.getActiveProvider().setThinking?.(enabled);
          chatLog.addSystem(
            theme.success('Thinking ') + theme.fg(String(enabled ? 'enabled' : 'disabled')) + theme.dim(' (persisted)'),
          );
          tui.requestRender();
          updateTokenEstimate();
          return;
        }

        case 'model/settings/thinking-effort':
        case 'model/thinking-effort': {
          const activeP = loop.getActiveProvider();
          const providerType = activeP.getProviderType();

          // 根据厂商提供不同选项
          const options: Record<string, { label: string; effort: string | number }> = {};
          if (providerType === 'deepseek') {
            options.high = { label: 'high (深度思考)', effort: 'high' };
            options.max = { label: 'max (最强推理)', effort: 'max' };
          } else if (providerType === 'anthropic') {
            options['4000'] = { label: '4K tokens', effort: 4000 };
            options['8000'] = { label: '8K tokens', effort: 8000 };
            options['16000'] = { label: '16K tokens (默认)', effort: 16000 };
            options['32000'] = { label: '32K tokens (Claude Opus 4)', effort: 32000 };
          } else {
            chatLog.addSystem(theme.dim(`Thinking effort not configurable for ${providerType}`));
            tui.requestRender();
            return;
          }

          if (!restArgs || !options[restArgs]) {
            const optsStr = Object.entries(options)
              .map(([k, v]) => `  ${k}: ${v.label}`)
              .join('\n');
            chatLog.addSystem(`Usage: /model thinking-effort <option>\n${optsStr}`);
            tui.requestRender();
            return;
          }

          const selected = options[restArgs];
          // 确保 thinking 已启用
          cfg.set('provider.enableThinking', true);
          cfg.set('provider.thinkingEffort', selected.effort);
          cfg.save().catch(() => {});
          activeP.setThinking?.(true, selected.effort);
          chatLog.addSystem(
            theme.success(`Thinking effort set to ${selected.label}`) + theme.dim(` (${providerType})`),
          );
          tui.requestRender();
          return;
        }

        case 'model/settings/show-thinking':
        case 'model/show-thinking': {
          showThinking = !showThinking;
          chatLog.addSystem(
            theme.success(showThinking ? 'Thinking content will be shown' : 'Thinking content hidden'),
          );
          tui.requestRender();
          updateTokenEstimate();
          return;
        }

        case 'model/settings/info':
        case 'model/info': {
          const providerName = String(cfg.get('provider.active') ?? 'unknown');
          const activeProvider = loop.getActiveProvider();
          const modelName = activeProvider ? activeProvider.getModel() : 'unknown';
          const lines: string[] = [];
          lines.push(theme.accent('=== Model Info ==='));
          lines.push('  Provider: ' + theme.fg(providerName));
          lines.push('  Model:    ' + theme.fg(modelName));
          const routing = loop.getProviderRoutingInfo();
          if (routing) {
            lines.push('  Route:    ' + theme.fg(routing.mode) + (routing.isLocal ? theme.success(' (local)') : theme.accent(' (online)')));
          }
          // 通道信息
          const modelRouter = (loop as any).modelRouter;
          if (modelRouter) {
            const registry = modelRouter.getRegistry();
            const channels = registry.listChannels();
            const roles = registry.listRoles();
            if (channels.length > 1 || Object.keys(roles).some(r => roles[r] !== 'main')) {
              lines.push(theme.dim('  ── Channels ──'));
              for (const ch of channels) {
                const chRoles = Object.entries(roles)
                  .filter(([, cn]) => cn === ch.name)
                  .map(([r]) => r);
                const roleStr = chRoles.length > 0 ? ' ← ' + chRoles.join(', ') : '';
                lines.push(theme.dim(`    ${ch.name}: ${ch.provider}${ch.model ? '/' + ch.model : ''}`) + theme.fg(roleStr));
              }
            }
          }
          // 旧 source 信息
          const sources = loop.getModelSources();
          if (sources) {
            const labels: Record<string, string> = { assessment: '评估', planning: '规划', compression: '压缩' };
            for (const [role, src] of Object.entries(sources)) {
              const label = labels[role] ?? role;
              const srcColor = src === 'local' ? theme.success(String(src)) : theme.accent(String(src));
              lines.push('    ' + theme.fg(label) + theme.dim(': ') + srcColor);
            }
          }
          chatLog.addSystem(lines.join('\n'));
          tui.requestRender();
          updateTokenEstimate();
          return;
        }

        case 'model/settings/context': {
          if (!restArgs) {
            const activeP = loop.getActiveProvider();
            const modelCtxWindow = getModelContextWindow(activeP.getProviderType(), activeP.getModel());
            chatLog.addSystem(theme.warning('Usage: /model settings context <tokens>') + theme.dim(` (1-${modelCtxWindow.toLocaleString()})`));
            tui.requestRender();
            updateTokenEstimate();
            return;
          }
          const tokens = parseInt(restArgs.trim(), 10);
          const activeP = loop.getActiveProvider();
          const modelCtxWindow = getModelContextWindow(activeP.getProviderType(), activeP.getModel());
          const upper = modelCtxWindow;
          if (isNaN(tokens) || tokens < 1 || tokens > upper) {
            chatLog.addSystem(theme.warning(`Usage: /model settings context <1-${upper.toLocaleString()}>`) + theme.dim(` (model: ${activeP.getModel()})`));
            tui.requestRender();
            updateTokenEstimate();
            return;
          }
          cfg.set('session.maxContext', tokens);
          cfg.save().catch(() => {});
          chatLog.addSystem(theme.success('Max context set to ') + theme.fg(tokens.toLocaleString() + ' tokens'));
          refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
          updateTokenEstimate();
          return;
        }

        // ── 本地模型 L2: model/local/start ──
        case 'model/local/start': {
          const { detectLocalBackend } = await import('../provider/local-config.js');
          const detected = await detectLocalBackend();
          const ollamaBin = localModel.checkOllama();
          const llamacppBin = localModel.checkLlamacpp();

          const backend = restArgs?.toLowerCase();
          const validBackend = backend === 'ollama' || backend === 'llamacpp' || backend === 'llama.cpp';

          // 指定了 backend → 启动那个
          if (validBackend) {
            const target = (backend === 'llamacpp' || backend === 'llama.cpp') ? 'llamacpp' : 'ollama';
            if (target === 'ollama' && ollamaBin) {
              if (detected?.backend === 'ollama') {
                chatLog.addSystem(theme.success('Ollama 已在运行。使用 /model/local/switch 切换。'));
              } else {
                chatLog.addSystem(theme.accent('启动 Ollama...'));
                const info = await supervisor.startOllamaOnDemand(process.cwd());
                chatLog.addSystem(info ? theme.success('Ollama 已启动（框架管理进程）。') : theme.warning('启动失败，请手动运行 ollama serve。'));
              }
            } else if (target === 'llamacpp' && llamacppBin) {
              const regModels = localModel.list();
              if (regModels.length === 0) {
                chatLog.addSystem(theme.warning('无注册的 llama.cpp 模型。请先用 /model/local/register 注册。'));
              } else {
                localModel.start(regModels[0].name).then(async (info) => {
                  if (info) {
                    cfg.set('provider.local', { type: 'local', model: info.modelFile ?? regModels[0].name, baseUrl: info.baseUrl });
                    cfg.set('provider.local.modelKey', regModels[0].name);
                    cfg.save().catch(() => {});
                    try { await loop.switchProvider('local'); chatLog.addSystem(theme.success(`llama.cpp ${regModels[0].name} started`)); refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed)); }
                    catch (swErr) { chatLog.addSystem(theme.error(`Switch failed: ${(swErr as Error).message}`)); }
                  }
                  tui.requestRender();
                }).catch((e) => { chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`)); tui.requestRender(); });
              }
            } else {
              chatLog.addSystem(theme.warning(`${backend} 未安装。`));
            }
            tui.requestRender();
            return;
          }

          // 指定了已注册模型名 → 按名启动
          if (restArgs) {
            const lm = localModel.list().find((m: { name: string }) => m.name === restArgs);
            if (lm) {
              localModel.start(restArgs).then(async (info) => {
                if (info) {
                  cfg.set('provider.local', { type: 'local', model: info.modelFile ?? restArgs, baseUrl: info.baseUrl });
                  cfg.set('provider.local.modelKey', restArgs);
                  cfg.save().catch(() => {});
                  try { await loop.switchProvider('local'); chatLog.addSystem(theme.success(`${restArgs} started on port ${info.port}`)); refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed)); }
                  catch (swErr) { chatLog.addSystem(theme.error(`Switch failed: ${(swErr as Error).message}`)); }
                } else { chatLog.addSystem(theme.error(`Failed to start ${restArgs}`)); }
                tui.requestRender();
              }).catch((e) => { chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`)); tui.requestRender(); });
            } else {
              chatLog.addSystem(theme.warning(`Model "${restArgs}" not registered. Available: ${localModel.list().map((m: { name: string }) => m.name).join(', ') || 'none'}`));
              chatLog.addSystem(theme.dim('To start a backend: /model/local start ollama | /model/local start llamacpp'));
              tui.requestRender();
            }
            return;
          }

          // 无参 → 列出可用选项
          chatLog.addSystem(theme.fg('── 可用本地后端 ──'));
          if (detected) chatLog.addSystem(theme.success(`${detected.backend} 正在运行 — ${detected.baseUrl}`));
          if (ollamaBin) chatLog.addSystem(theme.dim(`Ollama ${detected?.backend === 'ollama' ? '(运行中)' : '— /model/local start ollama'}`));
          if (llamacppBin) chatLog.addSystem(theme.dim(`llama.cpp ${detected?.backend === 'llamacpp' ? '(运行中)' : '— /model/local start llamacpp'}`));
          if (!ollamaBin && !llamacppBin) chatLog.addSystem(theme.warning('本地模型服务未配置。请安装 Ollama 或 llama.cpp。'));
          const reg = localModel.list();
          if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/stop ──
        case 'model/local/stop': {
          const { detectLocalBackend } = await import('../provider/local-config.js');
          const detected = await detectLocalBackend();
          const backend = restArgs?.toLowerCase();
          if (backend === 'ollama') {
            if (detected?.backend === 'ollama') {
              try { await supervisor.stopModel('ollama'); chatLog.addSystem(theme.success('Ollama 已停止。')); }
              catch { chatLog.addSystem(theme.warning('无法停止 Ollama。请手动执行 ollama stop。')); }
            } else { chatLog.addSystem(theme.dim('Ollama 未在运行。')); }
            tui.requestRender(); return;
          }
          if (backend === 'llamacpp' || backend === 'llama.cpp') {
            const running = localModel.getBridge().getAllStatus().filter((s: { state: string }) => s.state === 'running');
            if (running.length > 0) { for (const m of running) { localModel.getBridge().stop(m.name).catch(() => {}); chatLog.addSystem(theme.success(`Stopped: ${m.name}`)); } }
            else { chatLog.addSystem(theme.dim('llama.cpp 未在运行。')); }
            tui.requestRender(); return;
          }
          // 无参 → 停止所有
          let stopped = 0;
          if (detected?.backend === 'ollama') {
            try { await supervisor.stopModel('ollama'); stopped++; chatLog.addSystem(theme.success('Ollama 已停止。')); }
            catch { chatLog.addSystem(theme.warning('无法停止 Ollama。')); }
          }
          const running = localModel.getBridge().getAllStatus().filter((s: { state: string }) => s.state === 'running');
          for (const m of running) { localModel.getBridge().stop(m.name).catch(() => {}); stopped++; chatLog.addSystem(theme.success(`Stopped: ${m.name}`)); }
          if (stopped === 0) chatLog.addSystem(theme.dim('没有运行中的本地服务。'));
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/status ──
        case 'model/local/status': {
          const { detectLocalBackend } = await import('../provider/local-config.js');
          const detected = await detectLocalBackend();
          const ollamaBin = localModel.checkOllama();
          const llamacppBin = localModel.checkLlamacpp();
          chatLog.addSystem(theme.fg('── 本地模型状态 ──'));
          chatLog.addSystem(detected ? theme.success(`运行中: ${detected.backend} — ${detected.baseUrl}`) : theme.dim('运行中: 无'));
          chatLog.addSystem(theme.dim(`Ollama: ${ollamaBin ? '已安装' : '未安装'}  |  llama.cpp: ${llamacppBin ? '已安装' : '未安装'}`));
          const reg = localModel.list();
          if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/switch ──
        case 'model/local/switch': {
          try {
            await loop.switchProvider('local');
            modelName = loop.getActiveProvider().getModel();
            providerTypeStart = loop.getActiveProvider().getProviderType();
            chatLog.addSystem(theme.success(`Switched to local (${loop.getActiveProvider().getProviderType()})`));
            refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
          } catch (err) {
            chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
          }
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/register ──
        case 'model/local/register': {
          const found = await localModel.scanUnregistered();
          if (found.length === 0) {
            chatLog.addSystem(theme.dim('无新模型。已检查 models/ 目录 (GGUF) 和 ollama list。'));
          } else {
            for (const f of found) {
              localModel.registerModel({ name: f.name, modelFile: f.modelFile, backend: f.backend as 'llama.cpp' | 'ollama' | undefined });
              chatLog.addSystem(theme.success(`Registered: ${f.name} (${f.backend ?? 'llama.cpp'})`));
            }
          }
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/unregister ──
        case 'model/local/unregister': {
          if (!restArgs) { chatLog.addSystem(theme.warning('Usage: /model/local unregister <name>')); tui.requestRender(); return; }
          chatLog.addSystem(theme.success(localModel.unregister(restArgs)));
          tui.requestRender();
          return;
        }

        // ── 本地模型 L2: model/local/detect ──
        case 'model/local/detect': {
          const { detectLocalBackend } = await import('../provider/local-config.js');
          const detected = await detectLocalBackend();
          const ollamaBin = localModel.checkOllama();
          const llamacppBin = localModel.checkLlamacpp();
          chatLog.addSystem(theme.fg('── 本地模型检测 ──'));
          chatLog.addSystem(detected ? theme.success(`运行中: ${detected.backend} — ${detected.baseUrl}`) : theme.dim('运行中: 无'));
          chatLog.addSystem(theme.dim(`Ollama: ${ollamaBin ? '已安装 (' + ollamaBin + ')' : '未安装'}`));
          chatLog.addSystem(theme.dim(`llama.cpp: ${llamacppBin ? '已安装 (' + llamacppBin + ')' : '未安装'}`));
          const reg = localModel.list();
          if (reg.length > 0) chatLog.addSystem(theme.dim(`已注册模型: ${reg.map((m: { name: string }) => m.name).join(', ')}`));
          tui.requestRender();
          return;
        }

        default: {
          // 在线模型: model/online/<provider>/<modelName|config>
          if (cmdPath.startsWith('model/online/')) {
            const onlineParts = cmdPath.split('/');
            if (onlineParts.length >= 4) {
              const provider = onlineParts[2]!;
              const sub = onlineParts[3]!;
              if (sub === 'config') {
                chatLog.addSystem(theme.accent(`Configure ${provider}: Use /context <tokens> to adjust context window`));
                tui.requestRender();
                return;
              }
              localModel.getBridge().stopAll().catch(() => {});
              try {
                cfg.set(`provider.${provider}.model`, sub);
                cfg.save().catch(() => {});
                await loop.switchProvider(provider);
                modelName = loop.getActiveProvider().getModel();
                providerTypeStart = loop.getActiveProvider().getProviderType();
                chatLog.addSystem(theme.success(`Switched to ${provider}/${sub}`));
                refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
              } catch (err) {
                chatLog.addSystem(theme.error(`Switch failed: ${(err as Error).message}`));
              }
              tui.requestRender();
              return;
            }
          }
          // 本地模型 L1 直接切换: model/local_<modelName>
          if (cmdPath.startsWith('model/local_')) {
            const lmName = cmdPath.slice('model/local_'.length);
            const lm = localModel.list().find((m) => m.name === lmName);
            if (lm) {
              localModel.switch(lmName).then(async (info) => {
                if (info) {
                  chatLog.addSystem(theme.success(`Local model ${lmName} started on port ${info.port}`));
                  cfg.set('provider.local', {
                    type: 'local',
                    model: info.modelFile ?? lmName,
                    baseUrl: info.baseUrl,
                  });
                  cfg.set('provider.local.modelKey', lmName);
                  cfg.save().catch(() => {});
                  try {
                    await loop.switchProvider('local');
                    modelName = loop.getActiveProvider().getModel();
                    providerTypeStart = loop.getActiveProvider().getProviderType();
                    refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
                  } catch (swErr) {
                    chatLog.addSystem(theme.warning(`Switch to local: ${(swErr as Error).message}`));
                  }
                } else {
                  chatLog.addSystem(theme.error(`Failed to start ${lmName}`));
                }
                tui.requestRender();
              }).catch((e) => {
                chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
                tui.requestRender();
              });
              tui.requestRender();
              return;
            }
          }
          // 在线模型 L1 直接切换: model/current_online
          if (cmdPath === 'model/current_online') {
            chatLog.addSystem(theme.dim('Already using current online model'));
            tui.requestRender();
            return;
          }
          
          // ── 压缩器控制: compress/* ──
          if (cmdPath === 'compress/strategy' || cmdPath.startsWith('compress/strategy ')) {
            const val = (restArgs || '').trim().toUpperCase();
            if (val !== 'A' && val !== 'C') {
              chatLog.addSystem(theme.warning('Usage: /compress strategy <A|C>'));
              tui.requestRender();
              return;
            }
            cfg.set('context.compressionStrategy', val);
            cfg.save().catch(() => {});
            const desc = val === 'C' ? '克隆对话（缓存友好，默认）' : '独立提示词';
            chatLog.addSystem(theme.success('Compression strategy: ') + theme.fg(desc));
            tui.requestRender();
            return;
          }

          if (cmdPath === 'compress/threshold' || cmdPath.startsWith('compress/threshold ')) {
            const val = parseFloat((restArgs || '').trim());
            if (isNaN(val) || val < 0 || val > 1) {
              chatLog.addSystem(theme.warning('Usage: /compress threshold <0.0-1.0>'));
              tui.requestRender();
              return;
            }
            cfg.set('context.compressThreshold', val);
            cfg.save().catch(() => {});
            chatLog.addSystem(theme.success('Compress threshold: ') + theme.fg(String(val)));
            tui.requestRender();
            updateTokenEstimate();
            return;
          }

          if (cmdPath === 'compress/emergency' || cmdPath.startsWith('compress/emergency ')) {
            const val = parseFloat((restArgs || '').trim());
            if (isNaN(val) || val < 0 || val > 1) {
              chatLog.addSystem(theme.warning('Usage: /compress emergency <0.0-1.0>'));
              tui.requestRender();
              return;
            }
            cfg.set('context.emergencyThreshold', val);
            cfg.save().catch(() => {});
            chatLog.addSystem(theme.success('Emergency threshold: ') + theme.fg(String(val)));
            tui.requestRender();
            updateTokenEstimate();
            return;
          }

          if (cmdPath === 'compress/depth' || cmdPath.startsWith('compress/depth ')) {
            const val = parseFloat((restArgs || '').trim());
            if (isNaN(val) || val < 0 || val > 1) {
              chatLog.addSystem(theme.warning('Usage: /compress depth <0.0-1.0>'));
              tui.requestRender();
              return;
            }
            cfg.set('context.compressDepth', val);
            cfg.save().catch(() => {});
            chatLog.addSystem(theme.success('Compress depth: ') + theme.fg(String(val)));
            tui.requestRender();
            updateTokenEstimate();
            return;
          }

// ── 通道管理: channel/* ──
          if (cmdPath.startsWith('channel/')) {
            const modelRouter = (loop as any).modelRouter;
            if (!modelRouter) {
              chatLog.addSystem(theme.warning('ModelRouter not available'));
              tui.requestRender();
              return;
            }
            const registry = modelRouter.getRegistry();

            if (cmdPath === 'channel/list') {
              const channels = registry.listChannels();
              const roles = registry.listRoles();
              if (channels.length === 0) {
                chatLog.addSystem(theme.dim('No model channels configured. All roles use main provider.'));
              } else {
                const lines: string[] = [theme.accent('=== Model Channels ===')];
                for (const ch of channels) {
                  const chRoles = Object.entries(roles)
                    .filter(([, cn]) => cn === ch.name)
                    .map(([r]) => r);
                  const roleStr = chRoles.length > 0 ? theme.dim(' → ') + theme.fg(chRoles.join(', ')) : '';
                  lines.push(theme.fg(`  ${ch.name}`) + theme.dim(`: ${ch.provider}/${ch.model || 'default'}`) + roleStr);
                }
                lines.push('');
                lines.push(theme.accent('=== Role Mappings ==='));
                for (const [role, channel] of Object.entries(roles)) {
                  lines.push(theme.dim(`  ${role}`) + ' → ' + theme.fg(String(channel)));
                }
                chatLog.addSystem(lines.join('\n'));
              }
              tui.requestRender();
              return;
            }

            if (cmdPath === 'channel/add') {
              if (!restArgs) {
                chatLog.addSystem(theme.warning('Usage: /channel add <name> [provider] [model]'));
                tui.requestRender();
                return;
              }
              const parts = restArgs.split(/\s+/).filter(Boolean);
              const [name, provider, model] = parts;
              try {
                registry.upsertChannel(name, { provider, model });
                const info = registry.getChannelInfo(name);
                chatLog.addSystem(theme.success(`Channel "${name}" added (${info?.provider}${model ? '/' + model : ''})`));
              } catch (e) {
                chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
              }
              tui.requestRender();
              return;
            }

            if (cmdPath === 'channel/remove') {
              if (!restArgs) {
                chatLog.addSystem(theme.warning('Usage: /channel remove <name>'));
                tui.requestRender();
                return;
              }
              const name = restArgs.trim();
              try {
                registry.removeChannel(name);
                chatLog.addSystem(theme.success(`Channel "${name}" removed`));
              } catch (e) {
                chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
              }
              tui.requestRender();
              return;
            }

            if (cmdPath === 'channel/role') {
              if (!restArgs) {
                chatLog.addSystem(theme.warning('Usage: /channel role <role> <channel>'));
                tui.requestRender();
                return;
              }
              const parts = restArgs.split(/\s+/).filter(Boolean);
              if (parts.length < 2) {
                chatLog.addSystem(theme.warning('Usage: /channel role <role> <channel>'));
                tui.requestRender();
                return;
              }
              const [role, channel] = parts;
              try {
                registry.setRoleMapping(role, channel);
                chatLog.addSystem(theme.success(`Role "${role}" → channel "${channel}"`));
              } catch (e) {
                chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
              }
              tui.requestRender();
              return;
            }

            // ── 通道子命令: channel/<name>/info | /model | /reset ──
            const chMatch = cmdPath.match(/^channel\/([^/]+)\/(info|model|reset)$/);
            if (chMatch) {
              const chName = chMatch[1];
              const action = chMatch[2];

              if (action === 'info') {
                const info = registry.getChannelInfo(chName);
                if (!info) {
                  chatLog.addSystem(theme.warning(`Channel "${chName}" not found`));
                } else {
                  const lines: string[] = [theme.accent(`=== Channel: ${info.name}${info.isMain ? ' (main)' : ''} ===`)];
                  lines.push(theme.fg('  Provider: ') + info.provider);
                  lines.push(theme.fg('  Model:    ') + info.model);
                  lines.push(theme.fg('  Type:     ') + info.providerType);
                  if (info.description) lines.push(theme.dim('  Desc:     ') + info.description);
                  if (info.roles.length > 0) lines.push(theme.fg('  Roles:    ') + info.roles.join(', '));
                  chatLog.addSystem(lines.join('\n'));
                }
                tui.requestRender();
                return;
              }

              if (action === 'model') {
                const parts = (restArgs || '').split(/\s+/).filter(Boolean);
                if (parts.length < 1) {
                  chatLog.addSystem(theme.warning(`Usage: /channel/${chName}/model <provider> [model-name]`));
                  tui.requestRender();
                  return;
                }
                const provider = parts[0];
                const model = parts[1] || undefined;
                try {
                  registry.setChannelModel(chName, provider, model);
                  const updated = registry.getChannelInfo(chName);
                  chatLog.addSystem(theme.success(`Channel "${chName}" model set → ${updated?.provider}/${updated?.model} (runtime only, not persisted)`));
                } catch (e) {
                  chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
                }
                tui.requestRender();
                return;
              }

              if (action === 'reset') {
                try {
                  registry.resetChannelModel(chName);
                  const info = registry.getChannelInfo(chName);
                  chatLog.addSystem(theme.success(`Channel "${chName}" reset → ${info?.provider}/${info?.model}`));
                } catch (e) {
                  chatLog.addSystem(theme.error(`Failed: ${(e as Error).message}`));
                }
                tui.requestRender();
                return;
              }
            }
          }

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

    if (input === '/zone4 on') {
      knowledgeBase.setZone4Enabled(true);
      contextComposer.activeConditions.add('zone4_enabled');
      chatLog.addSystem(theme.success('Zone 4 已开启'));
      tui.requestRender();
      return;
    }
    if (input === '/zone4 off') {
      knowledgeBase.setZone4Enabled(false);
      contextComposer.activeConditions.delete('zone4_enabled');
      chatLog.addSystem(theme.dim('Zone 4 已关闭（知识库同步停用）'));
      tui.requestRender();
      return;
    }

    if (input === '/kb on') {
      if (!knowledgeBase.zone4Enabled) {
        knowledgeBase.setZone4Enabled(true);
        contextComposer.activeConditions.add('zone4_enabled');
        chatLog.addSystem(theme.dim('Zone 4 已同步开启'));
      }
      knowledgeBase.enable();
      chatLog.addSystem(theme.success('知识库已开启 — Zone 4 将注入检索结果'));
      tui.requestRender();
      return;
    }
    if (input === '/kb off') {
      knowledgeBase.disable();
      chatLog.addSystem(theme.dim('知识库已关闭'));
      tui.requestRender();
      return;
    }

    if (input === '/precise on') {
      const { PreciseStrategy } = await import('../context/precision/index.js');
      if (!originalSessionDir) originalSessionDir = sessionDir;
      // 复用已有 precise session（保留积累的关键词和摘要）
      const existingPrecise = (await sessionManager.list())
        .find(s => s.type === 'precise');
      const newSession = existingPrecise ?? await sessionManager.create('precise');
      const newSessionDir = sessionManager.getSessionDir(newSession.id);
      const precise = new PreciseStrategy(newSessionDir);
      loop.composeStrategy = precise;
      await loop.switchSession(newSessionDir);
      sessionDir = newSessionDir;
      preciseModeActive = true;
      const label = existingPrecise ? '恢复已有' : '新建';
      chatLog.addSystem(theme.success(`精确模式已开启 — ${label} session: ${newSession.id}`));
      chatLog.clearAll();
      tui.requestRender();
      return;
    }
    if (input === '/precise off') {
      if (!preciseModeActive) {
        chatLog.addSystem(theme.dim('精确模式未开启'));
        tui.requestRender();
        return;
      }
      const { DefaultStrategy } = await import('../context/precision/index.js');
      loop.composeStrategy = new DefaultStrategy();
      if (originalSessionDir) {
        await loop.switchSession(originalSessionDir);
        sessionDir = originalSessionDir;
        originalSessionDir = null;
        chatLog.clearAll();
        replayEvents(chatLog, sessionDir);
      }
      preciseModeActive = false;
      chatLog.addSystem(theme.dim('精确模式已关闭，已恢复原始 session'));
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

    if (input.startsWith('/plan ')) {
      const task = input.slice(6).trim();
      if (!task) {
        chatLog.addSystem(theme.warning('Usage: /plan "task description"'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      modeManager?.activate('plan', { task });
      chatLog.addSystem(theme.success('Plan mode activated: ') + theme.fg(task));
      // 替换 input 为任务文本，继续走下方的 LLM 调用流程
      input = task;
    }

    if (input.startsWith('/spec ')) {
      const task = input.slice(6).trim();
      if (!task) {
        chatLog.addSystem(theme.warning('Usage: /spec "task description"'));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      modeManager?.activate('spec', { task });
      chatLog.addSystem(theme.success('Spec mode activated: ') + theme.fg(task));
      input = task;
    }

    if (input === '/done') {
      if (modeManager?.isActive()) {
        const modeName = modeManager?.getActive();
        modeManager?.deactivate();
        chatLog.addSystem(theme.success(`Mode "${modeName}" deactivated.`));
      } else {
        chatLog.addSystem(theme.dim('No active mode to deactivate.'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    if (input === '/status') {
      const s = cfg.getAll();
      const items: [string, unknown][] = [
        ['Provider', s.provider.active],
        ['Model', s.provider[s.provider.active as keyof typeof s.provider] as { model?: string } | string[] | undefined],
        ['Active Mode', modeManager?.isActive() ? modeManager?.getActive() : 'none'],
        ['Max Context', `${s.session.maxContext.toLocaleString()} tokens`],
        ['Max Turns', s.session.maxTurns],
        ['Compress Threshold', s.context.compressThreshold.toFixed(2)],
        ['Confirmation', s.safety.requireConfirmation ? 'on' : 'off'],
        ['Scavenge', s.repair.scavenge.enabled ? 'on' : 'off'],
        ['Storm', s.repair.storm.enabled ? 'on' : 'off'],
        ['Storm Window', s.repair.storm.windowSize],
        ['Storm Threshold', s.repair.storm.threshold],
        ['Training', s.training.enabled ? 'on' : 'off'],
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

      const sources = loop.getModelSources();
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
      const activeP = loop.getActiveProvider();
      const modelCtxWindow = getModelContextWindow(activeP.getProviderType(), activeP.getModel());
      const upper = modelCtxWindow; // 当前模型支持的最大上下文
      if (isNaN(tokens) || tokens < 1 || tokens > upper) {
        chatLog.addSystem(theme.warning(`Usage: /context <1-${upper.toLocaleString()}>`) + theme.dim(` (model: ${activeP.getModel()})`));
        tui.requestRender();
        updateTokenEstimate();
        return;
      }
      cfg.set('session.maxContext', tokens);
      cfg.save().catch(() => {});
      chatLog.addSystem(theme.success('Max context set to ') + theme.fg(tokens.toLocaleString() + ' tokens'));
      refreshStatus(loop.getTurnInfo(lastTurnCount, lastTokensUsed));
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
      cfg.set('session.maxTurns', n);
      cfg.save().catch(() => {});
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
      cfg.set('context.compressThreshold', val);
      cfg.save().catch(() => {});
      chatLog.addSystem(theme.success('Compression threshold set to ') + theme.fg(val.toFixed(2)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /confirm on|off ──
    if (input.startsWith('/confirm ')) {
      const arg = input.slice(9).trim();
      if (arg === 'on') {
        cfg.set('safety.requireConfirmation', true);
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.success('Tool confirmation ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        cfg.set('safety.requireConfirmation', false);
        cfg.save().catch(() => {});
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
        cfg.set('logging.level', arg as 'debug' | 'info' | 'warn' | 'error' | 'off');
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.success('Log level set to ') + theme.fg(arg));
      } else {
        chatLog.addSystem(theme.warning('Usage: /log <debug|info|warn|error|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /training on|off ──
    if (input.startsWith('/training ')) {
      const arg = input.slice(10).trim();
      if (arg === 'on') {
        cfg.set('training.enabled', true);
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.success('Training mode ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        cfg.set('training.enabled', false);
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.warning('Training mode ') + theme.fg('disabled'));
      } else {
        chatLog.addSystem(theme.warning('Usage: /training <on|off>'));
      }
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /scavenge on|off ──
    if (input.startsWith('/scavenge ')) {
      const arg = input.slice(10).trim();
      if (arg === 'on') {
        cfg.set('repair.scavenge.enabled', true);
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.success('Scavenge repair ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        cfg.set('repair.scavenge.enabled', false);
        cfg.save().catch(() => {});
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
        cfg.set('repair.storm.enabled', true);
        cfg.save().catch(() => {});
        chatLog.addSystem(theme.success('Storm protection ') + theme.fg('enabled'));
      } else if (arg === 'off') {
        cfg.set('repair.storm.enabled', false);
        cfg.save().catch(() => {});
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
      cfg.set('repair.storm.windowSize', n);
      cfg.save().catch(() => {});
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
      cfg.set('repair.storm.threshold', n);
      cfg.save().catch(() => {});
      chatLog.addSystem(theme.success('Storm threshold set to ') + theme.fg(String(n)));
      tui.requestRender();
      updateTokenEstimate();
      return;
    }

    // ── /schedule ──
    if (input === '/schedule') {
      const scheduler = loop.getScheduler();
      if (!scheduler) {
        chatLog.addSystem(theme.dim('No scheduler configured'));
      } else {
        const allTasks = scheduler.getTasks();
        const activeTasks = allTasks.filter(
          (t: { enabled?: boolean; nextRunAt?: unknown }) => t.enabled && t.nextRunAt !== null,
        );
        const disabledCount = allTasks.length - activeTasks.length;
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
              ? new Date(task.nextRunAt).toLocaleString()
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

      await loop.addScheduledTask(name, 'daily', time);
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
      const restartFile = path.join(process.cwd(), '.agent', '.restart-session');
      fsSync.mkdirSync(path.dirname(restartFile), { recursive: true });
      fsSync.writeFileSync(restartFile, 'true', 'utf-8');
      setTimeout(() => process.exit(42), 200);
      return;
    }

    // ── /new ──
    if (input === '/new') {
      chatLog.addSystem(theme.accent('Starting new session...'));
      tui.requestRender();
      const fsSync = (await import('node:fs')).default;
      const newFlag = path.join(process.cwd(), '.agent', '.new-session');
      fsSync.mkdirSync(path.dirname(newFlag), { recursive: true });
      fsSync.writeFileSync(newFlag, 'true', 'utf-8');
      setTimeout(() => process.exit(42), 200);
      return;
    }

    // \u2500\u2500 Message Queue Integration \u2500\u2500
    const mode = MessageQueue.detectMode(input);
    const cleanText = MessageQueue.stripMarkers(input);

    if (isProcessing) {
      messageQueue.enqueue(cleanText, mode);
      if (mode === QueueMessageMode.Insert) {
        chatLog.addSystem(theme.warning(`\u23e9 Inserting: ${truncateMsg(cleanText)}`));
        loop.interrupt();
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
      loop.interrupt();
    } else {
      chatLog.addSystem(theme.warning('Ctrl+C \u2014 press again to exit'));
    }
    tui.requestRender();
  };

  editor.onEscape = () => {
    if (searchMode) {
      closeSearch();
    }
    tui.requestRender();
  };

  editor.onCtrlL = () => {
    chatLog.clearAll();
    tui.requestRender();
  };

  editor.onCtrlP = () => {
    loop.toggleProvider();
    modelName = loop.getActiveProvider().getModel();
    providerTypeStart = loop.getActiveProvider().getProviderType();
    const providerInfo = loop.getProviderRoutingInfo();
    if (providerInfo) {
      chatLog.addSystem(
        theme.accent('Provider toggled to ') +
          theme.fg(providerInfo.providerLabel) +
          theme.dim(` (${providerInfo.mode})`),
      );
    } else {
      chatLog.addSystem(theme.dim('No ProviderRouter configured.'));
    }
    const statsP = statsManager.get(sessionDir);
    statsP.then((st) => {
      const tc = st.turn_count ?? 0;
      refreshStatus(loop.getTurnInfo(tc, st.current_context_tokens ?? 0));
    }).catch(() => {});
    tui.requestRender();
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
  let searchMode = false;
  let searchQuery = '';
  let searchMatches: number[] = [];
  let searchMatchIndex = 0;

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

    // ── Permission bar: Left/Right arrows + Enter ──
    if (permissionQueue.length > 0) {
      if (matchesKey(data, Key.left)) {
        permissionSelection = (permissionSelection + 2) % 3;
        updatePermissionBar();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.right)) {
        permissionSelection = (permissionSelection + 1) % 3;
        updatePermissionBar();
        tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        const options: Array<'yes' | 'always' | 'no'> = ['yes', 'always', 'no'];
        resolvePermission(options[permissionSelection]);
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
      updateUnreadHint();
      tui.requestRender();
      return { consume: true };
    }

    // Ctrl+F: toggle search overlay
    if (matchesKey(data, Key.ctrl('f'))) {
      if (searchMode) {
        closeSearch();
      } else {
        openSearch();
      }
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
      updateUnreadHint();
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

  // ── Search helpers ──
  let searchOverlayContainer: Container | null = null;
  let searchOverlayText: Text | null = null;

  /** Highlight occurrences of `query` in `text` (case-insensitive) using accent color */
  function highlightMatch(text: string, query: string, maxLen = 80): string {
    if (!query) return theme.dim(text.slice(0, maxLen));
    const truncated = text.slice(0, maxLen);
    const lower = truncated.toLowerCase();
    const q = query.toLowerCase();
    let result = '';
    let idx = 0;
    while (idx < truncated.length) {
      const found = lower.indexOf(q, idx);
      if (found === -1) {
        result += theme.dim(truncated.slice(idx));
        break;
      }
      if (found > idx) {
        result += theme.dim(truncated.slice(idx, found));
      }
      result += theme.accent(truncated.slice(found, found + q.length));
      idx = found + q.length;
    }
    return result;
  }

  function performSearch(query: string): void {
    searchQuery = query;
    const contentLines = chatLog.getContentLines();
    const cleanLines = contentLines.map((l) =>
      // eslint-disable-next-line no-control-regex
      l.replace(/\x1b\[[0-9;]*m/g, ''),
    );

    searchMatches = [];
    const lowerQuery = query.toLowerCase();
    for (let i = 0; i < cleanLines.length; i++) {
      if (cleanLines[i].toLowerCase().includes(lowerQuery)) {
        searchMatches.push(i);
      }
    }
    searchMatchIndex = 0;

    if (searchOverlayText) {
      if (searchMatches.length > 0) {
        const preview = highlightMatch(cleanLines[searchMatches[0]]!, query);
        searchOverlayText.setText(
          theme.accent('Search: ') +
            theme.fg(query) +
            theme.dim(` [${searchMatchIndex + 1}/${searchMatches.length}]`) +
            '\n' +
            preview,
        );
      } else {
        searchOverlayText.setText(
          theme.accent('Search: ') + theme.fg(query) + theme.dim(' [0/0]'),
        );
      }
    }
    tui.requestRender();
  }

  function nextSearchMatch(): void {
    if (searchMatches.length === 0) return;
    searchMatchIndex = (searchMatchIndex + 1) % searchMatches.length;
    chatLog.scrollToLine(searchMatches[searchMatchIndex]);
    if (searchOverlayText) {
      const contentLines = chatLog.getContentLines();
      const cleanLines = contentLines.map((l) =>
        // eslint-disable-next-line no-control-regex
        l.replace(/\x1b\[[0-9;]*m/g, ''),
      );
      const preview = highlightMatch(cleanLines[searchMatches[searchMatchIndex]] ?? '', searchQuery);
      searchOverlayText.setText(
        theme.accent('Search: ') +
          theme.fg(searchQuery) +
          theme.dim(` [${searchMatchIndex + 1}/${searchMatches.length}]`) +
          '\n' +
          preview,
      );
    }
    tui.requestRender();
  }

  function openSearch(): void {
    searchMode = true;
    searchQuery = '';
    searchMatches = [];
    searchMatchIndex = 0;

    searchOverlayContainer = new Container();
    searchOverlayText = new Text(
      theme.accent('Search: ') + theme.dim('type to search, Enter for next, Esc to close'),
      0,
      0,
    );
    searchOverlayContainer.addChild(searchOverlayText);
    tui.showOverlay(searchOverlayContainer);
    tui.requestRender();

    // Add a temporary input listener for search typing
    const searchListenerId = `search_${Date.now()}`;
    tui.addInputListener((data) => {
      if (!searchMode) return undefined;

      if (matchesKey(data, Key.escape)) {
        closeSearch();
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        nextSearchMatch();
        return { consume: true };
      }
      if (matchesKey(data, Key.backspace)) {
        if (searchQuery.length > 0) {
          searchQuery = searchQuery.slice(0, -1);
          performSearch(searchQuery);
        }
        return { consume: true };
      }
      // Regular character input
      if (typeof data === 'string' && data.length === 1 && !data.startsWith('\x1b')) {
        searchQuery += data;
        performSearch(searchQuery);
        return { consume: true };
      }
      // Consume all other input while searching
      return { consume: true };
    });
  }

  function closeSearch(): void {
    searchMode = false;
    searchQuery = '';
    searchMatches = [];
    searchMatchIndex = 0;
    searchOverlayText = null;
    if (searchOverlayContainer) {
      tui.hideOverlay();
      searchOverlayContainer = null;
    }
    tui.requestRender();
  }

  // ── Initial render ──
  const stats = await statsManager.get(sessionDir);
  const initialInfo = loop.getTurnInfo(0, stats.current_context_tokens ?? 0);
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