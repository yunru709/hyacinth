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
      // ⚠️ 不能断言对象身份：createDefaultRegistry() 通过 createWatchTools({owner})
      // 工厂创建工具（每个会话绑自己的 owner），每次都是新实例。
      // 这里校验的是"同名工具确实注册了且契约一致"，不是"同一个对象"。
      const registered = registry.get(tool.name);
      expect(registered, `tool not registered: ${tool.name}`).toBeDefined();
      expect(registered!.description).toBe(tool.description);
    }
  });

  it('全是只读副作用（监控不改变外部状态）', () => {
    for (const tool of watchTools) expect(tool.sideEffect).toBe('read');
  });
});
