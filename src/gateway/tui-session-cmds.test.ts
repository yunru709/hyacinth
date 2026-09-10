/**
 * tui-session-cmds.test.ts —— session/* 会话管理命令单测（tui.ts 深拆第九批）。
 *
 * 覆盖 list 空与有、<id>/load 不存在降级、<id>/delete 当前活跃保护、
 * new/load/delete 参数提示。deps 全 mock；SessionManager 为真实（读
 * process.cwd() 会话目录，测试环境无会话 → 走降级分支）。
 */

import { describe, it, expect, vi } from 'vitest';
import { createSessionCmds } from './tui-session-cmds.js';
import type { ChatLog } from '../ui/chat-log.js';
import type { TUI } from '@earendil-works/pi-tui';

function setup() {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const calls: string[] = [];
  const chatLog = {
    addSystem: (s: string) => { calls.push(s); },
    clearAll: vi.fn(),
    addUser: vi.fn(),
    startTool: vi.fn(),
    updateToolResult: vi.fn(),
  } as unknown as Pick<ChatLog, 'addSystem' | 'clearAll' | 'addUser' | 'startTool' | 'updateToolResult'>;
  const updateTokenEstimate = vi.fn();
  const protocolSend = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => undefined);
  const statsManager = { get: vi.fn().mockResolvedValue({ turn_count: 0, current_context_tokens: 0 }) };
  const refreshStatus = vi.fn();
  const getLoop = vi.fn().mockReturnValue({ getTurnInfo: () => ({}) });
  const setSessionDir = vi.fn();
  const setLastTurnCount = vi.fn();
  const setLastTokensUsed = vi.fn();
  const getSessionDir = vi.fn().mockReturnValue('/cwd/.agent/sessions/active-1');

  const ctl = createSessionCmds({
    tui, chatLog, updateTokenEstimate, protocolSend, statsManager, refreshStatus,
    getLoop, getSessionDir, setSessionDir, setLastTurnCount, setLastTokensUsed,
  });

  return { ctl, calls, tui, chatLog, protocolSend, setSessionDir, setLastTurnCount, setLastTokensUsed, statsManager, refreshStatus, getSessionDir };
}

describe('tui-session-cmds session/* 命令', () => {
  it('session/list → 经协议层 session.list 读取并渲染', async () => {
    const { ctl, calls, tui, protocolSend } = setup();
    // 协议返回两个会话（normal + companion）→ 本地只渲染 normal
    protocolSend.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return {
          sessions: [
            { id: 'sess-1', createdAt: 't1', updatedAt: 't2', type: 'normal' },
            { id: 'sess-2', createdAt: 't3', updatedAt: 't4', type: 'companion' },
          ],
        };
      }
      return undefined;
    });
    await expect(ctl.handle('session/list', '')).resolves.toBeUndefined();
    expect(protocolSend).toHaveBeenCalledWith('session.list');
    expect(tui.requestRender).toHaveBeenCalled();
    const out = calls.join('\n');
    expect(out).toContain('sess-1');
    expect(out).not.toContain('sess-2');
  });

  it('session/<id>/load 不存在 → 提示 Session not found（域层 ensureExists 抛错）', async () => {
    const { ctl, calls, protocolSend } = setup();
    // 协议化后存在性校验下沉域层：session.switch 对不存在会话 reject
    protocolSend.mockImplementation(async (method: string) => {
      if (method === 'session.switch') throw new Error('session "nonexistent-xyz" not found');
      return undefined;
    });
    await ctl.handle('session/nonexistent-xyz/load', '');
    expect(calls.join('\n')).toContain('Session "nonexistent-xyz" not found');
    // 不触发切换副作用
    expect(calls.join('\n')).not.toContain('已切换到');
  });

  it('session/<id>/delete 非活跃 → 删除动作经协议层 session.delete', async () => {
    const { ctl, calls, protocolSend } = setup();
    protocolSend.mockImplementation(async (method: string) => {
      if (method === 'session.delete') return { ok: true, sessionId: 'sess-x' };
      return undefined;
    });
    await ctl.handle('session/sess-x/delete', '');
    expect(protocolSend).toHaveBeenCalledWith('session.delete', { sessionId: 'sess-x' });
    expect(calls.join('\n')).toContain('Session sess-x deleted');
  });

  it('session/delete <id> 类型不匹配当前模式 → 跨模式提示', async () => {
    const { ctl, calls, protocolSend } = setup();
    protocolSend.mockImplementation(async (method: string) => {
      if (method === 'session.list') {
        return { sessions: [{ id: 'cmp-1', type: 'companion' }] };
      }
      return undefined;
    });
    await ctl.handle('session/delete', 'cmp-1');
    expect(calls.join('\n')).toContain('无法跨模式操作');
    expect(protocolSend).not.toHaveBeenCalledWith('session.delete', { sessionId: 'cmp-1' });
  });

  it('session/<id>/delete 当前活跃 → 保护提示', async () => {
    // 让 getSessionDir 与 SessionManager.getSessionDir(id) 相等 → 保护分支
    const { ctl, calls, getSessionDir } = setup();
    // SessionManager(process.cwd()).getSessionDir('active-1') 返回真实路径
    const { SessionManager } = await import('../memory/session.js');
    const sm = new SessionManager(process.cwd());
    const realDir = sm.getSessionDir('active-1');
    getSessionDir.mockReturnValue(realDir);
    await ctl.handle('session/active-1/delete', '');
    expect(calls.join('\n')).toContain('Cannot delete the currently active session');
  });

  it('session/new → 提示用 hyacinth start', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('session/new', '');
    expect(calls.join('\n')).toContain('hyacinth start');
  });

  it('session/load 缺参 → usage', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('session/load', '');
    expect(calls.join('\n')).toContain('用法: /session load');
  });

  it('session/delete 缺参 → usage', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('session/delete', '');
    expect(calls.join('\n')).toContain('用法: /session delete');
  });
});
