/**
 * hook-bus.test.ts — 失败隔离语义的守卫（Phase 6 第 2 步 · 守卫①）
 *
 * 锁的语义（源码真源 hook-bus.ts:145-181）：
 *   · **观察者**抛错 → 吞掉并上报，然后**继续**跑后续观察者与 core（不影响被挂载的操作）；
 *   · **拦截器**抛错 → 吞掉并上报，**视为未拦截**，继续走内层（保证主循环不被卡死）。
 *   · 无任何挂载者 → 快路径直通 core（插件未挂载 = 零开销）。
 *
 * API 真源（不再靠猜）：`on(name, handler, owner?)` / `intercept(name, handler, owner?)` /
 * `run(name, payload, core?)` —— **core 是 run 的第三个参数**（由调用方传入，不是注册式）；
 * `emit(name, payload)` 等价于不带 core 的 run。
 *
 * 为什么需要它：这是「工具联动三律」第 3 条（订阅者失败不得影响宿主）的机器化证据。
 * 此前只有实现、没有测试 —— 改一行 try/catch 就可能悄悄变成"订阅者一炸、全链皆挂"，
 * 而那种退化在单插件、无异常的场景里**完全看不出来**。
 */
import { describe, expect, it } from 'vitest';
import { HookBus } from './hook-bus.js';

interface TestHooks extends Record<string, unknown> {
  ping: { n: number };
}

describe('HookBus 失败隔离', () => {
  it('观察者抛错：吞掉 + 继续后续观察者 + core 照常执行（工具结果不受影响）', async () => {
    const bus = new HookBus<TestHooks>({ name: 'test' });
    const seen: string[] = [];

    bus.on('ping', () => {
      seen.push('炸的观察者');
      throw new Error('订阅者炸了');
    });
    bus.on('ping', (p) => {
      seen.push('后面的观察者');
      return { n: p.n + 1 };
    });

    const out = await bus.run('ping', { n: 1 }, async (p) => {
      seen.push('core');
      return p;
    });

    // 关键：炸掉的那个不影响别人 —— 三个都跑到了
    expect(seen).toEqual(['炸的观察者', '后面的观察者', 'core']);
    // 且后续观察者改写 payload 仍然生效（观察者按 FIFO 串行、可返回替换值）
    expect(out).toEqual({ n: 2 });
  });

  it('拦截器抛错：吞掉 + 视为未拦截，继续走内层（不卡死主循环）', async () => {
    const bus = new HookBus<TestHooks>({ name: 'test' });
    const seen: string[] = [];

    bus.intercept('ping', async () => {
      seen.push('炸的拦截器');
      throw new Error('拦截器炸了');
    });
    bus.intercept('ping', async (p, next) => {
      seen.push('内层拦截器');
      return next({ n: p.n + 10 });
    });

    const out = await bus.run('ping', { n: 1 }, async (p) => {
      seen.push('core');
      return p;
    });

    expect(seen).toEqual(['炸的拦截器', '内层拦截器', 'core']);
    expect(out).toEqual({ n: 11 }); // 内层与 core 照常，炸的那个等于没拦
  });

  it('无挂载者 → 快路径直通 core（插件未挂载 = 零开销）', async () => {
    const bus = new HookBus<TestHooks>({ name: 'test' });
    expect(bus.has('ping')).toBe(false);
    expect(bus.observerCount('ping')).toBe(0);
    expect(await bus.run('ping', { n: 1 }, async (p) => ({ n: p.n + 100 }))).toEqual({ n: 101 });
  });

  it('onError 返回 abort 时才中断（安全红线专用；默认只吞不掉链）', async () => {
    const seen: string[] = [];
    const bus = new HookBus<TestHooks>({
      name: 'test',
      onError: () => 'abort' as const,
    });
    bus.on('ping', () => {
      seen.push('观察者');
      throw new Error('红线');
    });

    await expect(bus.run('ping', { n: 1 }, async (p) => p)).rejects.toThrow('红线');
    expect(seen).toEqual(['观察者']); // 中断发生在它之后（core 未执行）
  });
});
