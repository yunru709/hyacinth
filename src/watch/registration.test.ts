/**
 * 注册链路守卫测试（2026-10-29）
 *
 * 目的：证明 watch_* 真的进了 createDefaultRegistry()，而不只是"代码看起来对"。
 * 历史上吃过"写了模块但没接进注册表"的假绿亏，所以这里对注册结果直接断言。
 */

import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../tools/index.js';
import { watchTools } from './tool.js';

describe('watch 工具注册', () => {
  it('四个工具都进了默认注册表', () => {
    const registry = createDefaultRegistry();
    for (const name of ['watch_wait', 'watch_start', 'watch_stop', 'watch_list']) {
      expect(registry.get(name), `missing tool: ${name}`).toBeDefined();
    }
  });

  it('工具名不冲突且都声明了 schema', () => {
    const registry = createDefaultRegistry();
    const seen = new Set<string>();
    for (const tool of watchTools) {
      expect(seen.has(tool.name)).toBe(false);
      seen.add(tool.name);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeTruthy();
      // 注册表里的实例应当是同一个对象（不是被覆盖成别的实现）
      expect(registry.get(tool.name)).toBe(tool);
    }
  });

  it('全是只读副作用（监控不改变外部状态）', () => {
    for (const tool of watchTools) expect(tool.sideEffect).toBe('read');
  });
});
