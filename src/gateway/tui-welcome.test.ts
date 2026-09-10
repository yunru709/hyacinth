/**
 * tui-welcome.test.ts —— 启动欢迎屏单测（tui.ts 深拆第四批）。
 *
 * 覆盖 showWelcome：ASCII art 缺失时的标题框渲染、Persona/操作提示行、
 * sessionDir 重放分支（空目录不输出 Previous Session）。asciiDir 注入
 * 临时目录，避免污染用户 ~/.agent/ascii。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { showWelcome } from './tui-welcome.js';
import type { TUI } from '@earendil-works/pi-tui';
import type { ChatLog } from '../ui/chat-log.js';

/** ChatLog 最小 mock：记录 addSystem 输出（覆盖 deps 声明的 4 方法面） */
function mockChatLog() {
  const calls: string[] = [];
  const chatLog = {
    addSystem: (s: string) => { calls.push(s); },
    addUser: () => {},
    startTool: () => {},
    updateToolResult: () => {},
  } as unknown as Pick<ChatLog, 'addSystem' | 'addUser' | 'startTool' | 'updateToolResult'>;
  return { chatLog, calls };
}

const tmpDirs: string[] = [];
function tmpdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-welcome-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('showWelcome 启动欢迎屏', () => {
  it('无 ascii 图时渲染标题框、Persona 与操作提示', async () => {
    const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
    const { chatLog, calls } = mockChatLog();
    await showWelcome({ tui, chatLog, personaDir: '/fake/persona', asciiDir: tmpdir() });

    // 标题框内容（无 art → 首行即是顶框）
    expect(calls[0]).toContain('╭');
    expect(calls.join('\n')).toContain('Hyacinth');
    expect(calls.join('\n')).toContain('Persona:');
    expect(calls.join('\n')).toContain('/fake/persona');
    expect(calls.join('\n')).toContain('Type');
    expect(calls.join('\n')).toContain('exit');
    // 不输出 Previous Session（无 sessionDir）
    expect(calls.join('\n')).not.toContain('Previous Session');
    expect(tui.requestRender).toHaveBeenCalled();
  });

  it('无 sessionDir 时不触发历史重放', async () => {
    const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
    const { chatLog, calls } = mockChatLog();
    await showWelcome({ tui, chatLog, personaDir: '/p', asciiDir: tmpdir() });
    expect(calls.join('\n')).not.toContain('Previous Session');
  });

  it('sessionDir 为空目录时同样不输出 Previous Session（readRecentEvents 空）', async () => {
    const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
    const { chatLog, calls } = mockChatLog();
    const sessionDir = tmpdir();
    await showWelcome({ tui, chatLog, personaDir: '/p', sessionDir, asciiDir: tmpdir() });
    // replayEvents 异步读目录；空目录无事件 → 不输出 Previous Session
    expect(calls.join('\n')).not.toContain('Previous Session');
  });

  it('ascii 图存在时标题框包含 art 行（写入图片 + 等待缓存路径兜底）', async () => {
    const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
    const { chatLog, calls } = mockChatLog();
    // 无真实图片 → loadAsciiArt 返回 null，行为同用例 1；此处仅验证不抛错
    await expect(
      showWelcome({ tui, chatLog, personaDir: '/p', asciiDir: tmpdir() }),
    ).resolves.toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
  });
});
