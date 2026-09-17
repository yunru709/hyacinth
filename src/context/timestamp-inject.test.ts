/**
 * 时间戳概率注入测试（仅普通模式）。
 *
 * 规则：概率由「距上次实际注入的间隔」决定 ——
 *   Δ ≤ 1 分钟 → 50%；Δ ≥ 5 分钟 → 100%；中间线性平滑。
 *   未命中不推进基准（累积抬高后续概率）；按会话隔离；陪伴模式一律不注入。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NormalRouter, CompanionRouter, timestampInjectProbability } from './router.js';
import type { ResolverContext } from './section-resolver.js';
import type { SectionEntry } from './manifest-types.js';

const TS_SECTION = {
  name: 'timestamp', source: 'runtime:timestamp', priority: 6, type: 'runtime',
} as SectionEntry;

const OTHER_SECTION = {
  name: 'memory', source: 'runtime:memory', priority: 25, type: 'runtime',
} as SectionEntry;

function ctxAt(timestamp: string, sessionDir = '/sessions/a'): ResolverContext {
  return { timestamp, sessionDir } as unknown as ResolverContext;
}

describe('timestampInjectProbability', () => {
  it('1 分钟以内 → 50%', () => {
    expect(timestampInjectProbability(0)).toBe(0.5);
    expect(timestampInjectProbability(30_000)).toBe(0.5);
    expect(timestampInjectProbability(60_000)).toBe(0.5);
  });

  it('5 分钟及以上 → 100%', () => {
    expect(timestampInjectProbability(5 * 60_000)).toBe(1);
    expect(timestampInjectProbability(60 * 60_000)).toBe(1);
  });

  it('1~5 分钟之间线性平滑', () => {
    expect(timestampInjectProbability(2 * 60_000)).toBeCloseTo(0.625, 6);
    expect(timestampInjectProbability(3 * 60_000)).toBeCloseTo(0.75, 6);
    expect(timestampInjectProbability(4 * 60_000)).toBeCloseTo(0.875, 6);
  });

  it('单调不减', () => {
    let prev = -1;
    for (let gap = 0; gap <= 10 * 60_000; gap += 15_000) {
      const p = timestampInjectProbability(gap);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('NormalRouter 时间戳注入', () => {
  let router: NormalRouter;

  beforeEach(() => {
    router = new NormalRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('非 timestamp section 不受影响（返回 undefined 继续正常解析）', async () => {
    expect(await router.beforeSection(OTHER_SECTION, ctxAt('2026-09-17 21:45'))).toBeUndefined();
  });

  it('首次（无记录）视为间隔无限大 → 必然注入', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // p=1 → 0 < 1 成立
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45'))).toBeUndefined();
  });

  it('间隔 1 分钟、随机数高于 50% → 跳过', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45')); // 建立基准
    vi.spyOn(Math, 'random').mockReturnValue(0.9);                     // p=0.5，0.9 ≥ 0.5
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:46'))).toBeNull();
  });

  it('间隔 1 分钟、随机数低于 50% → 注入', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45')); // 建立基准
    vi.spyOn(Math, 'random').mockReturnValue(0.3);                     // 0.3 < 0.5
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:46'))).toBeUndefined();
  });

  it('间隔 ≥5 分钟 → 必然注入（随机数接近 1 也注入）', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45')); // 建立基准
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:50'))).toBeUndefined();
  });

  it('未命中不推进基准：连续未命中把后续概率推向 100%', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45')); // 基准 = 21:45
    // 21:48 → 距基准 3 分钟 → p = 0.75；随机 0.8 ≥ 0.75 → 跳过（基准保持 21:45）
    vi.spyOn(Math, 'random').mockReturnValue(0.8);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:48'))).toBeNull();
    // 21:50 → 仍距基准 5 分钟 → p = 1 → 必注入。
    // （若错误地在未命中时推进基准，此处 gap 会是 2 分钟 → p = 0.625 → 0.999 会跳过）
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:50'))).toBeUndefined();
  });

  it('按会话隔离：A 会话的注入不影响 B 会话的首次判定', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45', '/sessions/a'));
    // B 会话首次 → 间隔无限大 → p=1 → 注入；若状态共享则 gap=0 → p=0.5 → 0.9 会跳过
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45', '/sessions/b'))).toBeUndefined();
  });
});

describe('CompanionRouter 时间戳注入', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('陪伴模式一律不注入时间戳（随机数为 0 也不注入）', async () => {
    const router = new CompanionRouter();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45'))).toBeNull();
    expect(router.roleForSection('timestamp')).toBeUndefined();
  });

  it('世界引擎启用：槽位仍不注入时间戳，但 role 交给旁白（assistant）', async () => {
    const router = new CompanionRouter();
    (router as unknown as { worldEngineAgent: { enabled: boolean } }).worldEngineAgent = { enabled: true };
    expect(await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45'))).toBeNull();
    expect(router.roleForSection('timestamp')).toBe('assistant');
  });

  it('世界引擎关闭后 role 不再被覆写', async () => {
    const router = new CompanionRouter();
    (router as unknown as { worldEngineAgent: { enabled: boolean } }).worldEngineAgent = { enabled: true };
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:45'));
    (router as unknown as { worldEngineAgent: { enabled: boolean } }).worldEngineAgent = { enabled: false };
    await router.beforeSection(TS_SECTION, ctxAt('2026-09-17 21:46'));
    expect(router.roleForSection('timestamp')).toBeUndefined();
  });
});
