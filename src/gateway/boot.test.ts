/**
 * boot() 会话恢复策略的回归守卫 —— 重点钉死 **fail-closed**。
 *
 * 背景（本测试要防的事故）：
 *   `shouldContinue` 分支旧写法是 `channelSession ?? await sessionManager.resume()`。
 *   当「本渠道没有存量会话」时它会回退到**全局最近**（`list()` 按 createdAt 降序取第一个），
 *   于是任何**无渠道归属**的会话都会被认领给本渠道 —— 实测事故：TUI / WebUI / 微信
 *   三方被认领进同一份对话历史（同一 conversation.jsonl）。
 *
 * 现在的不变式：
 *   ① 已声明渠道 + 本渠道有会话   → 恢复它
 *   ② 已声明渠道 + 本渠道无会话   → **开新会话**（绝不落全局兜底）
 *   ③ 未声明渠道（纯 CLI 交互）   → 才允许恢复全局最近
 *   ④ 显式指定 sessionId          → 尊重调用方（跨渠道加载由 switch_session 显式完成）
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SessionManager } from '../memory/session.js';
import { boot } from './boot.js';

/** 建一个隔离的临时环境（sessions 根 + cwd 各自独立） */
async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-test-'));
  const cwd = path.join(base, 'proj');
  const sessionsRoot = path.join(base, 'sessions');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sessionsRoot, { recursive: true });
  return { base, cwd, sessionsRoot, sm: new SessionManager(cwd, sessionsRoot) };
}

describe('boot() 恢复策略', () => {
  it('已声明渠道但本渠道无会话 → 开新会话，**绝不认领别渠道的会话**（fail-closed 回归守卫）', async () => {
    const { cwd, sessionsRoot, sm } = await setup();

    // 先造一个「别的渠道」的会话，并让它成为全局最新（createdAt 最大）
    const foreign = await sm.create('normal', 'webui');

    const result = await boot({
      cwd,
      sessionId: undefined,
      shouldContinue: true,
      channel: 'tui',
      sessionManager: sm,
    });

    // 关键断言：没有被认领
    expect(result.currentSessionId).not.toBe(foreign.id);
    // 而应是本渠道的新会话（带渠道前缀）
    expect(result.currentSessionId.startsWith('tui_')).toBe(true);
    // 新会话是惰性的，此时尚未落盘
    expect(result.sessionDir.startsWith(sessionsRoot)).toBe(true);
  });

  it('已声明渠道且本渠道有会话 → 恢复该渠道自己的（而不是全局最新）', async () => {
    const { cwd, sm } = await setup();

    const mine = await sm.create('normal', 'tui');
    // 再造一个更"新"的别渠道会话，确保全局最新不是 mine
    await sm.create('normal', 'webui');

    const result = await boot({
      cwd,
      sessionId: undefined,
      shouldContinue: true,
      channel: 'tui',
      sessionManager: sm,
    });

    expect(result.currentSessionId).toBe(mine.id);
  });

  it('未声明渠道（纯 CLI 交互）→ 允许恢复全局最近', async () => {
    const { cwd, sm } = await setup();

    await sm.create('normal', 'webui');
    const latest = await sm.create('normal', 'feishu');

    const result = await boot({
      cwd,
      sessionId: undefined,
      shouldContinue: true,
      channel: undefined,
      sessionManager: sm,
    });

    expect(result.currentSessionId).toBe(latest.id);
  });

  it('指定 sessionId 时优先恢复指定会话（不受渠道策略影响）', async () => {
    const { cwd, sm } = await setup();

    const foreign = await sm.create('normal', 'webui');

    const result = await boot({
      cwd,
      sessionId: foreign.id,
      shouldContinue: true,
      channel: 'tui',
      sessionManager: sm,
    });

    // 显式指定 ⇒ 尊重调用方（跨渠道加载由 switch_session 等显式动作负责）
    expect(result.currentSessionId).toBe(foreign.id);
  });

  it('lazySession + 显式 id ⇒ 只登记不落盘（刷新不留空壳会话的回归守卫 ✓）', async () => {
    const { cwd, sessionsRoot, sm } = await setup();
    const id = 'webui_20260920-120000-abcd';

    const result = await boot({
      cwd,
      sessionId: id,
      shouldContinue: false,
      channel: 'webui',
      sessionManager: sm,
      lazySession: true,
    });

    expect(result.currentSessionId).toBe(id);
    expect(result.sessionDir).toBe(sm.getSessionDir(id));
    // 关键判据：目录**不存在**（= 刷新不会留空壳）✓
    expect(existsSync(sm.getSessionDir(id))).toBe(false);
  });

  it('lazySession 但目录已存在 ⇒ 正常恢复（懒登记不降级既有会话 ✓）', async () => {
    const { cwd, sessionsRoot, sm } = await setup();
    const created = await sm.create('normal', 'webui');

    const result = await boot({
      cwd,
      sessionId: created.id,
      shouldContinue: false,
      channel: 'webui',
      sessionManager: sm,
      lazySession: true,
    });

    expect(result.currentSessionId).toBe(created.id);
    expect(existsSync(path.join(sessionsRoot, created.id, 'meta.json'))).toBe(true);
  });

  it('不带 lazySession ⇒ 显式 id 立即建档（默认语义零变更 ✓）', async () => {
    const { cwd, sessionsRoot, sm } = await setup();
    const id = 'webui_20260920-130000-beef';

    const result = await boot({ cwd, sessionId: id, shouldContinue: false, channel: 'webui', sessionManager: sm });

    expect(result.currentSessionId).toBe(id);
    expect(existsSync(path.join(sessionsRoot, id))).toBe(true);
  });
});
