/**
 * 「重启时各在线渠道恢复各自的 session」—— 需求守卫（2026-09-17 跨渠道串台事故）。
 *
 * 需求原文：**重启时各个在线的渠道恢复各自的上一个 session，不在线的就不管。**
 *
 * 此前链上有两个缺口，使该需求不成立：
 *   ① 会话认不出自己：UI 入口（ui-protocol-session / http-webhook）传 channel:'webui'
 *      却从不登记前缀 → loop 物化 meta.json 时 `resolveChannelFromSessionId()` 反解不出
 *      渠道 → 字段缺失 → `getLatestByChannel()` 恒 null → 每次重启都 fail-closed 开新会话。
 *   ② 认不出自己的后果：新会话成了「当前会话」，而被重启的续工指令（可能来自**离线**
 *      渠道，如微信）正好被塞进来 —— 表现为两个渠道串到一份对话里。
 *
 * 本文件钉死三条不变式：
 *   A. 本渠道有存量会话（含 meta 缺 channel 的历史会话）→ **必须恢复它**
 *   B. 不认领别渠道的存量会话（哪怕它是全局最新）
 *   C. 渠道无存量会话 → 开本渠道的新会话（fail-closed），且新会话可反解出渠道
 */
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { boot } from './boot.js';
import { SessionManager } from '../memory/session.js';
import { resolveChannelFromSessionId } from '../session-channel.js';

let base: string;

async function setup() {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-restore-'));
  const cwd = path.join(base, 'proj');
  const sessionsRoot = path.join(base, 'sessions');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sessionsRoot, { recursive: true });
  return { cwd, sessionsRoot, sm: new SessionManager(cwd, sessionsRoot) };
}

afterEach(async () => {
  if (base) await fs.rm(base, { recursive: true, force: true });
});

/**
 * 造一个存量会话。
 * @param channel 省略 = 模拟「meta.json 缺 channel」的历史产物（2026-09-17 前由 UI 入口创建）
 */
async function makeSession(
  sm: SessionManager,
  id: string,
  createdAt: string,
  channel?: string,
): Promise<string> {
  const dir = sm.getSessionDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({ type: 'normal', createdAt, projectKey: '', ...(channel ? { channel } : {}) }),
    'utf-8',
  );
  return id;
}

describe('A. 本渠道的会话 → 恢复它（含 meta 缺 channel 的历史会话）', () => {
  it('meta.json 缺 channel 的 UI 存量会话，也能靠 ID 前缀认出并恢复', async () => {
    const { cwd, sm } = await setup();
    await makeSession(sm, 'webui_20260917-002244-9623', '2026-09-16T16:23:40.052Z');

    const result = await boot({ cwd, sessionId: undefined, shouldContinue: true, channel: 'webui', sessionManager: sm });

    expect(result.currentSessionId).toBe('webui_20260917-002244-9623');
  });

  it('meta.channel 已存在时按字段匹配（TUI 渠道的历史会话）', async () => {
    const { cwd, sm } = await setup();
    await makeSession(sm, 'tui_20260916-164132-04c4', '2026-09-16T08:41:53.760Z', 'tui');

    const result = await boot({ cwd, sessionId: undefined, shouldContinue: true, channel: 'tui', sessionManager: sm });

    expect(result.currentSessionId).toBe('tui_20260916-164132-04c4');
  });
});

describe('B. 不认领别渠道的会话（哪怕它是全局最新）', () => {
  it('微信会话是全局最新，但 UI 渠道只恢复自己的', async () => {
    const { cwd, sm } = await setup();
    await makeSession(sm, 'webui_20260917-002244-9623', '2026-09-16T16:23:40.052Z');
    // 更「新」的别渠道会话（微信）
    await makeSession(sm, 'clawbot_20260917-002414-0304', '2026-09-16T16:24:19.830Z', 'clawbot');

    const result = await boot({ cwd, sessionId: undefined, shouldContinue: true, channel: 'webui', sessionManager: sm });

    expect(result.currentSessionId).toBe('webui_20260917-002244-9623');
  });
});

describe('C. 渠道无存量会话 → 开本渠道新会话（fail-closed，且身份可反解）', () => {
  it('不落全局兜底，新会话带本渠道前缀且可反解出渠道', async () => {
    const { cwd, sm } = await setup();
    await makeSession(sm, 'clawbot_20260917-002414-0304', '2026-09-16T16:24:19.830Z', 'clawbot');

    const result = await boot({ cwd, sessionId: undefined, shouldContinue: true, channel: 'feishu', sessionManager: sm });

    expect(result.currentSessionId.startsWith('feishu_')).toBe(true);
    // boot 须登记本渠道前缀，否则新会话物化时 meta.channel 写不进去（下次重启又认不出自己）
    expect(resolveChannelFromSessionId(result.currentSessionId)).toBe('feishu');
  });
});
