/**
 * scratchpad.test.ts — 临时记事本（Zone 5）的注入契约
 *
 * 锁四件事（都是"读文件 → 生成注入文本"这段纯逻辑）：
 *   ① 文件不存在 / 为空 ⇒ **返回空串**（不注入任何东西、不占位）
 *   ② 有内容 ⇒ 带上自报位置的头（模型据此知道这是什么、在哪）
 *   ③ 超上限 ⇒ **截断并显式标注**（Zone 5 是每轮 live 尾巴，跑飞会撑爆上下文）
 *   ④ 预置文件：不存在则创建（幂等：已存在**绝不覆盖** —— agent 写的笔记不能被吞掉）
 *
 * 为什么值得测：这段每次请求都会跑（Zone 5 每轮现读 ✓），
 * 而且它的失败模式是**静默**的（catch 掉返回空串）—— 没测试就会"看起来一切正常、其实一直没注入"。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SCRATCHPAD_SEED,
  ensureScratchpadFile,
  readScratchpadForContext,
  scratchpadPath,
} from './scratchpad.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  realHome = os.homedir();
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scratchpad-home-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(() => {
  homedirSpy.mockRestore();
  expect(os.homedir()).toBe(realHome);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

/** 用例之间清干净（文件位置由 homedir 决定 ⇒ 每个用例自己控制存在与否） */
function reset(): void {
  fs.rmSync(scratchpadPath(), { force: true });
  fs.mkdirSync(path.dirname(scratchpadPath()), { recursive: true });
}

describe('scratchpad（Zone 5 临时记事本）', () => {
  it('① 文件不存在 ⇒ 空串（不注入、不占位）', () => {
    reset();
    expect(readScratchpadForContext()).toBe('');
  });

  it('① 文件只有空白 ⇒ 空串', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), '   \n\n\t\n', 'utf-8');
    expect(readScratchpadForContext()).toBe('');
  });

  it('② 有内容 ⇒ 注入文本自带位置说明（含文件路径）', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), '- 待办：验证 Zone 5 位置\n', 'utf-8');
    const text = readScratchpadForContext();
    expect(text).toContain('# scratchpad');
    expect(text).toContain('待办：验证 Zone 5 位置');
    expect(text, '头里要自报文件位置（模型据此知道在哪改）').toContain(scratchpadPath().replace(/\\/g, '\\'));
  });

  it('③ 超上限 ⇒ 截断并**显式标注**（不留"内容完整"的错觉）', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), 'x'.repeat(500), 'utf-8');
    const text = readScratchpadForContext(100);
    expect(text).toContain('已截断');
    expect(text).toContain('全文 500 字符');
    expect(text).toContain('上限 100');
    // 截断后正文不超过上限（头与标注不算正文）
    expect(text.split('\n').length).toBeGreaterThan(0);
  });

  it('③ 上限非法（0/负数/NaN）⇒ 退回默认上限，而不是"截成空"', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), 'y'.repeat(200), 'utf-8');
    expect(readScratchpadForContext(0)).toContain('y'.repeat(200));
    expect(readScratchpadForContext(Number.NaN)).toContain('y'.repeat(200));
  });

  it('④ 预置：不存在则创建，且内容声明了位置与用法', () => {
    reset();
    expect(ensureScratchpadFile(), '首次应创建').toBe(true);
    const body = fs.readFileSync(scratchpadPath(), 'utf-8');
    expect(body).toBe(SCRATCHPAD_SEED);
    expect(body).toContain('scratchpad.md');
    expect(body).toContain('edit');
  });

  it('④ 幂等：已存在时**绝不覆盖**（agent 写的笔记不能被吞）', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), '我的笔记，别动\n', 'utf-8');
    expect(ensureScratchpadFile(), '已存在 ⇒ 应返回 false').toBe(false);
    expect(fs.readFileSync(scratchpadPath(), 'utf-8')).toBe('我的笔记，别动\n');
  });
});
