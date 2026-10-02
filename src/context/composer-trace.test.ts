/**
 * composer 段级指纹（2026-10-02）—— 守住两条契约：
 *
 *   ① **稳定**：同一输入两次拼装 ⇒ 每段 hash 完全一致。这是"缓存有机会命中"的必要条件 ——
 *      若同一内容两轮算出不同 hash，说明有随机/时间因素混进了段内容，缓存必掉。
 *   ② **敏感**：段内容变了 ⇒ 该段 hash 变。这是"定位哪一段在变"的必要条件。
 *
 * 两条合起来，才使「哪一段在变」成为**可判定的事实**，而不是推理。
 *
 * ⚠️ 夹具照抄 context.test.ts：mock homedir ＋ 预写全局 manifest
 *（ManifestLoader 只读 ~/.agent/context-manifest.json，不读代码默认）。
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayeredContextComposer } from './composer.js';
import { DEFAULT_CONTEXT_MANIFEST } from './manifest-defaults.js';
import type { Message } from '../types.js';

const { mockHomedir, homeBox } = vi.hoisted(() => {
  const homeBox = { path: '' };
  return { homeBox, mockHomedir: vi.fn(() => homeBox.path) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});
homeBox.path = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-trace-home-'));
{
  fs.mkdirSync(path.join(homeBox.path, '.agent'), { recursive: true });
  fs.writeFileSync(
    path.join(homeBox.path, '.agent', 'context-manifest.json'),
    JSON.stringify(structuredClone(DEFAULT_CONTEXT_MANIFEST)),
  );
}

const makeComposer = () => new LayeredContextComposer(200000);

const opts = (history: Message[] = []) => ({
  sessionDir: '/tmp/composer-trace-test',
  maxContextTokens: 200000,
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
  tools: [],
  history,
  userInput: 'test',
});

describe('composer 段级指纹（sectionTraces）', () => {
  it('每段都有「名字 ＋ token ＋ hash」，且同一输入两次拼装 hash 完全一致（缓存的前提）', async () => {
    const a = await makeComposer().compose(opts());
    const b = await makeComposer().compose(opts());

    const tracesA = a.sectionTraces ?? [];
    expect(tracesA.length).toBeGreaterThan(0);
    for (const t of tracesA) {
      expect(t.name).toBeTruthy();
      expect(t.zone).toMatch(/^zone\d/);
      expect(t.hash).toMatch(/^[0-9a-f]{12}$/);
      expect(t.tokens).toBeGreaterThan(0);
    }

    // 稳定性：同样的输入 ⇒ 同样的指纹。若有差异，就是缓存掉落的直接原因。
    //
    // ⚠️ 唯一例外是 `timestamp` 段 —— 它按设计携带"此刻时间"，**必然每次都不同**（这就是它存在的意义）。
    // 它在 zone5 倒数第二位（其后只有 user_input）⇒ 破坏半径仅限自己。故本断言排除它；
    // 它"会变"与"不许往前挪"这两件事，由下面两条用例专门盯住。
    //（本用例第一次运行时正是靠这个差异，一眼指认出 timestamp 是活跃扰动源。）
    const stableOf = (traces: typeof tracesA) =>
      new Map(traces.filter((t) => t.name !== 'timestamp').map((t) => [t.name, t.hash]));
    expect(stableOf(b.sectionTraces ?? [])).toEqual(stableOf(tracesA));
  });

  it('timestamp 段每次不同（设计使然，不是 bug）', async () => {
    const a = await makeComposer().compose(opts());
    const b = await makeComposer().compose(opts());
    const ta = (a.sectionTraces ?? []).find((t) => t.name === 'timestamp');
    const tb = (b.sectionTraces ?? []).find((t) => t.name === 'timestamp');
    // 概率注入 ⇒ 两次都没出现也算正常；一旦同时出现，内容必须不同
    if (ta && tb) expect(ta.hash).not.toBe(tb.hash);
  });

  it('timestamp 之后只允许有 user_input（位置契约：往前挪一格就会毁掉后面整块缓存）', async () => {
    const r = await makeComposer().compose(opts());
    const list = r.sectionTraces ?? [];
    const idx = list.findIndex((t) => t.name === 'timestamp');
    if (idx >= 0) {
      const after = list.slice(idx + 1).map((t) => t.name);
      expect(after.every((n) => n === 'user_input')).toBe(true);
    }
  });

  it('history 段额外记录条数（用来发现"历史被重写／重排"）', async () => {
    const history: Message[] = [
      { role: 'user', content: { type: 'text', text: '第一条' } },
      { role: 'assistant', content: { type: 'text', text: '第二条' } },
    ];
    const r = await makeComposer().compose(opts(history));
    const h = (r.sectionTraces ?? []).find((t) => t.name === 'history');
    expect(h).toBeDefined();
    expect(h?.msgCount).toBe(2);
  });

  it('内容变化 ⇒ hash 变化（敏感性：定位能力的前提）', async () => {
    const one = await makeComposer().compose(
      opts([{ role: 'user', content: { type: 'text', text: 'A' } }]),
    );
    const two = await makeComposer().compose(
      opts([{ role: 'user', content: { type: 'text', text: 'B' } }]),
    );
    const h1 = (one.sectionTraces ?? []).find((t) => t.name === 'history')?.hash;
    const h2 = (two.sectionTraces ?? []).find((t) => t.name === 'history')?.hash;
    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h1).not.toBe(h2);
  });

  it('history 空 ⇒ 该段不产出指纹（不制造"空段在变"的假阳性）', async () => {
    const r = await makeComposer().compose(opts([]));
    const h = (r.sectionTraces ?? []).find((t) => t.name === 'history');
    expect(h).toBeUndefined();
  });
});
