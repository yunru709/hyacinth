/**
 * 重启续工指令的**渠道定向注入** —— 回归守卫（2026-09-17 跨渠道串台事故）。
 *
 * v1 只存裸文本，启动侧「谁先起来就注入给谁」。实测：重启由**微信**会话触发，
 * 重启后先起来的是 UI/TUI 进程（微信渠道当次离线）—— 「请在微信里发一条消息…」
 * 被注入到新建的 UI 会话，用户侧表现为两个渠道串到一份对话里。
 *
 * v2 记录触发重启时所在的渠道/会话，启动侧据此判定；**不匹配就不消费**
 * （标记原样保留，等对应渠道自己上线时接手）= 需求里的「不在线的就不管」。
 */
import { describe, it, expect } from 'vitest';
import {
  parseRestartContinuation,
  shouldInjectContinuation,
  serializeRestartContinuation,
  type RestartContinuation,
} from './protocol.js';

const c = (channel?: string, sessionId?: string): RestartContinuation => ({
  channel, sessionId, message: '继续测试', createdAt: '2026-09-17T00:46:06.000Z',
});

describe('续工指令 v2：序列化 / 解析（兼容 v1）', () => {
  it('v2 JSON 往返：渠道 / 会话 / 消息', () => {
    const parsed = parseRestartContinuation(serializeRestartContinuation(
      c('clawbot', 'clawbot_20260917-002414-0304'),
    ));

    expect(parsed.channel).toBe('clawbot');
    expect(parsed.sessionId).toBe('clawbot_20260917-002414-0304');
    expect(parsed.message).toBe('继续测试');
  });

  it('v1 裸文本 → 无渠道归属（保持旧行为：任何启动模式都可注入）', () => {
    const parsed = parseRestartContinuation('继续测试');

    expect(parsed.channel).toBeUndefined();
    expect(parsed.message).toBe('继续测试');
  });

  it('JSON 缺 message 字段 → 当裸文本处理，不丢内容', () => {
    expect(parseRestartContinuation('{"foo":1}').message).toBe('{"foo":1}');
  });
});

describe('续工指令注入判定', () => {
  it('渠道不同 → **不注入**（串台守卫：微信触发的重启不得污染 UI 会话）', () => {
    const r = shouldInjectContinuation(
      c('clawbot', 'clawbot_20260917-002414-0304'),
      { launchChannel: 'tui', sessionId: 'tui_1' },
    );

    expect(r.inject).toBe(false);
    expect(r.reason).toBe('channel-mismatch');
  });

  it('渠道相同 → 注入', () => {
    expect(
      shouldInjectContinuation(c('tui', 'tui_1'), { launchChannel: 'tui', sessionId: 'tui_2' }),
    ).toMatchObject({ inject: true, reason: 'same-channel' });
  });

  it('渠道不同但恢复的正是那条会话 → 注入（位置没变，注入安全）', () => {
    expect(
      shouldInjectContinuation(
        c('clawbot', 'clawbot_20260917-002414-0304'),
        { launchChannel: undefined, sessionId: 'clawbot_20260917-002414-0304' },
      ),
    ).toMatchObject({ inject: true, reason: 'same-session' });
  });

  it('无渠道归属（v1 / 纯 CLI）→ 注入', () => {
    expect(
      shouldInjectContinuation(c(), { launchChannel: 'tui', sessionId: 'tui_1' }),
    ).toMatchObject({ inject: true, reason: 'no-channel' });
  });
});
