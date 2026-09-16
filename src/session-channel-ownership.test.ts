/**
 * 「渠道只持有自己前缀的会话」不变式 —— 判定入口单测 + 插件接线守卫。
 *
 * 需求：重启时**各在线渠道持有各自前缀的最新 session**。这条不变式有两个断点：
 *   ① 渠道恢复自己的持久化映射时不校验归属 → 旧版裸 ID / 别渠道 ID 被沿用
 *      （实测：clawbot 曾持有裸 ID `20260916-223857-0e9c`，见日志
 *      `Continued session {sessionId: "20260916-223857-0e9c", channel: "clawbot"}`）；
 *   ② 判定口径散落各家 → 与 memory/session.ts 的 getLatestByChannel 兜底不一致。
 * 故收敛到 session-channel.sessionBelongsToChannel()，并由本文件钉住两家插件的接线。
 *
 * 注：UI/UI 侧（TUI、WebUI）走 boot 的按渠道恢复，见 boot-channel-restore.test.ts。
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

describe('插件接线守卫：恢复路径必须做归属校验', () => {
  const read = (rel: string) => fs.readFile(new URL(rel, import.meta.url), 'utf-8');

  it('clawbot：恢复时校验并丢弃非本渠道 id', async () => {
    const src = await read('./channels/plugins/clawbot/clawbot-channel.ts');
    expect(src).toContain("sessionBelongsToChannel(sid, 'clawbot')");
  });

  it('clawbot：缺记录时回落到**本渠道最新会话**，而非凭空新建', async () => {
    const src = await read('./channels/plugins/clawbot/clawbot-channel.ts');
    expect(src).toContain("new SessionManager(process.cwd()).getLatestByChannel('clawbot')");
  });

  it('飞书：恢复时校验，且豁免 __shared__ 伪会话', async () => {
    const src = await read('./channels/plugins/feishu/feishu-channel.ts');
    expect(src).toContain("sid === '__shared__' || sessionBelongsToChannel(sid, 'feishu')");
  });
});
