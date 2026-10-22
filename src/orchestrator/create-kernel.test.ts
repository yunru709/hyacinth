import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createKernel, DEFAULT_PIPELINE_SLOTS } from './create-kernel.js';
import { BUILTIN_STAGE_CONTRIBUTIONS, BUILTIN_STAGE_IDS } from './stage-registry.js';
import { createLoopHookBus } from '../orchestrator/loop-hooks.js';
import { checkContract } from '../kernel/pipeline.js';

describe('createKernel', () => {
  it('返回完整的内核三件套', () => {
    const k = createKernel();
    expect(k.loopHooks).toBeDefined();
    expect(k.pluginHost).toBeDefined();
    expect(k.pipeline).toBeDefined();
  });

  it('pipeline 已装配（assemble 完成后 describe 可用）', () => {
    const k = createKernel();
    const desc = k.pipeline.describe();
    expect(desc).toHaveLength(DEFAULT_PIPELINE_SLOTS.length);
    expect(desc.every((d) => d.enabled)).toBe(true);
  });

  it('pluginHost 可挂载插件', async () => {
    const k = createKernel();
    const disposer = await k.pluginHost.mount({
      id: 'test',
      activate(ctx) {
        ctx.register('test-svc' as never, { ok: true } as never);
      },
    });
    expect(k.pluginHost.get('test-svc')).toEqual({ ok: true });
    await disposer.dispose();
    expect(k.pluginHost.get('test-svc')).toBeUndefined();
  });

  it('接受外部注入的 loopHooks', () => {
    const bus = createLoopHookBus();
    const k = createKernel({ loopHooks: bus });
    expect(k.loopHooks).toBe(bus);
  });

  // ── P6-3 守卫：内置阶段贡献注册表 ────────────────────────────────

  it('守卫：阶段贡献 id 集 == 默认槽位 impl 集（注册表与槽位防漂移）', () => {
    const impls = DEFAULT_PIPELINE_SLOTS.map((s) => s.impl);
    expect(new Set(BUILTIN_STAGE_IDS)).toEqual(new Set(impls));
  });

  // ── 2026-10-22 启动崩溃回归：配置里的陈旧 requires 不得阻断启动 ──────────

  it('配置残留陈旧 requires 时以出厂值为准，装配不抛错（2026-10-22 启动崩溃回归）', () => {
    // 复现事故：config.json 里 context 槽位还写着已从代码里删掉的 'tools'。
    // 旧行为：assemble() fail-fast 抛 [missing-reads] ⇒ createKernel 抛 ⇒ 进程起不来。
    const staleSlots = DEFAULT_PIPELINE_SLOTS.map((s) =>
      s.id === 'context'
        ? { ...s, requires: { reads: ['history', 'userInput', 'tools'], writes: ['messages', 'zoneBreakdown'] } }
        : s,
    );
    const configCenter = {
      get: (k: string) => (k === 'kernel.pipeline' ? staleSlots : undefined),
    };

    let k: ReturnType<typeof createKernel> | undefined;
    expect(() => { k = createKernel({ configCenter: configCenter as never }); }).not.toThrow();
    expect(k?.pipeline.describe()).toHaveLength(DEFAULT_PIPELINE_SLOTS.length);
  });

  it('但真把不存在字段写进出厂 requires 时，校验仍会抓住（不削弱 fail-fast）', () => {
    // 上一条只是「配置被忽略」；这条锁住「出厂值本身拼错依然报错」——
    // 否则治漂移的修法会把 C-09 那类真实契约错误一起放过。
    const bogus = DEFAULT_PIPELINE_SLOTS.map((s) =>
      s.id === 'context'
        ? { ...s, requires: { reads: ['history', 'tools'], writes: ['messages', 'zoneBreakdown'] } }
        : s,
    );
    // 把 bogus 当槽位描述喂给同一个模块复检：模拟「出厂值本身写错」的场景
    const mod = BUILTIN_STAGE_CONTRIBUTIONS.find((c) => c.id === 'builtin:layered-composer')!.create();
    const issues = checkContract(
      { id: 'context', impl: 'builtin:layered-composer', requires: bogus.find((s) => s.id === 'context')!.requires },
      mod,
    );
    expect(issues.some((i) => i.kind === 'missing-reads')).toBe(true);
  });

  it('守卫：create-kernel 不再硬编码 create*Stage 数组（P6-3：新增阶段只改注册表）', () => {
    const src = fs.readFileSync(new URL('./create-kernel.ts', import.meta.url), 'utf-8');
    const stageCalls = ['Input', 'Bypass', 'Context', 'Llm', 'Tools', 'Finalize']
      .map((n) => `create${n}Stage(`)
      .filter((s) => src.includes(s));
    expect(stageCalls).toEqual([]); // 硬编码数组消失
    expect(src).toContain('BUILTIN_STAGE_CONTRIBUTIONS'); // 经注册表装配
  });

  it('守卫：注册表每项 id 与工厂产物 id 一致', () => {
    for (const c of BUILTIN_STAGE_CONTRIBUTIONS) {
      expect(c.create().id).toBe(c.id);
    }
  });

  it('配置里的 enabled 仍然生效（只校准 requires，不越权覆盖其它字段）', () => {
    const withDisabled = DEFAULT_PIPELINE_SLOTS.map((s) =>
      s.id === 'bypass' ? { ...s, enabled: false } : s,
    );
    const configCenter = {
      get: (key: string) => (key === 'kernel.pipeline' ? withDisabled : undefined),
    };
    const k = createKernel({ configCenter: configCenter as never });
    const desc = k.pipeline.describe() as Array<{ slot: string; enabled: boolean }>;
    const bypass = desc.find((d) => d.slot === 'bypass');
    if (bypass) expect(bypass.enabled).toBe(false);
    // 即便 describe() 不列 disabled 槽位，也绝不能把其它槽位一起关掉
    expect(desc.filter((d) => d.enabled).length).toBeGreaterThan(0);
  });
});
