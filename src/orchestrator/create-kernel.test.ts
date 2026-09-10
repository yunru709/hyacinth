import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createKernel, DEFAULT_PIPELINE_SLOTS } from './create-kernel.js';
import { BUILTIN_STAGE_CONTRIBUTIONS, BUILTIN_STAGE_IDS } from './stage-registry.js';
import { createLoopHookBus } from '../orchestrator/loop-hooks.js';

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
});
