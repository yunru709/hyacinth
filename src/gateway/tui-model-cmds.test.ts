/**
 * tui-model-cmds.test.ts —— model 非 local 命令处理器单测（tui.ts 深拆第六批）。
 *
 * 覆盖 createModelCmds.handle 的各分支：switch 配置模型名、provider 切换
 * （协议 + 持久化 + 状态写回）、source 参数校验、thinking 转发、show-thinking
 * 切换、info 渲染、context 缺参提示。localModel/protocolSend/setConfig 等
 * 全 mock；getLocalProviderConfigLoader 为真实配置读取（测试环境无配置）。
 */

import { describe, it, expect, vi } from 'vitest';
import { createModelCmds } from './tui-model-cmds.js';
import type { ChatLog } from '../ui/chat-log.js';
import type { TUI } from '@earendil-works/pi-tui';

function setup() {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const calls: string[] = [];
  const chatLog = { addSystem: (s: string) => { calls.push(s); } } as unknown as Pick<ChatLog, 'addSystem'>;

  const bridge = { stopAll: vi.fn().mockResolvedValue(undefined) };
  const localModel = {
    list: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue(null),
    getBridge: vi.fn().mockReturnValue(bridge),
    switch: vi.fn().mockResolvedValue(null),
  };
  const protocolSend = vi.fn(async () => undefined);
  const setConfig = vi.fn(async () => undefined);
  // 默认返回 undefined（协议不可用语义）→ 切换类命令走 "Switch incomplete" 警告分支；
  // 需要断言成功/失败文案的用例自行 mockResolvedValue 快照
  const refreshStatusFromProtocol = vi.fn(async () => undefined);
  const getProviderType = vi.fn(() => 'deepseek');
  const getModelName = vi.fn(() => 'deepseek-chat');
  const applyThinking = vi.fn(async () => undefined);
  const updateTokenEstimate = vi.fn();
  let showThinking = false;
  const getShowThinking = vi.fn(() => showThinking);
  const setShowThinking = vi.fn((v: boolean) => { showThinking = v; });

  const ctl = createModelCmds({
    tui, chatLog, localModel, protocolSend, setConfig, refreshStatusFromProtocol,
    getProviderType, getModelName, applyThinking, updateTokenEstimate,
    getShowThinking, setShowThinking,
  });

  return { ctl, calls, tui, localModel, protocolSend, setConfig, refreshStatusFromProtocol, applyThinking, updateTokenEstimate, setShowThinking };
}

describe('tui-model-cmds model 命令', () => {
  it('model/switch：经协议切换当前 provider 的模型（UI 不再直写配置）', async () => {
    const { ctl, protocolSend, setConfig, refreshStatusFromProtocol } = setup();
    await ctl.handle('model/switch', 'gpt-x');
    expect(protocolSend).toHaveBeenCalledWith('model.switch', { provider: 'deepseek', model: 'gpt-x' });
    // 配置落盘由协议层统一负责（唯一写入口）
    expect(setConfig).not.toHaveBeenCalledWith('provider.deepseek.model', 'gpt-x');
    expect(refreshStatusFromProtocol).toHaveBeenCalled();
  });

  it('model/provider：切换非 local provider（协议层持久化，UI 不写配置）', async () => {
    const { ctl, protocolSend, setConfig, refreshStatusFromProtocol } = setup();
    await ctl.handle('model/provider', 'anthropic');
    expect(protocolSend).toHaveBeenCalledWith('model.switch', { provider: 'anthropic' });
    // provider.active 由协议层落盘（唯一写入口），UI 不再直写
    expect(setConfig).not.toHaveBeenCalledWith('provider.active', 'anthropic');
    expect(refreshStatusFromProtocol).toHaveBeenCalled();
  });

  it('model/provider 缺参 → usage', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/provider', '');
    expect(calls.join('\n')).toContain('Usage: /model provider');
  });

  it('model/source 缺参 → usage（含角色列表）', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/source', '');
    expect(calls.join('\n')).toContain('Usage: /model source');
  });

  it('model/source 角色非法 → 提示合法角色', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/source', 'bogus main');
    expect(calls.join('\n')).toContain('Role must be');
  });

  it('model/thinking/on → 转发到 applyThinking', async () => {
    const { ctl, applyThinking } = setup();
    await ctl.handle('model/thinking/on', '');
    expect(applyThinking).toHaveBeenCalledWith('on');
  });

  it('model/show-thinking → 切换 showThinking 状态并刷新 token 估算', async () => {
    const { ctl, setShowThinking, updateTokenEstimate } = setup();
    await ctl.handle('model/show-thinking', '');
    expect(setShowThinking).toHaveBeenCalledWith(true);
    expect(updateTokenEstimate).toHaveBeenCalled();
  });

  it('model/info → 渲染模型信息', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/info', '');
    const out = calls.join('\n');
    expect(out).toContain('Model Info');
    expect(out).toContain('Provider:');
    expect(out).toContain('Model:');
  });

  it('model/current_online → 提示已在用当前在线模型', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/current_online', '');
    expect(calls.join('\n')).toContain('Already using current online model');
  });

  it('model/online/<p>/<m> → 经协议切换在线模型（UI 不写配置）', async () => {
    const { ctl, protocolSend, setConfig, refreshStatusFromProtocol } = setup();
    protocolSend.mockResolvedValue({ provider: 'anthropic', model: 'claude-x' } as never);
    await ctl.handle('model/online/anthropic/claude-x', '');
    expect(protocolSend).toHaveBeenCalledWith('model.switch', { provider: 'anthropic', model: 'claude-x' });
    // 配置落盘由协议层统一负责（唯一写入口）
    expect(setConfig).not.toHaveBeenCalledWith('provider.anthropic.model', 'claude-x');
    expect(setConfig).not.toHaveBeenCalledWith('provider.active', 'anthropic');
    expect(refreshStatusFromProtocol).toHaveBeenCalled();
  });

  it('model/online/<p>/config → 提示用 /context 调窗口', async () => {
    const { ctl, calls, protocolSend } = setup();
    await ctl.handle('model/online/anthropic/config', '');
    expect(calls.join('\n')).toContain('Configure anthropic');
    expect(protocolSend).not.toHaveBeenCalled();
  });

  it('model/online + restArgs（直接命令入口）→ 经协议切换在线模型', async () => {
    const { ctl, protocolSend, setConfig, refreshStatusFromProtocol } = setup();
    protocolSend.mockResolvedValue({ provider: 'volcengine', model: 'doubao-x' } as never);
    await ctl.handle('model/online', 'volcengine doubao-x');
    expect(protocolSend).toHaveBeenCalledWith('model.switch', { provider: 'volcengine', model: 'doubao-x' });
    expect(setConfig).not.toHaveBeenCalledWith('provider.volcengine.model', 'doubao-x');
    expect(setConfig).not.toHaveBeenCalledWith('provider.active', 'volcengine');
    expect(refreshStatusFromProtocol).toHaveBeenCalled();
  });

  it('model/online 缺参 → usage（不再静默）', async () => {
    const { ctl, calls, protocolSend } = setup();
    await ctl.handle('model/online', '');
    expect(calls.join('\n')).toContain('Usage: /model online');
    expect(protocolSend).not.toHaveBeenCalled();
  });

  it('model/online 实际生效（协议返回生效值）→ success 文案', async () => {
    const { ctl, calls, protocolSend } = setup();
    // 生效值来自 model.switch 的返回值（UI 不再发第二次 state.get 自行比对）
    protocolSend.mockResolvedValue({ provider: 'volcengine', model: 'glm-5.3-flash' } as never);
    await ctl.handle('model/online', 'volcengine glm-5.3-flash');
    expect(calls.join('\n')).toContain('Switched to volcengine/glm-5.3-flash');
  });

  it('model/online 实际未生效（协议返回旧模型）→ warning 报告实际值', async () => {
    const { ctl, calls, protocolSend } = setup();
    protocolSend.mockResolvedValue({ provider: 'volcengine', model: 'doubao-seed-evolving' } as never);
    await ctl.handle('model/online', 'volcengine glm-5.3-flash');
    const out = calls.join('\n');
    expect(out).toContain('Switch incomplete');
    expect(out).toContain('doubao-seed-evolving');
    expect(out).toContain('requested volcengine/glm-5.3-flash');
    expect(out).not.toContain('Switched to');
  });

  it('model/settings/context 缺参 → usage 含上下文窗口', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/settings/context', '');
    expect(calls.join('\n')).toContain('Usage: /model settings context');
  });
});
