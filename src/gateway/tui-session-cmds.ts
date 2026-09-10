/**
 * tui-session-cmds.ts —— session/* 会话管理命令模块（tui.ts 深拆第九批）。
 *
 * 迁出 session/<id>/load|delete、list、new、load、delete（约 120 行）。
 * 报告评估为「状态写回最多」的命令族——sessionDir/lastTurnCount/
 * lastTokensUsed 三个外部 let 经 setter 回调写回（不动 runTui 绑定）。
 *
 * 行为零变更：就地切换（protocolSend session.switch + sessionDir 重绑定 +
 * replayEvents 重放）、当前活跃 session 保护、类型匹配校验、list 渲染
 * 全部原样保留。SessionManager / fsPromises 动态 import 保留。
 */

import type { TUI } from '@earendil-works/pi-tui';
import path from 'node:path';
import type { ChatLog } from '../ui/chat-log.js';
import { theme } from '../ui/theme.js';
import type { StatsManager } from '../memory/stats.js';
import type { TurnInfo } from '../orchestrator/loop.js';
import { replayEvents } from './tui-format.js';

/** session/* 命令的最小依赖面 */
export interface TuiSessionCmdDeps {
  tui: Pick<TUI, 'requestRender'>;
  chatLog: Pick<ChatLog, 'addSystem' | 'clearAll' | 'addUser' | 'startTool' | 'updateToolResult'>;
  updateTokenEstimate: () => void;
  protocolSend: (method: string, params?: unknown) => Promise<unknown>;
  statsManager: Pick<StatsManager, 'get'>;
  refreshStatus: (info: TurnInfo) => void;
  /** loop（session 切换后刷新状态栏用 getTurnInfo） */
  getLoop: () => { getTurnInfo(turns: number, tokens: number): TurnInfo };
  /** 当前活跃 session 目录（外部 let） */
  getSessionDir: () => string;
  setSessionDir: (d: string) => void;
  setLastTurnCount: (n: number) => void;
  setLastTokensUsed: (n: number) => void;
}

/** 创建 session/* 命令处理器 */
export function createSessionCmds(deps: TuiSessionCmdDeps) {
  const {
    tui, chatLog, updateTokenEstimate, protocolSend, statsManager,
    refreshStatus, getLoop, getSessionDir, setSessionDir,
    setLastTurnCount, setLastTokensUsed,
  } = deps;

  /** 执行一个 session 子命令（cmdPath 形如 'session/<id>/load' / 'session/list'） */
  async function handle(cmdPath: string, restArgs: string): Promise<void> {
    const sub = cmdPath.slice('session/'.length);
    // 支持嵌套路径: session/<id>/load → sub = "<id>/load"
    const subParts = sub.split('/');
    if (subParts.length === 2 && (subParts[1] === 'load' || subParts[1] === 'delete')) {
      // session/<id>/load 或 session/<id>/delete
      const sessionId = subParts[0];
      if (subParts[1] === 'load') {
        const SessionManager = (await import('../memory/session.js')).SessionManager;
        const sm = new SessionManager(process.cwd());
        const dir = sm.getSessionDir(sessionId);
        // 就地切换，不重启（session 域 switch：ensureExists + loop.switchSession + SESSION_CHANGE 事件）。
        // 存在性校验已下沉到域层 ensureExists —— 直连 fs.access 前置检查移除（协议收口）。
        try {
          await protocolSend('session.switch', { sessionId });
        } catch {
          chatLog.addSystem(theme.warning(`Session "${sessionId}" not found. Use /session list to see available sessions.`));
          tui.requestRender();
          updateTokenEstimate();
          return;
        }
        setSessionDir(dir);
        setLastTurnCount(0);
        setLastTokensUsed(0);
        const newStats = await statsManager.get(dir);
        refreshStatus(getLoop().getTurnInfo(newStats.turn_count ?? 0, newStats.current_context_tokens ?? 0));
        chatLog.clearAll();
        replayEvents(chatLog, dir);
        chatLog.addSystem(theme.success(`已切换到 session ${sessionId}`));
        updateTokenEstimate();
      } else {
        const SessionManager = (await import('../memory/session.js')).SessionManager;
        const sm = new SessionManager(process.cwd());
        const dir = sm.getSessionDir(sessionId);

        // 保护当前活跃 session
        if (dir === getSessionDir()) {
          chatLog.addSystem(theme.warning(`Cannot delete the currently active session "${sessionId}". Switch to another session first.`));
          tui.requestRender();
          updateTokenEstimate();
          return;
        }

        // 删除动作经协议层 session.delete（域层 ensureExists + rm + SESSION_CHANGE 广播）；
        // 「活跃保护」是 UI 交互策略（阻止删除正在使用的会话），保留在上层。
        try {
          await protocolSend('session.delete', { sessionId });
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
      // 经协议层 session.list 读取（与 WebUI 同路径），本地按当前模式过滤渲染
      const res = (await protocolSend('session.list')) as
        | { sessions: { id: string; createdAt: string; updatedAt: string; type?: string }[] }
        | null
        | undefined;
      const sessions = res?.sessions ?? [];
      const modeType = 'normal';
      const filtered = sessions.filter(s => (s.type ?? 'normal') === modeType);
      if (filtered.length === 0) {
        chatLog.addSystem(theme.dim(`No ${modeType} sessions found`));
      } else {
        for (const s of filtered) {
          const isCurrent = s.id === path.basename(getSessionDir());
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
      chatLog.addSystem(theme.warning('请使用 hyacinth start 启动新会话（当前会话需要退出）'));
    } else if (sub === 'load') {
      const id = restArgs?.trim();
      if (!id) {
        chatLog.addSystem(theme.warning('用法: /session load <sessionId>'));
      } else {
        chatLog.addSystem(theme.warning(`请使用 hyacinth start --session ${id} 加载会话`));
      }
    } else if (sub === 'delete') {
      const id = restArgs?.trim();
      if (!id) {
        chatLog.addSystem(theme.warning('用法: /session delete <sessionId>'));
      } else {
        // 类型校验所需会话元数据经协议层 session.list 读取（与删除动作同路径）
        const res = (await protocolSend('session.list')) as
          | { sessions: { id: string; type?: string }[] }
          | null
          | undefined;
        const sessions = res?.sessions ?? [];
        const target = sessions.find(s => s.id === id);
        if (!target) {
          chatLog.addSystem(theme.warning(`Session ${id} not found`));
        } else if ((target.type ?? 'normal') !== 'normal') {
          chatLog.addSystem(theme.warning(`Session ${id} 是 [${target.type ?? 'normal'}] 类型，当前为 [normal] 模式，无法跨模式操作`));
        } else {
          // 删除动作经协议层 session.delete（域层 ensureExists + rm + SESSION_CHANGE 广播）
          try {
            await protocolSend('session.delete', { sessionId: id });
            chatLog.addSystem(theme.success(`Session ${id} deleted`));
          } catch {
            chatLog.addSystem(theme.warning(`Session ${id} not found`));
          }
        }
      }
    }
    tui.requestRender();
  }

  return { handle };
}

export type TuiSessionCmds = ReturnType<typeof createSessionCmds>;
