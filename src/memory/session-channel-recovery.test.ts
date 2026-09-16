/**
 * `getLatestByChannel()` 的前缀兜底 —— 回归守卫。
 *
 * 背景（2026-09-17 事故）：`channel` 是后加到 meta.json 的字段。此前 UI 入口
 * （ui-protocol-session / http-webhook）传 channel:'webui' 却不登记前缀，物化时
 * 前缀反解不出渠道 → meta.json **没有** channel 字段 → 只按 meta.channel 匹配的
 * `getLatestByChannel()` 恒为 null → boot 每次重启都 fail-closed 开新会话。
 * 于是「各在线渠道恢复各自上一个 session」这条需求不成立，且新会话正好接住了
 * 别渠道的重启续工指令（跨渠道串台）。
 *
 * 本测试钉死判据：meta.channel 精确匹配 → ID 前缀反解（注册表）→ ID 前缀字面量。
 * 三者任一命中即算本渠道，且取**最近**的一条；都不命中返回 null（fail-closed 不越界）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from './session.js';
import { registerChannelPrefixes } from '../session-channel.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-ch-recovery-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** 造存量会话；channel 省略 = 模拟「meta.json 缺 channel」的历史产物 */
function makeSession(id: string, createdAt: string, channel?: string): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ type: 'normal', createdAt, projectKey: '', ...(channel ? { channel } : {}) }),
    'utf-8',
  );
}

describe('getLatestByChannel：meta 缺 channel 时按 ID 前缀兜底', () => {
  it('meta.json 没有 channel 字段，也能按前缀认回本渠道会话', async () => {
    makeSession('webui_20260917-002244-9623', '2026-09-16T16:23:40.052Z');
    const sm = new SessionManager(process.cwd(), root);

    expect((await sm.getLatestByChannel('webui'))?.id).toBe('webui_20260917-002244-9623');
  });

  it('一渠道多前缀（webui_ / ui_）经注册表也能认回', async () => {
    registerChannelPrefixes(['webui_', 'ui_'], 'webui');
    makeSession('ui_20260915-010101-aaaa', '2026-09-15T01:01:01.000Z');
    const sm = new SessionManager(process.cwd(), root);

    expect((await sm.getLatestByChannel('webui'))?.id).toBe('ui_20260915-010101-aaaa');
  });

  it('meta.channel 有值 → 按字段命中（前缀判据不掩盖字段判据）', async () => {
    makeSession('webui_20260916-120000-bbbb', '2026-09-16T12:00:00.000Z', 'webui');
    const sm = new SessionManager(process.cwd(), root);

    expect((await sm.getLatestByChannel('webui'))?.id).toBe('webui_20260916-120000-bbbb');
  });

  // 注：不断言「多条候选时取最近」—— list() 的排序键是**目录 birthtime**（见 session.ts:277，
  // 它并未使用 meta.createdAt），同毫秒内创建的目录顺序会退回 readdir 的字母序，不可靠。
  // 生产环境中各会话由不同次重启创建，时间差足够大，顺序稳定；此处只钉判据本身。

  it('前缀与字段都不匹配 → null（保持 fail-closed，不越界认领别渠道）', async () => {
    makeSession('clawbot_20260917-002414-0304', '2026-09-16T16:24:19.830Z', 'clawbot');
    const sm = new SessionManager(process.cwd(), root);

    expect(await sm.getLatestByChannel('tui')).toBeNull();
  });
});
