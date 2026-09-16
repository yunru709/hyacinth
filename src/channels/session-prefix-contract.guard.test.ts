/**
 * session-prefix-contract.guard.test.ts —— session 前缀契约守卫（**注册式**验收）。
 *
 * 锁定的两起真实事故：
 *   1. 前缀曾是散落核心的硬编码字面量、与渠道实现分家 —— 插件渠道 clawbot
 *      生产侧 generateSessionId('clawbot') 造得出 clawbot_xxx，注册表里却从来没有
 *      clawbot_，会话归属永远推断不出。
 *   2. handler id 与会话归属渠道名不一致（HttpWebhookChannel.id='http-webhook'，
 *      而会话记录的 channel='webui'）—— 前缀若解析到 handler id 就会与 meta 不符。
 *
 * 本守卫固定四条不变量：
 *   A. 前缀常量由**渠道模块自己持有**，核心注册表零渠道知识（见 session-channel.test.ts）；
 *   B. 渠道 register 后前缀自动就位、unregister 后失效（不需要任何核心侧登记代码）；
 *   C. 多前缀渠道（webui_ + ui_）一次性登记，且解析到**会话渠道名**而非 handler id；
 *   D. 插件渠道在 autoRegister 的 enabled 提前 return **之前**无条件登记
 *      （否则插件禁用时存量会话推断不出渠道）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TuiChannel, TUI_SESSION_PREFIX } from './builtin/tui-channel.js';
import { HttpWebhookChannel, WEBUI_SESSION_PREFIXES } from './builtin/http-webhook.js';
import { ChannelManager } from './manager.js';
import { resolveChannelFromSessionId } from '../session-channel.js';

describe('内置渠道：前缀自管 + 注册即就位', () => {
  it('前缀常量定义在各自渠道模块内，handler 引用它（核心无渠道知识）', () => {
    expect(TUI_SESSION_PREFIX).toBe('tui_');
    expect(WEBUI_SESSION_PREFIXES).toEqual(['webui_', 'ui_']);
    expect(new TuiChannel().sessionPrefix).toBe(TUI_SESSION_PREFIX);
    expect(new HttpWebhookChannel().sessionPrefix).toBe(WEBUI_SESSION_PREFIXES);
  });

  it('注册前解析不到 → register 后自动就位 → unregister 后失效', () => {
    const m = new ChannelManager();
    expect(resolveChannelFromSessionId('tui_abc')).toBeUndefined();

    m.register(new TuiChannel(), {});
    expect(resolveChannelFromSessionId('tui_abc')).toBe('tui');

    m.unregister('tui');
    expect(resolveChannelFromSessionId('tui_abc')).toBeUndefined();
  });

  it('多前缀渠道一次性登记，且解析到会话渠道名（webui）而非 handler id（http-webhook）', () => {
    const m = new ChannelManager();
    m.register(new HttpWebhookChannel(), {});

    expect(resolveChannelFromSessionId('webui_x')).toBe('webui');
    expect(resolveChannelFromSessionId('ui_x')).toBe('webui'); // 旧版前缀兼容

    m.unregister('http-webhook');
    expect(resolveChannelFromSessionId('webui_x')).toBeUndefined();
    expect(resolveChannelFromSessionId('ui_x')).toBeUndefined();
  });
});

describe('插件渠道：前缀自管 + 禁用仍可解析', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it.each([
    ['src/channels/plugins/feishu/index.ts', 'FEISHU_SESSION_PREFIX'],
    ['src/channels/plugins/clawbot/index.ts', 'CLAWBOT_SESSION_PREFIX'],
  ])('%s：前缀登记必须早于 enabled 判断（否则插件禁用即失联）', (rel, constName) => {
    const src = read(rel);
    const regIdx = src.indexOf(`registerChannelPrefixes(${constName}`);
    const enabledIdx = src.indexOf('enabled !== false');
    expect(regIdx, '缺少无条件前缀登记').toBeGreaterThan(-1);
    expect(enabledIdx, '缺少 enabled 判断锚点').toBeGreaterThan(-1);
    expect(regIdx).toBeLessThan(enabledIdx);
  });

  it.each([
    ['src/channels/plugins/feishu/feishu-channel.ts', 'FEISHU_SESSION_PREFIX', "'feishu_'"],
    ['src/channels/plugins/clawbot/clawbot-channel.ts', 'CLAWBOT_SESSION_PREFIX', "'clawbot_'"],
  ])('%s：前缀常量在插件内自管并挂到 handler 上', (rel, constName, literal) => {
    const src = read(rel);
    expect(src).toContain(`export const ${constName} = ${literal}`);
    expect(src).toContain(`readonly sessionPrefix = ${constName};`);
  });
});
