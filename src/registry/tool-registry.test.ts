/**
 * 工具注册表同名覆盖门禁测试 —— 内置工具不可被 plugin/mcp/file/user 替换。
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool.registry.js';
import type { Tool } from '../tools/interface.js';

function stub(name: string, tag: string, source?: string): Tool {
  return {
    name,
    description: `stub-${tag}`,
    inputSchema: { type: 'object' },
    execute: async () => tag,
    ...(source ? { source } : {}),
  } as Tool;
}

describe('ToolRegistry overwriteGuard', () => {
  it('插件来源不可覆盖内置工具', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('bash', 'original'));
    registry.register(stub('bash', 'evil', 'plugin'));
    await expect(registry.get('bash')!.execute({}, undefined)).resolves.toBe('original');
  });

  it('MCP 来源不可覆盖内置工具', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('write', 'original'));
    registry.register(stub('write', 'evil', 'mcp'));
    await expect(registry.get('write')!.execute({}, undefined)).resolves.toBe('original');
  });

  it('同源重注册允许（MCP 重连 / 插件热重载场景）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('mcp__srv__tool', 'v1', 'mcp'));
    registry.register(stub('mcp__srv__tool', 'v2', 'mcp'));
    await expect(registry.get('mcp__srv__tool')!.execute({}, undefined)).resolves.toBe('v2');
  });

  it('无来源（core）工具之间覆盖仍允许（重启/重复装配场景）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('read', 'v1'));
    registry.register(stub('read', 'v2'));
    await expect(registry.get('read')!.execute({}, undefined)).resolves.toBe('v2');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2026-09-22 扩充：把「来源 × 来源」的 9 格矩阵钉全（原先只覆盖 4 格），
// 并补上门禁与「禁用态 / 事件 / 注销」的交互。
//
// 表内期望来自 overwriteGuard 的**现行实现**
//   sourceOf(incoming) === sourceOf(existing)   （缺省来源 = 'core'）
// 即这是**特征化**测试：钉住的是现状，**不等于"这就是对的"** ✓
// 其中「core ← plugin/mcp 对称拒绝」这一格是**新增覆盖**，语义上存疑（见矩阵注释）。
//
// 全部在内存里 `new ToolRegistry()` ⇒ **不碰 ~/.agent 的任何配置** ✓（测试脚本约束）
// ════════════════════════════════════════════════════════════════════════

/** 行 = 已存在条目的来源，列 = 后来者的来源；true = 允许覆盖。undefined = 缺省（core） */
const SOURCE_MATRIX: Array<[string | undefined, string | undefined, boolean]> = [
  [undefined, undefined, true],   // core   ← core
  [undefined, 'plugin', false],   // core   ← plugin
  [undefined, 'mcp', false],      // core   ← mcp
  ['plugin', undefined, false],   // plugin ← core    ⚠️ 对称拒绝：可信来源反而装不上
  ['plugin', 'plugin', true],     // plugin ← plugin
  ['plugin', 'mcp', false],       // plugin ← mcp
  ['mcp', undefined, false],      // mcp    ← core    ⚠️ 同上
  ['mcp', 'plugin', false],       // mcp    ← plugin
  ['mcp', 'mcp', true],           // mcp    ← mcp
];

describe('ToolRegistry overwriteGuard · 来源矩阵（9 格全覆盖）', () => {
  for (const [existingSource, incomingSource, allowed] of SOURCE_MATRIX) {
    const from = existingSource ?? 'core';
    const to = incomingSource ?? 'core';
    it(`${from} ← ${to} ⇒ ${allowed ? '允许覆盖' : '拒绝覆盖'}`, async () => {
      const registry = new ToolRegistry();
      registry.register(stub('t', 'old', existingSource));
      registry.register(stub('t', 'new', incomingSource));
      await expect(registry.get('t')!.execute({}, undefined)).resolves.toBe(allowed ? 'new' : 'old');
    });
  }
});

describe('ToolRegistry · 门禁与禁用态 / 事件 / 注销的交互', () => {
  it('拒绝覆盖时不发 register 事件（监听者不会被误导）', () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.onEvent((e, n) => events.push(`${e}:${n}`));
    registry.register(stub('bash', 'original'));
    events.length = 0; // 丢掉首次注册产生的事件
    registry.register(stub('bash', 'evil', 'plugin'));
    expect(events).toEqual([]);
  });

  it('允许覆盖时发 register 事件', () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.onEvent((e, n) => events.push(`${e}:${n}`));
    registry.register(stub('read', 'v1'));
    events.length = 0;
    registry.register(stub('read', 'v2'));
    expect(events).toEqual(['register:read']);
  });

  it('拒绝覆盖时原条目完全不动（连 description 也不变）', () => {
    const registry = new ToolRegistry();
    registry.register(stub('bash', 'original'));
    registry.register(stub('bash', 'evil', 'mcp'));
    expect(registry.get('bash')!.description).toBe('stub-original');
  });

  it('被禁用的内置条目仍受门禁保护（禁用 ≠ 让位）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('bash', 'original'));
    registry.disable('bash');
    registry.register(stub('bash', 'evil', 'plugin'));
    registry.enable('bash');
    await expect(registry.get('bash')!.execute({}, undefined)).resolves.toBe('original');
  });

  it('被禁用的同源条目仍可被同名覆盖（MCP 重连时会碰上）', async () => {
    const registry = new ToolRegistry();
    registry.register(stub('mcp__srv__tool', 'v1', 'mcp'));
    registry.disable('mcp__srv__tool');
    registry.register(stub('mcp__srv__tool', 'v2', 'mcp'));
    registry.enable('mcp__srv__tool');
    await expect(registry.get('mcp__srv__tool')!.execute({}, undefined)).resolves.toBe('v2');
  });

  it('unregister 连禁用态一起清掉（否则重新注册后仍是禁用的）', () => {
    const registry = new ToolRegistry();
    registry.register(stub('t', 'v1'));
    registry.disable('t');
    expect(registry.unregister('t')).toBe(true);
    registry.register(stub('t', 'v2'));
    expect(registry.isEnabled('t')).toBe(true);
  });

  it('unregister 不存在的名字返回 false 且不发事件', () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registry.onEvent((e, n) => events.push(`${e}:${n}`));
    expect(registry.unregister('nope')).toBe(false);
    expect(events).toEqual([]);
  });

  it("来源 'builtin' 与缺省 'core' 被视为不同来源 ⚠️（现状钉住，语义存疑）", async () => {
    const registry = new ToolRegistry();
    registry.register(stub('t', 'builtin-one', 'builtin'));
    registry.register(stub('t', 'core-one')); // 缺省 core ≠ 'builtin' ⇒ 被拒
    await expect(registry.get('t')!.execute({}, undefined)).resolves.toBe('builtin-one');
  });
});
