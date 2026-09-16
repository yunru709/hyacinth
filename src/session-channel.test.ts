/**
 * session-channel 注册表单测（根级中立契约）。
 *
 * 覆盖：内置前缀模块加载即注册、最长前缀优先、批量注册（多前缀）、幂等、注销。
 * 注意：feishu_ / clawbot_ 属**插件渠道**、由插件在 autoRegister 里登记，
 * 不在本单测断言范围内（见 session-prefix-contract.guard.test.ts 的源码级守卫）。
 */
import { describe, it, expect } from 'vitest';
import {
  registerChannelPrefix,
  registerChannelPrefixes,
  unregisterChannelPrefixes,
  resolveChannelFromSessionId,
  listChannelPrefixes,
} from './session-channel.js';

describe('session-channel 注册表', () => {
  it('内置前缀：模块加载即注册（tui / webui）', () => {
    expect(resolveChannelFromSessionId('tui_20260916-164132-04c4')).toBe('tui');
    expect(resolveChannelFromSessionId('webui_20260916-101010-aaaa')).toBe('webui');
  });

  it('旧版 ui_ 前缀兼容存量会话（归 webui）', () => {
    expect(resolveChannelFromSessionId('ui_20250101-000000-aaaa')).toBe('webui');
  });

  it('最长前缀优先，ui_ 不会抢走 webui_ 的会话', () => {
    expect(resolveChannelFromSessionId('webui_x')).toBe('webui');
    expect(resolveChannelFromSessionId('ui_x')).toBe('webui');
  });

  it('未知前缀 / 空串 → undefined（裸日期 ID 无渠道来源）', () => {
    expect(resolveChannelFromSessionId('20260916-170213-1bfa')).toBeUndefined();
    expect(resolveChannelFromSessionId('')).toBeUndefined();
    expect(resolveChannelFromSessionId('hub_1')).toBeUndefined();
  });

  it('批量注册多前缀（插件渠道用）+ 幂等', () => {
    registerChannelPrefixes(['hub_', 'hub2_'], 'hub');
    expect(resolveChannelFromSessionId('hub_1')).toBe('hub');
    expect(resolveChannelFromSessionId('hub2_1')).toBe('hub');

    registerChannelPrefixes(['hub_', 'hub2_'], 'hub'); // 重复登记幂等
    expect(listChannelPrefixes().filter((p) => p.channel === 'hub')).toHaveLength(2);

    unregisterChannelPrefixes(['hub_', 'hub2_']);
    expect(resolveChannelFromSessionId('hub_1')).toBeUndefined();
    expect(resolveChannelFromSessionId('hub2_1')).toBeUndefined();
  });

  it('注销只影响目标前缀，不动其他渠道', () => {
    registerChannelPrefix('tmp_', 'tmp');
    unregisterChannelPrefixes('tmp_');
    expect(resolveChannelFromSessionId('tmp_1')).toBeUndefined();
    expect(resolveChannelFromSessionId('tui_1')).toBe('tui');
  });

  it('单前缀字符串与数组两种入参等价', () => {
    registerChannelPrefixes('one_', 'one');
    expect(resolveChannelFromSessionId('one_1')).toBe('one');
    unregisterChannelPrefixes('one_');
    expect(resolveChannelFromSessionId('one_1')).toBeUndefined();
  });
});
