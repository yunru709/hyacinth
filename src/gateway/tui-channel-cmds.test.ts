/**
 * tui-channel-cmds.test.ts —— channel/* 通道管理命令单测（tui.ts 深拆第八批）。
 *
 * 覆盖 list/add/remove/role/<name>/info|model|reset 各分支 + registry 缺失
 * 降级。registry 以类型化 ChannelRegistryLike mock（模块内无 as any）。
 *
 * 协议收口（T1）后分两组：协议未就绪（getProtocolSend → null）走 registry
 * 降级路径（文案零变更）；协议可用走 model.*Channel 主路径。
 */

import { describe, it, expect, vi } from 'vitest';
import { createChannelCmds, createChannelDispatch } from './tui-channel-cmds.js';
import type { ChannelRegistryLike, ProtocolSendLike } from './tui-channel-cmds.js';
import type { ChatLog } from '../ui/chat-log.js';
import type { TUI } from '@earendil-works/pi-tui';

function setup(registry: ChannelRegistryLike | null = null, getProtocolSend: () => ProtocolSendLike | null = () => null) {
  const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
  const calls: string[] = [];
  const chatLog = { addSystem: (s: string) => { calls.push(s); } } as unknown as Pick<ChatLog, 'addSystem'>;
  const getChannelRegistry = vi.fn(() => registry);
  const ctl = createChannelCmds({ tui, chatLog, getProtocolSend, getChannelRegistry });
  return { ctl, calls, tui, getChannelRegistry };
}

function makeRegistry(over: Partial<ChannelRegistryLike> = {}): ChannelRegistryLike {
  return {
    listChannels: () => [],
    listRoles: () => ({}),
    upsertChannel: () => {},
    getChannelInfo: () => undefined,
    removeChannel: () => {},
    setRoleMapping: () => {},
    setChannelModel: () => {},
    resetChannelModel: () => {},
    ...over,
  } as ChannelRegistryLike;
}

describe('tui-channel-cmds channel/* 命令（协议未就绪 → registry 降级）', () => {
  it('registry 缺失 → 提示 ModelRouter not available', async () => {
    const { ctl, calls } = setup(null);
    await ctl.handle('channel/list', '');
    expect(calls.join('\n')).toContain('ModelRouter not available');
  });

  it('channel/list 空 → 提示无通道', async () => {
    const { ctl, calls } = setup(makeRegistry());
    await ctl.handle('channel/list', '');
    expect(calls.join('\n')).toContain('No model channels configured');
  });

  it('channel/list 有通道 → 渲染通道与角色映射', async () => {
    const registry = makeRegistry({
      listChannels: () => [{ name: 'feishu', provider: 'deepseek', model: 'v4' }],
      listRoles: () => ({ assessment: 'feishu', planning: 'main' }),
    });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/list', '');
    const out = calls.join('\n');
    expect(out).toContain('Model Channels');
    expect(out).toContain('feishu');
    expect(out).toContain('Role Mappings');
  });

  it('channel/add 缺参 → usage', async () => {
    const { ctl, calls } = setup(makeRegistry());
    await ctl.handle('channel/add', '');
    expect(calls.join('\n')).toContain('Usage: /channel add');
  });

  it('channel/add 成功 → upsertChannel 并展示', async () => {
    const registry = makeRegistry({
      upsertChannel: vi.fn(),
      getChannelInfo: () => ({ name: 'slack', provider: 'deepseek', model: 'v4', providerType: 'deepseek', roles: [] }),
    });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/add', 'slack deepseek v4');
    expect(registry.upsertChannel).toHaveBeenCalledWith('slack', { provider: 'deepseek', model: 'v4' });
    expect(calls.join('\n')).toContain('Channel "slack" added');
  });

  it('channel/remove 成功 → removeChannel', async () => {
    const registry = makeRegistry({ removeChannel: vi.fn() });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/remove', 'slack');
    expect(registry.removeChannel).toHaveBeenCalledWith('slack');
    expect(calls.join('\n')).toContain('Channel "slack" removed');
  });

  it('channel/role 成功 → setRoleMapping', async () => {
    const registry = makeRegistry({ setRoleMapping: vi.fn() });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/role', 'planning feishu');
    expect(registry.setRoleMapping).toHaveBeenCalledWith('planning', 'feishu');
    expect(calls.join('\n')).toContain('Role "planning" → channel "feishu"');
  });

  it('channel/<name>/info 存在 → 渲染通道详情', async () => {
    const registry = makeRegistry({
      getChannelInfo: () => ({ name: 'feishu', provider: 'deepseek', model: 'v4', providerType: 'deepseek', roles: ['assessment'], isMain: false }),
    });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/feishu/info', '');
    const out = calls.join('\n');
    expect(out).toContain('Channel: feishu');
    expect(out).toContain('Provider: deepseek');
    expect(out).toContain('Roles:');
  });

  it('channel/<name>/model 成功 → setChannelModel', async () => {
    const registry = makeRegistry({
      setChannelModel: vi.fn(),
      getChannelInfo: () => ({ name: 'feishu', provider: 'minimax', model: 'm2', providerType: 'minimax', roles: [] }),
    });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/feishu/model', 'minimax m2');
    expect(registry.setChannelModel).toHaveBeenCalledWith('feishu', 'minimax', 'm2');
    expect(calls.join('\n')).toContain('Channel "feishu" model set');
  });

  it('channel/<name>/reset 成功 → resetChannelModel', async () => {
    const registry = makeRegistry({
      resetChannelModel: vi.fn(),
      getChannelInfo: () => ({ name: 'feishu', provider: 'deepseek', model: 'v4', providerType: 'deepseek', roles: [] }),
    });
    const { ctl, calls } = setup(registry);
    await ctl.handle('channel/feishu/reset', '');
    expect(registry.resetChannelModel).toHaveBeenCalledWith('feishu');
    expect(calls.join('\n')).toContain('Channel "feishu" reset');
  });
});

describe('tui-channel-cmds channel/* 命令（协议可用 → model.*Channel 主路径）', () => {
  /** 协议发送 mock：按 method 返回 model 域响应；未命中返回 undefined（未就绪） */
  function makeSend(responses: Record<string, unknown>): { send: ProtocolSendLike; requested: Array<{ method: string; params?: unknown }> } {
    const requested: Array<{ method: string; params?: unknown }> = [];
    const send: ProtocolSendLike = async (method, params) => {
      requested.push({ method, params });
      return responses[method];
    };
    return { send, requested };
  }

  it('channel/add 协议成功 → 走 model.upsertChannel，不直写 registry', async () => {
    const registry = makeRegistry({ upsertChannel: vi.fn() });
    const { send, requested } = makeSend({
      'model.upsertChannel': { ok: true, name: 'slack' },
    });
    const { ctl, calls } = setup(registry, () => send);
    await ctl.handle('channel/add', 'slack deepseek v4');
    expect(requested[0]).toEqual({ method: 'model.upsertChannel', params: { name: 'slack', provider: 'deepseek', model: 'v4' } });
    expect(registry.upsertChannel).not.toHaveBeenCalled();
    expect(calls.join('\n')).toContain('Channel "slack" added');
  });

  it('channel/list 协议成功 → 渲染协议数据，不读 registry', async () => {
    const registry = makeRegistry({ listChannels: vi.fn(() => []), listRoles: vi.fn(() => ({})) });
    const { send } = makeSend({
      'model.listChannels': { channels: [{ name: 'feishu', provider: 'deepseek', model: 'v4' }] },
      'model.listRoles': { roles: { assessment: 'feishu' } },
    });
    const { ctl, calls } = setup(registry, () => send);
    await ctl.handle('channel/list', '');
    expect(calls.join('\n')).toContain('feishu');
    expect(calls.join('\n')).toContain('Role Mappings');
    expect(registry.listChannels).not.toHaveBeenCalled();
  });

  it('channel/<name>/info 协议成功 → 渲染协议详情', async () => {
    const { send } = makeSend({
      'model.getChannelInfo': { info: { name: 'feishu', provider: 'deepseek', model: 'v4', providerType: 'deepseek', roles: ['assessment'], isMain: false } },
    });
    const { ctl, calls } = setup(makeRegistry(), () => send);
    await ctl.handle('channel/feishu/info', '');
    const out = calls.join('\n');
    expect(out).toContain('Channel: feishu');
    expect(out).toContain('Provider: deepseek');
  });

  it('协议返回 undefined（启动窗口期 no-op）→ 降级 registry 直连', async () => {
    const registry = makeRegistry({ upsertChannel: vi.fn(), getChannelInfo: () => undefined });
    const { send } = makeSend({}); // 所有 method 都返回 undefined
    const { ctl, calls } = setup(registry, () => send);
    await ctl.handle('channel/add', 'slack deepseek');
    expect(registry.upsertChannel).toHaveBeenCalledWith('slack', { provider: 'deepseek', model: undefined });
    expect(calls.join('\n')).toContain('Channel "slack" added');
  });

  it('协议异常（send throw）→ 降级 registry 直连', async () => {
    const registry = makeRegistry({ removeChannel: vi.fn() });
    const send: ProtocolSendLike = async () => { throw new Error('boom'); };
    const { ctl, calls } = setup(registry, () => send);
    await ctl.handle('channel/remove', 'slack');
    expect(registry.removeChannel).toHaveBeenCalledWith('slack');
    expect(calls.join('\n')).toContain('Channel "slack" removed');
  });
});

describe('tui-channel-cmds 通用渠道分发（createChannelDispatch）', () => {
  function setupDispatch(handler?: { handleTuiCommand?: (c: string, a: string) => Promise<string | null> }) {
    const tui = { requestRender: vi.fn() } as unknown as Pick<TUI, 'requestRender'>;
    const calls: string[] = [];
    const chatLog = { addSystem: (s: string) => { calls.push(s); } } as unknown as Pick<ChatLog, 'addSystem'>;
    const channelManager = {
      get: (id: string) => id === 'clawbot' ? { handler: handler ?? {} } : undefined,
    };
    const ctl = createChannelDispatch({ tui, chatLog, getChannelManager: () => channelManager });
    return { ctl, calls, tui };
  }

  it('渠道 id 命中且返回结果 → 输出并消费（true）', async () => {
    const { ctl, calls } = setupDispatch({ handleTuiCommand: async () => 'clawbot ok' });
    const consumed = await ctl.handle('clawbot/login', '');
    expect(consumed).toBe(true);
    expect(calls.join('\n')).toContain('clawbot ok');
  });

  it('渠道 id 命中但返回 null → 不消费（false）', async () => {
    const { ctl, calls } = setupDispatch({ handleTuiCommand: async () => null });
    const consumed = await ctl.handle('clawbot/login', '');
    expect(consumed).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('未知渠道 id → 不消费（false）', async () => {
    const { ctl, calls } = setupDispatch();
    const consumed = await ctl.handle('nope/login', '');
    expect(consumed).toBe(false);
    expect(calls.length).toBe(0);
  });
});
