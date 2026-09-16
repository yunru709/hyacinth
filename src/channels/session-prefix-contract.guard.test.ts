/**
 * session-prefix-contract.guard.test.ts —— session 前缀契约守卫。
 *
 * 锁定的真实事故：sessionId 前缀→渠道映射曾是散落在核心文件里的硬编码字面量，
 * 与渠道实现分家 —— 插件渠道 clawbot 在生产侧 generateSessionId('clawbot')
 * 造得出 clawbot_xxx，注册表里却没有 clawbot_，会话归属永远推断不出。
 *
 * 本守卫测试固定两条不变量：
 *   1. 内置渠道 handler 的 sessionPrefix 必须**引用**内置前缀表常量（单一真源），
 *      不得自己写一份字面量 —— 否则又会和表漂移。
 *   2. 插件渠道必须在 autoRegister 的 enabled 提前 return **之前**无条件登记前缀，
 *      否则插件被禁用时存量会话 ID 推断不出渠道（这正是缺口所在）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TuiChannel } from './builtin/tui-channel.js';
import { HttpWebhookChannel } from './builtin/http-webhook.js';
import {
  TUI_SESSION_PREFIX,
  WEBUI_SESSION_PREFIXES,
  resolveChannelFromSessionId,
  listChannelPrefixes,
} from '../session-channel.js';

describe('内置渠道前缀契约（单一真源）', () => {
  it('内置 handler 的 sessionPrefix 引用内置前缀表常量，不是自己的字面量', () => {
    expect(new TuiChannel().sessionPrefix).toBe(TUI_SESSION_PREFIX);
    expect(new HttpWebhookChannel().sessionPrefix).toBe(WEBUI_SESSION_PREFIXES);
  });

  it('模块加载即注册，内置渠道可反查（不依赖渠道是否启用）', () => {
    expect(resolveChannelFromSessionId('tui_abc')).toBe('tui');
    expect(resolveChannelFromSessionId('webui_abc')).toBe('webui');
    expect(resolveChannelFromSessionId('ui_abc')).toBe('webui');
  });

  it('核心前缀表不含插件渠道（核心不得反向依赖插件）', () => {
    const channels = listChannelPrefixes().map((p) => p.channel);
    expect(channels).not.toContain('feishu');
    expect(channels).not.toContain('clawbot');
  });
});

describe('插件渠道前缀契约（禁用时仍可解析）', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it.each([
    ['src/channels/plugins/feishu/index.ts', 'FEISHU_SESSION_PREFIX'],
    ['src/channels/plugins/clawbot/index.ts', 'CLAWBOT_SESSION_PREFIX'],
  ])('%s：前缀登记必须早于 enabled 判断（否则禁用即失联）', (rel, constName) => {
    const src = read(rel);
    const regIdx = src.indexOf(`registerChannelPrefixes(${constName}`);
    const enabledIdx = src.indexOf('enabled !== false');
    expect(regIdx, '缺少无条件前缀登记').toBeGreaterThan(-1);
    expect(enabledIdx, '缺少 enabled 判断锚点').toBeGreaterThan(-1);
    expect(regIdx).toBeLessThan(enabledIdx);
  });

  it.each([
    ['src/channels/plugins/feishu/feishu-channel.ts', "export const FEISHU_SESSION_PREFIX = 'feishu_'", 'FEISHU_SESSION_PREFIX'],
    ['src/channels/plugins/clawbot/clawbot-channel.ts', "export const CLAWBOT_SESSION_PREFIX = 'clawbot_'", 'CLAWBOT_SESSION_PREFIX'],
  ])('%s：前缀常量在插件内自管并挂到 handler 上', (rel, constDecl, constName) => {
    const src = read(rel);
    expect(src).toContain(constDecl);
    expect(src).toContain(`readonly sessionPrefix = ${constName};`);
  });
});
