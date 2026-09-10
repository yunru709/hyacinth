/**
 * tui-compress-cmds.test.ts —— compress/* 压缩器控制命令单测（tui.ts 深拆第七批）。
 *
 * 覆盖表驱动三子命令（threshold/emergency/depth）：合法值写对 config key、
 * 非法值输出 usage、未知路径静默。零状态写回（仅 setConfig + updateTokenEstimate）。
 */

import { describe, it, expect, vi } from 'vitest';
import { createCompressCmds } from './tui-compress-cmds.js';
import type { ChatLog } from '../ui/chat-log.js';
import type { TUI } from '@earendil-works/pi-tui';

function setup() {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const calls: string[] = [];
  const chatLog = { addSystem: (s: string) => { calls.push(s); } } as unknown as Pick<ChatLog, 'addSystem'>;
  const setConfig = vi.fn(async () => undefined);
  const updateTokenEstimate = vi.fn();
  const ctl = createCompressCmds({ tui, chatLog, setConfig, updateTokenEstimate });
  return { ctl, calls, setConfig, updateTokenEstimate, tui };
}

describe('tui-compress-cmds compress/* 命令', () => {
  it('threshold 合法值 → 写 context.compressThreshold 并刷新 token 估算', async () => {
    const { ctl, setConfig, updateTokenEstimate } = setup();
    await ctl.handle('compress/threshold', '0.7');
    expect(setConfig).toHaveBeenCalledWith('context.compressThreshold', 0.7);
    expect(updateTokenEstimate).toHaveBeenCalled();
  });

  it('emergency 合法值 → 写 context.emergencyThreshold', async () => {
    const { ctl, setConfig } = setup();
    await ctl.handle('compress/emergency', '0.5');
    expect(setConfig).toHaveBeenCalledWith('context.emergencyThreshold', 0.5);
  });

  it('depth 合法值 → 写 context.compressDepth', async () => {
    const { ctl, setConfig } = setup();
    await ctl.handle('compress/depth', '0.3');
    expect(setConfig).toHaveBeenCalledWith('context.compressDepth', 0.3);
  });

  it('非法值（>1）→ 输出 usage，不写配置', async () => {
    const { ctl, calls, setConfig } = setup();
    await ctl.handle('compress/threshold', '1.5');
    expect(calls.join('\n')).toContain('Usage: /compress threshold');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('非数字 → 输出 usage', async () => {
    const { ctl, calls, setConfig } = setup();
    await ctl.handle('compress/depth', 'abc');
    expect(calls.join('\n')).toContain('Usage: /compress depth');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('未知路径 → 静默返回', async () => {
    const { ctl, calls, setConfig } = setup();
    await expect(ctl.handle('compress/nope', '')).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
    expect(setConfig).not.toHaveBeenCalled();
  });
});
