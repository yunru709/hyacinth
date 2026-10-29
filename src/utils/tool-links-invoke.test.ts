/**
 * 路线 B（invoke）契约测试 — 2026-10-29
 *
 * 验证「按断言自动执行其他工具」这条链路：
 *   事件 → resolveToolLinks → core.invoke-tool → input.invokeTool(tool, args) → 真实工具
 *
 * 重点盯四件事：
 *   1. 未注入 runtime 时静默跳过（不得抛错，事件源是后台循环）
 *   2. 清单没声明 invoke 时不调用工具（不能"凭空执行"）
 *   3. invoke 失败不冒泡（fail-safe 契约）
 *   4. append 与 invoke 可在同一事件上共存（路线 A / B 不冲突）
 */

import { describe, expect, it, vi } from 'vitest';

import { invokeToolHandler } from '../orchestrator/tool-link-handlers.js';
import {
  runToolLinksForEvent,
  setToolLinkRuntime,
  ToolLinkRegistry,
  type ToolLinksManifest,
} from './tool-links.js';

function makeRuntime(invokeTool?: (tool: string, args: Record<string, unknown>) => Promise<string>) {
  const registry = new ToolLinkRegistry();
  registry.register(invokeToolHandler);
  return { registry, invokeTool };
}

function manifestWith(links: ToolLinksManifest['links']): () => ToolLinksManifest {
  return () => ({ version: 1, links });
}

describe('路线 B：invoke 按断言执行工具', () => {
  it('未注入 runtime 时静默返回空数组（不抛错）', async () => {
    setToolLinkRuntime(null);
    await expect(runToolLinksForEvent('afterWatch:process', {})).resolves.toEqual([]);
  });

  it('清单声明 invoke 时调用目标工具，参数原样传递', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    setToolLinkRuntime({
      ...makeRuntime(async (tool, args) => {
        calls.push([tool, args]);
        return 'ok';
      }),
      getManifest: manifestWith([
        {
          on: 'afterWatch:process',
          handler: 'core.invoke-tool',
          invoke: { tool: 'say', args: { content: '打完游戏了吗' } },
        },
      ]),
    });

    await runToolLinksForEvent('afterWatch:process', { watchId: 'w1' });

    expect(calls).toEqual([['say', { content: '打完游戏了吗' }]]);
    setToolLinkRuntime(null);
  });

  it('on 写前缀可覆盖全部子事件（afterWatch 匹配 afterWatch:file）', async () => {
    const calls: string[] = [];
    setToolLinkRuntime({
      ...makeRuntime(async (tool) => {
        calls.push(tool);
        return '';
      }),
      getManifest: manifestWith([
        { on: 'afterWatch', handler: 'core.invoke-tool', invoke: { tool: 'watched' } },
      ]),
    });

    await runToolLinksForEvent('afterWatch:file', {});
    await runToolLinksForEvent('afterWatch:port', {});

    expect(calls).toEqual(['watched', 'watched']);
    setToolLinkRuntime(null);
  });

  it('清单没写 invoke 规格时不执行任何工具', async () => {
    const spy = vi.fn(async () => '');
    setToolLinkRuntime({
      ...makeRuntime(spy),
      getManifest: manifestWith([{ on: 'afterWatch:process', handler: 'core.invoke-tool' }]),
    });

    await runToolLinksForEvent('afterWatch:process', {});
    expect(spy).not.toHaveBeenCalled();
    setToolLinkRuntime(null);
  });

  it('目标工具抛错不冒泡，事件源不受影响', async () => {
    setToolLinkRuntime({
      ...makeRuntime(async () => {
        throw new Error('tool exploded');
      }),
      getManifest: manifestWith([
        { on: 'afterWatch:process', handler: 'core.invoke-tool', invoke: { tool: 'boom' } },
      ]),
    });

    await expect(runToolLinksForEvent('afterWatch:process', {})).resolves.toEqual([]);
    setToolLinkRuntime(null);
  });

  it('enabled:false 的清单项被跳过', async () => {
    const spy = vi.fn(async () => '');
    setToolLinkRuntime({
      ...makeRuntime(spy),
      getManifest: manifestWith([
        {
          on: 'afterWatch:process',
          handler: 'core.invoke-tool',
          enabled: false,
          invoke: { tool: 'say' },
        },
      ]),
    });

    await runToolLinksForEvent('afterWatch:process', {});
    expect(spy).not.toHaveBeenCalled();
    setToolLinkRuntime(null);
  });

  it('invoke 与 append 可在同一事件共存，互不干扰', async () => {
    const order: string[] = [];
    const registry = new ToolLinkRegistry();
    registry.register(invokeToolHandler);
    // 一个假的 append 处理器，验证两者共存
    registry.register({
      id: 'test.append',
      kind: 'append',
      owner: 'core',
      on: 'afterWatch:process',
      run: async () => {
        order.push('append');
        return '附加文本';
      },
    });

    setToolLinkRuntime({
      registry,
      invokeTool: async () => {
        order.push('invoke');
        return '';
      },
      getManifest: manifestWith([
        { on: 'afterWatch:process', handler: 'test.append' },
        { on: 'afterWatch:process', handler: 'core.invoke-tool', invoke: { tool: 'say' } },
      ]),
    });

    const outputs = await runToolLinksForEvent('afterWatch:process', {});
    expect(order).toEqual(['append', 'invoke']);
    expect(outputs).toEqual(['附加文本']); // invoke 不产出文本
    setToolLinkRuntime(null);
  });
});
