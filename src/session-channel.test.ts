/**
 * session-channel 注册表单测（根级**纯**注册表）。
 *
 * 核心不变量：**注册表初始为空 —— 核心不认识任何渠道**。
 * 这条断言就是"注册式"的验收门：任何人往核心预置渠道前缀，本测试立刻失败。
 */
import { describe, it, expect } from 'vitest';
import {
  registerChannelPrefix,
  registerChannelPrefixes,
  unregisterChannelPrefixes,
  resolveChannelFromSessionId,
  listChannelPrefixes,
} from './session-channel.js';

describe('session-channel 注册表（纯注册表，零渠道知识）', () => {
  it('初始为空：核心不预置任何渠道前缀（含 tui_/webui_ 等）', () => {
    expect(listChannelPrefixes()).toEqual([]);
    expect(resolveChannelFromSessionId('tui_abc')).toBeUndefined();
    expect(resolveChannelFromSessionId('webui_abc')).toBeUndefined();
    expect(resolveChannelFromSessionId('feishu_abc')).toBeUndefined();
    expect(resolveChannelFromSessionId('clawbot_abc')).toBeUndefined();
  });

  it('未注册前缀恒 undefined（裸日期 ID 本就没有渠道来源）', () => {
    expect(resolveChannelFromSessionId('20260916-170213-1bfa')).toBeUndefined();
    expect(resolveChannelFromSessionId('')).toBeUndefined();
  });

  it('最长前缀优先：短前缀不会抢走更长匹配', () => {
    registerChannelPrefix('ui_', 'webui');
    registerChannelPrefix('ui_ext_', 'ui-ext');
    expect(resolveChannelFromSessionId('ui_ext_1')).toBe('ui-ext');
    expect(resolveChannelFromSessionId('ui_other')).toBe('webui');
    unregisterChannelPrefixes(['ui_', 'ui_ext_']);
  });

  it('批量注册（多前缀）+ 幂等', () => {
    registerChannelPrefixes(['hub_', 'hub2_'], 'hub');
    registerChannelPrefixes(['hub_', 'hub2_'], 'hub'); // 重复登记幂等
    expect(listChannelPrefixes().filter((p) => p.channel === 'hub')).toHaveLength(2);
    expect(resolveChannelFromSessionId('hub_1')).toBe('hub');
    expect(resolveChannelFromSessionId('hub2_1')).toBe('hub');

    unregisterChannelPrefixes(['hub_', 'hub2_']);
    expect(resolveChannelFromSessionId('hub_1')).toBeUndefined();
  });

  it('注销只影响目标前缀', () => {
    registerChannelPrefix('tmp_', 'tmp');
    registerChannelPrefix('keep_', 'keep');
    unregisterChannelPrefixes('tmp_');
    expect(resolveChannelFromSessionId('tmp_1')).toBeUndefined();
    expect(resolveChannelFromSessionId('keep_1')).toBe('keep');
    unregisterChannelPrefixes('keep_');
  });

  it('单前缀字符串与数组两种入参等价', () => {
    registerChannelPrefixes('one_', 'one');
    expect(resolveChannelFromSessionId('one_1')).toBe('one');
    unregisterChannelPrefixes('one_');
    expect(resolveChannelFromSessionId('one_1')).toBeUndefined();
  });

  it('收尾：注册表回到空', () => {
    expect(listChannelPrefixes()).toEqual([]);
  });
});
