/**
 * TUI 顶部纯格式化工具（阶段 C：从 tui.ts 拆出）。
 *
 * 拆分理由：runTui 是深度闭包巨型函数，内部函数互相依赖闭包状态无法整体拆解；
 * 但顶部这 6 个辅助函数 + BOX_H 常量是**零闭包依赖的纯函数/低耦合函数**，
 * 拆到独立文件后：① tui.ts 单文件行数下降；② 这些函数可独立单测；
 * ③ tui.ts 的 import 区随之精简。
 */
import type { TurnInfo } from '../orchestrator/loop.js';
import { theme } from '../ui/theme.js';
import { ChatLog } from '../ui/chat-log.js';
import { readRecentEvents } from '../memory/events.js';

// ─── Constants ────────────────────────────────────────────────────────────

export const BOX_H = '\u2500'; // ─

// ─── Status Bar Formatters ────────────────────────────────────────────────

/** 计算字符串的视觉宽度（CJK/全角/emoji 计 2，其余计 1） */
export function visualWidth(s: string): number {
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

/** 按视觉宽度截断（超长以 … 结尾） */
export function truncateByVisualWidth(s: string, maxVisualWidth: number): string {
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

/** 组装状态栏文本（Hyacinth · 模型 · Turns · Provider · Plan · 模式） */
export function formatStatusBar(
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
    theme.fg(' Hyacinth'),
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

/** 上下文用量条（█ ░ 填充 + 颜色随占比变化） */
export function formatContextBar(tokensUsed: number, maxTokens: number, width: number = 40): string {
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
 * 参数收窄为最小结构面（仅用 addSystem/addUser/startTool/updateToolResult），
 * 便于 tui-welcome.ts 以 Pick<ChatLog,...> 注入（tui.ts 深拆第四批）。
 */
export function replayEvents(
  chatLog: Pick<ChatLog, 'addSystem' | 'addUser' | 'startTool' | 'updateToolResult'>,
  sessionDir: string,
): void {
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
          // 陪伴表达：回放为普通文本（与实时渲染一致，不显示工具行）
          if (event.name === 'companion_say') {
            const sayInput = (event.input ?? {}) as { text?: string; think?: string; action?: string };
            const parts: string[] = [];
            if (sayInput.action) parts.push(`[${sayInput.action}]`);
            if (sayInput.think) parts.push(`（${sayInput.think}）`);
            if (sayInput.text) parts.push(sayInput.text);
            pendingText += parts.join('');
            break;
          }
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

/**
 * 检测是否运行在旧版 Windows 控制台（conhost）。
 * Windows Terminal / VS Code 集成终端 / WezTerm 等现代终端都会设置
 * WT_SESSION 或 TERM_PROGRAM 环境变量；旧 conhost 两者皆无。
 * 非 Windows 平台（macOS/Linux 各终端）一般无渲染问题，恒返回 false。
 */
export function detectLegacyTerminal(): boolean {
  if (process.platform !== 'win32') return false;
  return !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
}
