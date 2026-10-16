// ============================================================
// companion-scene-watch 单测
// ============================================================
// 背景（2026-10-16）：把 WebUI 的"陪伴场景 15s 轮询"换成事件推送，
// 由本监视器把 scene_render 的落盘动作转成协议事件。
// 这里锁三条契约：
//   1. scene.json 落盘 → 回调带角色名
//   2. 非 scene.json（如 scene.png）不触发（一次渲染只推一次）
//   3. 根目录不存在 → 返回 inactive 句柄且不抛（降级不炸会话）
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchCompanionScenes } from './companion-scene-watch.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-watch-'));
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 等待条件成立（轮询式，避免依赖 fs.watch 的时序） */
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('watchCompanionScenes', () => {
  it('scene.json 落盘 → 回调收到角色名', async () => {
    const root = path.join(tmpRoot, 'case1');
    fs.mkdirSync(path.join(root, '柔柔'), { recursive: true });

    const seen: string[] = [];
    const h = watchCompanionScenes({ root, onChange: (c) => seen.push(c), debounceMs: 30 });
    expect(h.active).toBe(true);

    try {
      fs.writeFileSync(
        path.join(root, '柔柔', 'scene.json'),
        JSON.stringify({ signature: 'abc', prompt: '雨夜' }),
        'utf8',
      );
      const ok = await waitFor(() => seen.length > 0);
      expect(ok).toBe(true);
      expect(seen).toContain('柔柔');
    } finally {
      h.close();
    }
  });

  it('只认 scene.json：scene.png 落盘不触发（一次渲染不连推两下）', async () => {
    const root = path.join(tmpRoot, 'case2');
    fs.mkdirSync(path.join(root, '小蝶'), { recursive: true });

    const seen: string[] = [];
    const h = watchCompanionScenes({ root, onChange: (c) => seen.push(c), debounceMs: 30 });

    try {
      fs.writeFileSync(path.join(root, '小蝶', 'scene.png'), 'not-a-real-png', 'utf8');
      // 给足时间：若误触发，这里必然已经收到
      await new Promise((r) => setTimeout(r, 600));
      expect(seen).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('根目录不存在 → inactive 句柄、不抛异常（降级不炸会话）', () => {
    const missing = path.join(tmpRoot, 'definitely-not-exists', 'nested');
    expect(() => {
      const h = watchCompanionScenes({ root: missing, onChange: () => { /* 不该被调用 */ } });
      expect(h.active).toBe(false);
      expect(() => h.close()).not.toThrow();   // 空句柄 close 必须安全
    }).not.toThrow();
  });

  it('close 之后不再回调（句柄释放）', async () => {
    const root = path.join(tmpRoot, 'case4');
    fs.mkdirSync(path.join(root, '阿狸'), { recursive: true });

    const seen: string[] = [];
    const h = watchCompanionScenes({ root, onChange: (c) => seen.push(c), debounceMs: 30 });
    h.close();

    fs.writeFileSync(path.join(root, '阿狸', 'scene.json'), '{}', 'utf8');
    await new Promise((r) => setTimeout(r, 500));
    expect(seen).toEqual([]);
  });
});
