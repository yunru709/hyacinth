/**
 * tui-model-local.test.ts —— model/local/* 命令处理器单测（tui.ts 深拆第五批）。
 *
 * 覆盖 createModelLocalCmds.handle 的各分支：unregister 参数校验、switch 的
 * 协议/持久化/状态写回、register 空与命中、status 渲染、start 无参列表、
 * 未知路径静默。localModel/supervisor 全 mock；detectLocalBackend 为真实
 * HTTP 只读探测（测试环境无本地服务 → 返回 null，无副作用）。
 */

import { describe, it, expect, vi } from 'vitest';
import { createModelLocalCmds } from './tui-model-local.js';
import type { ChatLog } from '../ui/chat-log.js';
import type { TUI } from '@earendil-works/pi-tui';

function setup() {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const calls: string[] = [];
  const chatLog = { addSystem: (s: string) => { calls.push(s); } } as unknown as Pick<ChatLog, 'addSystem'>;

  const bridge = {
    getAllStatus: vi.fn().mockReturnValue([]),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
  };
  const localModel = {
    checkOllama: vi.fn().mockReturnValue(null),
    checkLlamacpp: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    getBridge: vi.fn().mockReturnValue(bridge),
    start: vi.fn().mockResolvedValue(null),
    scanUnregistered: vi.fn().mockResolvedValue([]),
    registerModel: vi.fn().mockReturnValue({}),
    unregister: vi.fn().mockReturnValue('Unregistered: foo'),
  };
  const supervisor = {
    startOllamaOnDemand: vi.fn().mockResolvedValue(null),
    stopModel: vi.fn().mockResolvedValue(undefined),
  };
  const protocolSend = vi.fn(async () => undefined);
  const setConfig = vi.fn(async () => undefined);
  const refreshStatusFromProtocol = vi.fn(async () => undefined);

  const ctl = createModelLocalCmds({
    tui, chatLog, localModel, supervisor, protocolSend, setConfig,
    refreshStatusFromProtocol,
  });

  return { ctl, calls, tui, localModel, supervisor, protocolSend, setConfig, refreshStatusFromProtocol };
}

describe('tui-model-local model/local/* 命令', () => {
  it('unregister 无参 → 输出 usage，不调用 unregister', async () => {
    const { ctl, calls, localModel } = setup();
    await ctl.handle('model/local/unregister', '');
    expect(calls.join('\n')).toContain('Usage: /model/local unregister');
    expect(localModel.unregister).not.toHaveBeenCalled();
  });

  it('unregister 有参 → 调用 unregister 并输出结果', async () => {
    const { ctl, calls, localModel } = setup();
    await ctl.handle('model/local/unregister', 'foo');
    expect(localModel.unregister).toHaveBeenCalledWith('foo');
    expect(calls.join('\n')).toContain('Unregistered: foo');
  });

  it('switch → 协议切换 + 持久化 + 经 refreshStatusFromProtocol 读回缓存', async () => {
    const { ctl, protocolSend, setConfig, refreshStatusFromProtocol } = setup();
    await ctl.handle('model/local/switch', '');
    expect(protocolSend).toHaveBeenCalledWith('model.switch', { provider: 'local' });
    expect(setConfig).toHaveBeenCalledWith('provider.active', 'local');
    // 缓存写回职责移交 refreshStatusFromProtocol（state.get 读回），不再直读 loop
    expect(refreshStatusFromProtocol).toHaveBeenCalled();
  });

  it('register 空 → 提示无新模型，不注册', async () => {
    const { ctl, calls, localModel } = setup();
    await ctl.handle('model/local/register', '');
    expect(calls.join('\n')).toContain('无新模型');
    expect(localModel.registerModel).not.toHaveBeenCalled();
  });

  it('register 命中 → 逐个注册', async () => {
    const { ctl, calls, localModel } = setup();
    localModel.scanUnregistered.mockResolvedValue([
      { name: 'qwen7b', modelFile: 'qwen.gguf', backend: 'llamacpp' },
      { name: 'llama3', modelFile: 'llama.gguf' },
    ]);
    await ctl.handle('model/local/register', '');
    expect(localModel.registerModel).toHaveBeenCalledTimes(2);
    expect(calls.join('\n')).toContain('Registered: qwen7b');
  });

  it('status → 渲染本地模型状态（无 ollama/llamacpp 时显示未安装）', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/local/status', '');
    const out = calls.join('\n');
    expect(out).toContain('本地模型状态');
    expect(out).toContain('Ollama: 未安装');
    expect(out).toContain('llama.cpp: 未安装');
  });

  it('start 无参 → 列出可用后端', async () => {
    const { ctl, calls } = setup();
    await ctl.handle('model/local/start', '');
    expect(calls.join('\n')).toContain('可用本地后端');
  });

  it('未知路径 → 静默返回（不输出、不抛错）', async () => {
    const { ctl, calls, protocolSend } = setup();
    await expect(ctl.handle('model/local/nope', '')).resolves.toBeUndefined();
    expect(calls.length).toBe(0);
    expect(protocolSend).not.toHaveBeenCalled();
  });
});
