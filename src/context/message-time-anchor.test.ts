/**
 * 入站消息的时间锚点（Message.timestamp）—— 契约锁定。
 *
 * 规则（用户裁定 2026-09-30）：
 *   1. 只有**入站（用户）消息落盘时**才按概率挂锚点；工具续跑轮次不挂
 *      —— 那些时间属于"此刻几点"，只该待在本轮 Zone 5。
 *   2. 概率与 beforeSection 的 timestamp 槽**共用同一套基准**（按真实间隔，不按轮次）。
 *   3. 锚点在**组装那一刻**转成前置文本块 `[sent at …]`，且字段被剥掉（绝不进请求体）。
 *   4. 陪伴模式不挂锚点（它本就不注入时间戳）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NormalRouter, CompanionRouter } from './router.js';
import type { IContextRouter } from './router.js';
import { withTimeAnchor } from './composer.js';
import type { SectionEntry } from './manifest-types.js';
import type { ResolverContext } from './section-resolver.js';
import type { Message } from '../types.js';

const TS_SECTION = {
  name: 'timestamp', source: 'runtime:timestamp', priority: 6, type: 'runtime',
} as SectionEntry;

function ctxAt(timestamp: string, sessionDir = '/sessions/a'): ResolverContext {
  return { timestamp, sessionDir } as unknown as ResolverContext;
}

describe('stampInboundMessage —— 入站消息按概率挂时间锚点', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首次（无基准）→ 间隔无限大 → 随机数接近 1 也必然命中', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const router = new NormalRouter();
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' }))
      .toBe('2026-09-30 00:47');
  });

  it('间隔 1 分钟：随机数高于 50% → 不挂；低于 50% → 挂', () => {
    const router = new NormalRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' }); // 建基准

    vi.spyOn(Math, 'random').mockReturnValue(0.9); // p = 0.5，0.9 ≥ 0.5 → 不挂
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:48' }))
      .toBeNull();

    vi.spyOn(Math, 'random').mockReturnValue(0.3); // 0.3 < 0.5 → 挂
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:48' }))
      .toBe('2026-09-30 00:48');
  });

  it('间隔 ≥5 分钟 → 必然命中', () => {
    const router = new NormalRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' });

    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:53' }))
      .toBe('2026-09-30 00:53');
  });

  it('未命中不推进基准：连续未命中把后续概率推向必然', () => {
    const router = new NormalRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' }); // 基准 = 00:47

    // 00:50 → 距基准 3 分钟 → p = 0.75；0.8 ≥ 0.75 → 不挂（基准保持 00:47）
    vi.spyOn(Math, 'random').mockReturnValue(0.8);
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:50' }))
      .toBeNull();

    // 00:52 → 仍距基准 5 分钟 → p = 1 → 必挂（若未命中错误地推进了基准，此处 gap=2min → p=0.625 → 0.999 会落空）
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:52' }))
      .toBe('2026-09-30 00:52');
  });

  it('与 beforeSection 共用基准：锚点命中后，紧随的 timestamp 槽看到间隔 ≈ 0', async () => {
    const router = new NormalRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' });

    // 若两者各记一份基准，此处 gap 会是 ∞ → p=1 → 0.6 会放行（返回 undefined）；
    // 共用基准时 gap=0 → p=0.5 → 0.6 ≥ 0.5 → 跳过（null）。
    vi.spyOn(Math, 'random').mockReturnValue(0.6);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-30 00:47'))).toBeNull();
  });

  it('按会话隔离：A 会话的锚点不影响 B 会话的首次判定', () => {
    const router = new NormalRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    router.stampInboundMessage({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' });

    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    // B 首次 → 间隔无限大 → p=1 → 必然命中（若状态共享则 gap=0 → p=0.5 → 0.9 会落空）
    expect(router.stampInboundMessage({ sessionDir: '/sessions/b', timestamp: '2026-09-30 00:47' }))
      .toBe('2026-09-30 00:47');
  });

  it('陪伴模式永不落锚点（未实现该钩子 → undefined；若实现了也须返回 null）', () => {
    const router: IContextRouter = new CompanionRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(
      router.stampInboundMessage?.({ sessionDir: '/sessions/a', timestamp: '2026-09-30 00:47' }) ?? null,
    ).toBeNull();
  });
});

describe('withTimeAnchor —— 组装期转文本、剥字段', () => {
  it('带锚点：前置文本块 + 原内容整体后移 + 字段消失', () => {
    const msg: Message = {
      role: 'user',
      content: { type: 'text', text: '在吗？' },
      timestamp: '2026-09-30 00:47',
    };
    const out = withTimeAnchor(msg);

    expect(out.timestamp).toBeUndefined();
    expect(out).not.toBe(msg);
    expect(out.role).toBe('user');
    expect(out.content).toEqual([
      { type: 'text', text: '[sent at 2026-09-30 00:47]' },
      { type: 'text', text: '在吗？' },
    ]);
  });

  it('多模态（数组内容）：块顺序不变，锚点在最前', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
        { type: 'text', text: '看这张' },
      ],
      timestamp: '2026-09-30 00:47',
    };
    const out = withTimeAnchor(msg);
    const blocks = out.content as Array<{ type: string; text?: string }>;

    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(blocks[0].text).toBe('[sent at 2026-09-30 00:47]');
    expect(blocks[2].text).toBe('看这张');
  });

  it('无锚点：原样返回（同一引用，不做无谓拷贝）', () => {
    const msg: Message = { role: 'user', content: { type: 'text', text: 'hi' } };
    expect(withTimeAnchor(msg)).toBe(msg);
  });

  it('不改写源对象 ⇒ 磁盘上的原文与字段都不受影响', () => {
    const msg: Message = {
      role: 'user',
      content: { type: 'text', text: '在吗？' },
      timestamp: '2026-09-30 00:47',
    };
    withTimeAnchor(msg);

    expect(msg.timestamp).toBe('2026-09-30 00:47'); // 字段还在（只是渲染副本上没有）
    expect(msg.content).toEqual({ type: 'text', text: '在吗？' }); // 正文一字未动
  });
});
