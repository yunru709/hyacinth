/**
 * 惰性会话（P 惰性启动）单测：createLazy 零副作用 + materializeLazySession 幂等。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, materializeLazySession } from './session.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-session-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionManager.createLazy（零副作用）', () => {
  it('只生成 id + Session 对象，不创建目录、不写任何文件', () => {
    const sm = new SessionManager(process.cwd(), root);
    const session = sm.createLazy('tui');

    expect(session.id).toMatch(/^tui_/);
    expect(session.type).toBe('normal');
    // 目录不存在（零残留）
    expect(fs.existsSync(sm.getSessionDir(session.id))).toBe(false);
    // sessions 根目录下没有任何新增目录
    expect(fs.readdirSync(root).length).toBe(0);
  });

  it('无渠道时 id 无前缀', () => {
    const sm = new SessionManager(process.cwd(), root);
    const session = sm.createLazy();
    expect(session.id).not.toMatch(/^[a-z]+_/);
  });
});

describe('materializeLazySession（幂等物化）', () => {
  it('补写 meta.json + session_start 事件 + stats.json（不建 conversation，首写才建）', async () => {
    const sm = new SessionManager(process.cwd(), root);
    const session = sm.createLazy('tui');
    const dir = sm.getSessionDir(session.id);

    await materializeLazySession(dir, session);

    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
    expect(meta.type).toBe('normal');
    expect(meta.channel).toBe('tui');
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stats.json'))).toBe(true);
    // conversation.jsonl 不预建（首条消息 append 时由 ConversationStore 自动创建）
    expect(fs.existsSync(path.join(dir, 'conversation.jsonl'))).toBe(false);
  });

  it('幂等：二次调用不重复写（meta 内容不变、事件不追加）', async () => {
    const sm = new SessionManager(process.cwd(), root);
    const session = sm.createLazy();
    const dir = sm.getSessionDir(session.id);

    await materializeLazySession(dir, session);
    const metaAfterFirst = fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8');
    const eventsAfterFirst = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8');

    await materializeLazySession(dir, session);
    expect(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')).toBe(metaAfterFirst);
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8')).toBe(eventsAfterFirst);
  });
});

describe('SessionManager.create（回归：仍完整物化）', () => {
  it('create 走 createLazy + materialize，产出完整 session 目录', async () => {
    const sm = new SessionManager(process.cwd(), root);
    const session = await sm.create('normal', 'tui');
    const dir = sm.getSessionDir(session.id);

    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stats.json'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
    expect(meta.channel).toBe('tui');
  });
});
