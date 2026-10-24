// ============================================================
// UI 契约层 — 模式域测试
// ============================================================
// 守三件事：
//  1. mode.get 的字段是 UI 直接渲染的契约（profile / unrestricted / goal）
//  2. setProfile 的**非法值必须报错**，不能静默回退默认档 —— 否则 UI 会以为切成功了
//     （用户以为开了"完全访问"，实际还在确认档，这是最坏的一类静默失败）
//  3. goal 的用户输入错误（空目标 / 已在 goal 中）走 `{ok:false,error}` 分支，
//     而不是协议错误 —— UI 要把原文案贴在菜单里
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createModeDomain, type ModeLoopLike } from './mode.js';
import type { UiResponse } from '../types.js';
import { PERMISSION_PROFILES, type PermissionProfile } from '../../orchestrator/permission-profile.js';

function makeLoop(over: Partial<ModeLoopLike> = {}): ModeLoopLike & { calls: string[] } {
  const calls: string[] = [];
  let profile: PermissionProfile = 'confirm';
  let goal: ReturnType<NonNullable<ModeLoopLike['getGoalState']>> = null;
  const loop = {
    calls,
    getPermissionProfile: () => profile,
    setPermissionProfile: (p: PermissionProfile) => { calls.push(`setProfile:${p}`); profile = p; return p; },
    getGoalState: () => goal,
    enterGoal: (objective: string) => {
      calls.push(`enterGoal:${objective}`);
      if (!objective.trim()) return { ok: false as const, error: 'objective（目标）不能为空。' };
      goal = {
        active: true, objective, enteredBy: 'user' as const,
        enteredAt: '2026-10-24T00:00:00.000Z', reviewAttempts: 0, nudges: 0,
      };
      return { ok: true as const, note: '已进入 goal 模式。' };
    },
    exitGoal: (reason: string) => { calls.push(`exitGoal:${reason}`); goal = null; return true; },
    ...over,
  };
  return loop as ModeLoopLike & { calls: string[] };
}

function setup(loop: ModeLoopLike | null) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('mode', createModeDomain({ getLoop: () => loop }));
  server.attach(serverAdp);
  const responses: UiResponse[] = [];
  client.onMessage((m) => { if (m.kind === 'response') responses.push(m); });
  const wait = async (id: string, timeout = 3000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  const request = async (method: string, params?: unknown): Promise<UiResponse> => {
    const id = 'r' + Math.random().toString(36).slice(2);
    client.send({ kind: 'request', id, method, params } as never);
    return wait(id);
  };
  return { request };
}

describe('mode 域', () => {
  it('mode.get 返回档位 + unrestricted 派生值 + goal=null', async () => {
    const { request } = setup(makeLoop());
    const r = await request('mode.get');
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ profile: 'confirm', unrestricted: false, goal: null });
  });

  it('mode.setProfile 落到 loop 并返回新快照（full ⇒ unrestricted）', async () => {
    const loop = makeLoop();
    const { request } = setup(loop);
    const r = await request('mode.setProfile', { profile: 'full' });
    expect(r.ok).toBe(true);
    expect((r.result as any).profile).toBe('full');
    expect((r.result as any).unrestricted).toBe(true);
    expect(loop.calls).toContain('setProfile:full');
  });

  it('mode.setProfile 非法档位 → 协议错误（不静默回默认）', async () => {
    const loop = makeLoop();
    const { request } = setup(loop);
    const r = await request('mode.setProfile', { profile: 'yolo' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/profile/);
    expect(loop.calls).toEqual([]); // 一次也没落到 loop
  });

  it('mode.enterGoal 空目标 → ok:false + 文案（不是协议错误）', async () => {
    const { request } = setup(makeLoop());
    const r = await request('mode.enterGoal', { objective: '   ' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ ok: false });
    expect(String((r.result as any).error)).toContain('不能为空');
  });

  it('mode.enterGoal 成功后 mode.get 能读到 goal 快照', async () => {
    const { request } = setup(makeLoop());
    const r = await request('mode.enterGoal', { objective: '把构建修绿' });
    expect(r.result).toMatchObject({ ok: true });
    const snap = await request('mode.get');
    expect((snap.result as any).goal).toMatchObject({ active: true, objective: '把构建修绿' });
  });

  it('mode.exitGoal 调用 loop.exitGoal 并清掉快照', async () => {
    const loop = makeLoop();
    const { request } = setup(loop);
    await request('mode.enterGoal', { objective: 'x' });
    const r = await request('mode.exitGoal', {});
    expect(r.result).toMatchObject({ ok: true, reason: '用户手动解除' });
    const snap = await request('mode.get');
    expect((snap.result as any).goal).toBeNull();
    expect(loop.calls.some((c) => c.startsWith('exitGoal:'))).toBe(true);
  });

  it('WebUI 模式菜单的档位与顺序与后端一致（UI 契约守卫）', () => {
    // 前端是纯 JS、不进 tsc；顺序和 id 若与后端漂移，菜单会显示一个设不了的档位，
    // 或者把"最危险"的那个排到最上面。这里直接扫源码守住这份契约。
    //
    // ⚠️ 这是**有意的跨层耦合**：协议域的测试读前端文件，属少见做法。理由是
    // 这份"顺序"只在两处出现、又是界面正确性的硬前提；靠人肉同步迟早漂。
    // 代价要认清：前端一旦拆分/改名（MODE_DEFS 移出 app.js），这条会**假红**——
    // 那时把它挪到对应的新文件即可，**不要删**。
    const src = readFileSync(path.resolve(process.cwd(), 'src/webui/app.js'), 'utf-8');
    // 只扫 MODE_DEFS 那一段：文件里还有别的同格式数组（思考档位 EFFORT_DEFS），
    // 全文匹配会把它们一起算进来（实测过一次，多出 off/minimal/… 直接红）
    const start = src.indexOf('const MODE_DEFS');
    const block = src.slice(start, src.indexOf('];', start));
    const ids = [...block.matchAll(/\{ id: '([a-z]+)', label: '/g)].map((m) => m[1]);
    expect(ids).toEqual([...PERMISSION_PROFILES]);
  });

  it('loop 未就绪 → 明确报错（而不是返回一份假默认值）', async () => {
    const { request } = setup(null);
    const r = await request('mode.get');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/not ready/);
  });
});
