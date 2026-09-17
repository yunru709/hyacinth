/**
 * 「渠道只持有自己前缀的会话」不变式 —— 判定入口单测 + 插件接线守卫。
 *
 * 需求：重启时**各在线渠道持有各自前缀的最新 session**。
 *
 * 保障方式按渠道而异（本文件分别钉住接线）：
 *   · clawbot —— **不持久化本地映射**，会话单点取自会话目录（getLatestByChannel
 *     按渠道过滤）。曾把 userId→sessionId 存进 clawbot_session.json 作第二份状态，
 *     必然陈旧（实测重启后锚定已删除的 clawbot_20260713-…），该机制已整体移除。
 *   · feishu —— 仍持久化映射，故恢复时**必须**校验归属，且豁免 __shared__ 伪会话。
 *
 * 判定入口收敛在 session-channel.sessionBelongsToChannel()，与 memory/session.ts 的
 * getLatestByChannel 口径一致。
 *
 * 注：UI 侧（TUI、WebUI）走 boot 的按渠道恢复，见 boot-channel-restore.test.ts。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import {
  sessionBelongsToChannel,
  registerChannelPrefixes,
  resolveChannelFromSessionId,
} from './session-channel.js';

describe('sessionBelongsToChannel：归属判定', () => {
  it('本渠道前缀 → 属于（前缀字面量判据，无需注册）', () => {
    expect(sessionBelongsToChannel('clawbot_20260917-002414-0304', 'clawbot')).toBe(true);
    expect(sessionBelongsToChannel('feishu_ou_abc123', 'feishu')).toBe(true);
  });

  it('别渠道前缀 → 不属于', () => {
    expect(sessionBelongsToChannel('tui_20260916-164132-04c4', 'clawbot')).toBe(false);
    expect(sessionBelongsToChannel('webui_20260917-002244-9623', 'tui')).toBe(false);
  });

  it('裸 ID（无前缀）→ 不属于任何渠道（历史事故形态）', () => {
    expect(sessionBelongsToChannel('20260916-223857-0e9c', 'clawbot')).toBe(false);
  });

  it('一渠道多前缀（webui_ + 旧版 ui_）经注册表也算属于', () => {
    registerChannelPrefixes(['webui_', 'ui_'], 'webui');
    expect(resolveChannelFromSessionId('ui_20260915-010101-aaaa')).toBe('webui');
    expect(sessionBelongsToChannel('ui_20260915-010101-aaaa', 'webui')).toBe(true);
  });

  it('空值 → 不属于（防御）', () => {
    expect(sessionBelongsToChannel('', 'clawbot')).toBe(false);
    expect(sessionBelongsToChannel('clawbot_x', '')).toBe(false);
  });
});

describe('插件接线守卫：渠道只持有自己的会话', () => {
  const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf-8');

  it('clawbot：不再自行解析/持久化会话（会话主控权归内核 SessionService）', async () => {
    const src = await read('./channels/plugins/clawbot/clawbot-channel.ts');
    // 旧实现把 userId→sessionId 持久化到 clawbot_session.json；这份「第二状态」必然陈旧：
    // 2026-09-17 实测重启后锚定到已被清理的 clawbot_20260713-…（「TUI 与微信共用 session」
    // 事故的一环）。现在会话单点由内核 SessionService 解析（single 策略），
    // 渠道不再持有 SessionManager/generateSessionId/getLatestByChannel。
    expect(src).not.toContain('clawbot_session.json');
    expect(src).not.toContain('getLatestByChannel');
    expect(src).not.toContain('generateSessionId');
    expect(src).not.toContain('new SessionManager');
  });

  it('飞书：会话映射持久化与归属校验迁入内核 SessionService（豁免 __shared__ 伪会话）', async () => {
    const src = await read('./session-service.ts');
    // 旧实现位于 feishu-channel.ts restoreFeishuState：恢复会话映射时校验归属，
    // 且豁免 __shared__ 伪会话。会话主控权收归内核后该逻辑迁入 migrateFeishuLegacy。
    expect(src).toContain('sid === \'__shared__\'');
    expect(src).toContain('sessionBelongsToChannel(sid, \'feishu\')');
  });

  it('飞书渠道文件不再含会话映射解析/持久化内核职责字符串', async () => {
    const src = await read('./channels/plugins/feishu/feishu-channel.ts');
    expect(src).not.toContain('conversationToSession');
    expect(src).not.toContain('generateSessionId');
    expect(src).not.toContain('sessionBelongsToChannel');
    expect(src).not.toContain('__channelLoopRegistry');
  });
});
