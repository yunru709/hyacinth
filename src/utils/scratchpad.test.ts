/**
 * scratchpad.test.ts — 临时记事本（Zone 5）的注入契约
 *
 * 锁的六件事（都是"读文件 → 生成注入文本 / 维护第一行"这段纯逻辑）：
 *   ① 文件不存在 / 为空 ⇒ **返回空串**（不注入、不占位）
 *   ② 有内容 ⇒ 自带位置说明，且**路径是运行期推导的相对形式**（用户要求：**不要固定路径** ✓）
 *   ③ 超上限 ⇒ 截断并**显式标注**；上限非法 ⇒ 退回默认（不截成空）
 *   ④ 预置：不存在则创建，**第一行就是路径行**（运行期拼的，不是硬编码 ✓）
 *   ⑤ 幂等：已存在则**绝不覆盖**（agent 的笔记不能被吞）
 *   ⑥ `ensurePathLine`：只校正第一行（换机器/换用户名后自动跟上），**其余字节原样保留**，且正确时不写盘
 *
 * 为什么值得测：这段每次请求都会跑（Zone 5 每轮现读 ✓），失败模式又是**静默**的
 * （读失败一律返回空串 ⇒ 看起来一切正常、其实一直没注入 ✗）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensurePathLine,
  ensureScratchpadFile,
  homeRelative,
  readScratchpadForContext,
  scratchpadPath,
  scratchpadPathLine,
  scratchpadSeed,
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

describe('homeRelative（路径渲染：运行期推导，不硬编码）', () => {
  it('home 之下 ⇒ ~/ 形式；之外 ⇒ 原样返回（不假装）', () => {
    expect(homeRelative(path.join(fakeHome, '.agent', 'x.md'))).toBe('~/.agent/x.md');
    const outside = process.platform === 'win32' ? 'C:\\Windows\\Temp\\x.md' : '/tmp/x.md';
    if (!path.resolve(outside).startsWith(path.resolve(fakeHome))) {
      expect(homeRelative(outside)).toBe(path.resolve(outside));
    }
  });
});

describe('scratchpad（Zone 5 临时记事本）', () => {
  it('① 文件不存在 / 只有空白 ⇒ 空串（不注入、不占位）', () => {
    reset();
    expect(readScratchpadForContext()).toBe('');
    fs.writeFileSync(scratchpadPath(), '   \n\n\t\n', 'utf-8');
    expect(readScratchpadForContext()).toBe('');
  });

  it('② 有内容 ⇒ 自带位置说明，且**不含固定的绝对路径**（用户要求）', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), '- 待办：验证 Zone 5 位置\n', 'utf-8');
    const text = readScratchpadForContext();
    expect(text).toContain('# scratchpad');
    expect(text).toContain('待办：验证 Zone 5 位置');
    // 位置用运行期推导的 ~/… 形式
    expect(text).toContain(homeRelative(scratchpadPath()));
    // ★ 用户要求：不要固定的绝对路径 —— 这条守卫就是它
    expect(text, '注入文本里出现了写死的绝对路径').not.toContain(path.resolve(scratchpadPath()));
  });

  it('③ 超上限 ⇒ 截断并显式标注；上限非法 ⇒ 退回默认', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), 'x'.repeat(500), 'utf-8');
    const text = readScratchpadForContext(100);
    expect(text).toContain('已截断');
    expect(text).toContain('全文 500 字符');
    expect(text).toContain('上限 100');

    fs.writeFileSync(scratchpadPath(), 'y'.repeat(200), 'utf-8');
    expect(readScratchpadForContext(0)).toContain('y'.repeat(200));
    expect(readScratchpadForContext(Number.NaN)).toContain('y'.repeat(200));
  });

  it('④ 预置：第一行就是**运行期拼出的路径行**（不是硬编码的固定路径）', () => {
    reset();
    expect(ensureScratchpadFile(), '首次应创建').toBe(true);
    const lines = fs.readFileSync(scratchpadPath(), 'utf-8').split('\n');
    expect(lines[0]).toBe(scratchpadPathLine());
    expect(lines[0]).toContain(homeRelative(scratchpadPath()));
    expect(lines[0]).not.toContain(path.resolve(scratchpadPath()));
    // 预置必须写明**用途**（2026-09-19 用户定）：先记这儿 → 写时整理 → 快满时精炼成记忆 ✓
    // （原断言是字面量 'memory.md' —— 旧措辞的偶然细节 ✗，一改文案就撞死，换成钉住用途 ✓）
    const seedText = fs.readFileSync(scratchpadPath(), 'utf-8');
    expect(seedText, '要写明「新东西先记这儿」').toContain('先记这儿');
    expect(seedText, '要写明「快满时精炼为记忆」').toContain('精炼');
    expect(seedText, '要说明它比 memory 更临时').toContain('memory');
  });

  it('⑤ 幂等：已存在时**绝不覆盖**（agent 写的笔记不能被吞）', () => {
    reset();
    fs.writeFileSync(scratchpadPath(), '我的笔记，别动\n', 'utf-8');
    expect(ensureScratchpadFile(), '已存在 ⇒ 应返回 false').toBe(false);
    expect(fs.readFileSync(scratchpadPath(), 'utf-8')).toBe('我的笔记，别动\n');
  });

  it('⑥ ensurePathLine：修正第一行，**其余原样**；已正确则不写盘', () => {
    reset();
    // 模拟"换了机器/用户名"⇒ 第一行是旧的
    fs.writeFileSync(
      scratchpadPath(),
      '# 临时记事本（Zone 5）· ~/old-machine/x.md\n第二行是我的笔记\n第三行\n',
      'utf-8',
    );
    expect(ensurePathLine(), '第一行不符 ⇒ 应改动').toBe(true);
    const after = fs.readFileSync(scratchpadPath(), 'utf-8').split('\n');
    expect(after[0]).toBe(scratchpadPathLine());
    expect(after[1], '笔记内容必须原样保留').toBe('第二行是我的笔记');
    expect(after[2]).toBe('第三行');

    const mtimeBefore = fs.statSync(scratchpadPath()).mtimeMs;
    expect(ensurePathLine(), '已正确 ⇒ 不应再写').toBe(false);
    expect(fs.statSync(scratchpadPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('⑥ ensurePathLine：文件不存在 ⇒ 返回 false（不抛）', () => {
    reset();
    expect(ensurePathLine()).toBe(false);
    expect(scratchpadSeed()).toContain(scratchpadPathLine());
  });
});
