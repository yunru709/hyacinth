import { describe, it, expect } from 'vitest';
import { resolveSlotContract, DEFAULT_PIPELINE_SLOTS } from './create-kernel.js';

// resolveSlotContract —— 治「配置漂移」的纯函数（2026-10-22「启动即崩」的治本）。
// create-kernel.test.ts 已从「装配不抛错」的角度锁住主路径；这里补锁三条分支的
// **精确行为**（尤其「impl 不同 → 保留配置 requires」，之前没覆盖 —— 那是插件
// 替换内置实现 / 配置扩展自定义槽位的契约归属路径）：
//   · 同 id 同 impl  → requires 一律取出厂默认（丢弃配置里过时的 requires）
//   · impl 不同      → 保留配置里的 requires（契约属于那个替换实现，不能拿出厂值覆盖）
//   · 配置多出的自定义槽位（无出厂默认）→ 原样保留
//   · 只校准 requires，不动 enabled / 顺序 等其它字段
describe('resolveSlotContract（配置漂移对齐）', () => {
  const defContext = DEFAULT_PIPELINE_SLOTS.find((s) => s.id === 'context')!;

  it('同 id 同 impl：陈旧 requires 被出厂值覆盖', () => {
    const stale = {
      ...defContext,
      requires: { reads: ['history', 'userInput', 'tools'], writes: ['messages'] },
    };
    const got = resolveSlotContract([stale]).find((s) => s.id === 'context')!;
    expect(got.requires).toEqual(defContext.requires);
  });

  it('impl 不同：保留配置里的 requires（契约归替换实现）', () => {
    const alt = {
      ...defContext,
      impl: 'plugin:my-context',
      requires: { reads: ['x'], writes: ['y'] },
    };
    const got = resolveSlotContract([alt]).find((s) => s.id === 'context')!;
    expect(got.impl).toBe('plugin:my-context');
    expect(got.requires).toEqual({ reads: ['x'], writes: ['y'] });
  });

  it('配置多出的自定义槽位（无出厂默认）：原样保留', () => {
    const custom = {
      id: 'my-slot',
      impl: 'plugin:x',
      enabled: true,
      requires: { reads: ['a'], writes: ['b'] },
    };
    const got = resolveSlotContract([custom]).find((s) => s.id === 'my-slot')!;
    expect(got).toEqual(custom);
  });

  it('只校准 requires，不动 enabled 等其它字段', () => {
    const disabled = {
      ...defContext,
      enabled: false,
      requires: { reads: ['history'], writes: [] },
    };
    const got = resolveSlotContract([disabled]).find((s) => s.id === 'context')!;
    expect(got.enabled).toBe(false);
    expect(got.requires).toEqual(defContext.requires);
  });
});
