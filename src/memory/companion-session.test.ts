// ============================================================
// CompanionSessionManager 单测 —— meta.type 自愈（2026-10-16）
// ============================================================
// 事故：柔柔/meta.json 是 2026-09-17 那个批次写的 {"type":"normal"}，
// 而 sessionModeOfDir 以 meta.type 为准 ⇒ 跨模式闸门**拒绝**把会话切进陪伴
// （「该会话属于「normal」模式，当前是「companion」模式」）⇒ 陪伴模式进不去。
// getOrCreate() 原先只在"目录不存在"时写 meta，已存在的目录原样返回 ⇒ 陈旧标注
// 永不自愈。修法：已存在也要校正 type，且**绝不触碰对话数据**。
// 下面锁四条：校正 / 保留其余字段 / 不动对话文件 / 已正确时不写盘。
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionSessionManager } from './companion-session.js';

// 固定夹具名（明显不是角色名；且无 persona.md ⇒ 不会进 listCharacters）
const FIXTURE = '__meta_selftest__';
const dir = path.join(os.homedir(), '.agent', 'companion', FIXTURE);
const metaPath = path.join(dir, 'meta.json');
const convPath = path.join(dir, 'conversation.jsonl');

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 新实例（绕开单例，避免测试间串状态） */
const mgr = () => {
  const m = new CompanionSessionManager();
  m.setCharacter(FIXTURE);
  return m;
};

describe('CompanionSessionManager.getOrCreate — meta.type 自愈', () => {
  it('旧 meta.type="normal" ⇒ 校正为 companion，且保留其余字段', () => {
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ type: 'normal', createdAt: '2026-09-17T14:01:46.189Z', projectKey: '' }),
      'utf-8',
    );

    const out = mgr().getOrCreate();
    expect(out).toBe(dir);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta.type).toBe('companion');
    // 其余字段必须原样保留（只改 type）
    expect(meta.createdAt).toBe('2026-09-17T14:01:46.189Z');
    expect(meta.projectKey).toBe('');
  });

  it('自愈**不动对话数据**（conversation.jsonl 逐字节不变）', () => {
    fs.writeFileSync(metaPath, JSON.stringify({ type: 'normal' }), 'utf-8');
    const payload = '{"role":"user","content":"别动我"}\n';
    fs.writeFileSync(convPath, payload, 'utf-8');

    mgr().getOrCreate();

    expect(fs.readFileSync(convPath, 'utf-8')).toBe(payload);
  });

  it('meta.json 缺失 ⇒ 补写 type=companion', () => {
    expect(fs.existsSync(metaPath)).toBe(false);

    mgr().getOrCreate();

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    expect(meta.type).toBe('companion');
    expect(typeof meta.createdAt).toBe('string');
  });

  it('meta.type 已正确 ⇒ **不写盘**（内容逐字节不变）', () => {
    const original = JSON.stringify({ type: 'companion', sentinel: 'untouched' });
    fs.writeFileSync(metaPath, original, 'utf-8');

    mgr().getOrCreate();

    expect(fs.readFileSync(metaPath, 'utf-8')).toBe(original);
  });
});
