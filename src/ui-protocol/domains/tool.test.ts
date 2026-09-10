// ============================================================
// UI 协议层 — 工具域测试
// ============================================================
// 覆盖：
//  1. tool.list 返回全部工具 + 启用状态 + bundle 过滤标记 + 来源 + 所属工具包
//  2. tool.toggle 启用/禁用
//  3. tool.bundles 返回可加入的工具包列表
//  4. 后端组件缺失时 → 报错
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createToolDomain, type ToolRegistryLike } from './tool.js';
import type { BundleRegistryLike } from './bundle.js';
import type { UiResponse } from '../types.js';

function makeToolRegistry(): ToolRegistryLike {
  const disabled = new Set<string>();
  const items = [
    { name: 'read', description: '读取文件' },
    { name: 'bash', description: '执行命令' },
    { name: 'git', description: '版本控制' },
    // MCP 桥接进来的工具：带 source + mcpServer
    { name: 'mcp__chrome-devtools__click', description: '[MCP:chrome-devtools] 点击', source: 'mcp', mcpServer: 'chrome-devtools' },
  ];
  return {
    getAll: () => items,
    has: (n) => items.some((i) => i.name === n),
    isEnabled: (n) => !disabled.has(n),
    enable: (n) => disabled.delete(n),
    disable: (n) => disabled.add(n),
    getHotAddedNames: () => ['mcp__chrome-devtools__click'],
  };
}

function makeBundles(activeToolNames: string[], allMode = false): BundleRegistryLike {
  return {
    isAllMode: () => allMode,
    // 归属数据：read 同时属于 common 与 coding
    list: () => [
      { name: 'common', description: '通用', builtin: true, tools: ['read', 'bash'] },
      { name: 'coding', description: '编程', builtin: true, tools: ['read', 'git'] },
      { name: 'mine', description: '自定义', tools: ['bash'] },
    ],
    getActive: () => [],
    getActiveToolNames: () => activeToolNames,
    activate: () => {},
    deactivate: () => {},
    create: () => ({ name: '', description: '', tools: [] }),
    delete: () => {},
    addTools: () => {},
    removeTools: () => {},
  };
}

function setup(overrides: { tool?: ToolRegistryLike | null; bundle?: BundleRegistryLike | null } = {}) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const tool = overrides.tool === undefined ? makeToolRegistry() : overrides.tool;
  const bundle = overrides.bundle === undefined ? makeBundles(['read']) : overrides.bundle;
  server.registerDomain('tool', createToolDomain({
    getToolRegistry: () => tool,
    getBundleRegistry: () => bundle,
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const wait = async (id: string, timeout = 2000): Promise<UiResponse> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timeout waiting for ${id}`);
  };
  return { client, wait };
}

describe('工具域', () => {
  it('tool.list 返回工具、启用状态与 bundle 过滤标记', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'l1', method: 'tool.list' });
    const resp = await wait('l1');
    expect(resp.ok).toBe(true);
    const tools = (resp.result as any).tools;
    expect(tools.length).toBe(4);
    const read = tools.find((t: any) => t.name === 'read');
    expect(read.enabled).toBe(true);
    // 非全量模式 + read 在激活包 → 不过滤；bash 不在 → 过滤
    expect(read.bundleFiltered).toBe(false);
    expect(tools.find((t: any) => t.name === 'bash').bundleFiltered).toBe(true);
  });

  it('tool.list 带来源标注：MCP 工具有 source/mcpServer，普通工具回落 builtin', async () => {
    const { client, wait } = setup({ bundle: makeBundles([], true) });
    client.send({ kind: 'request', id: 'src', method: 'tool.list' });
    const resp = await wait('src');
    const tools = (resp.result as any).tools;
    const mcpTool = tools.find((t: any) => t.name === 'mcp__chrome-devtools__click');
    expect(mcpTool.source).toBe('mcp');
    expect(mcpTool.mcpServer).toBe('chrome-devtools');
    expect(mcpTool.hotAdded).toBe(true);
    // 未声明 source 的普通工具回落 builtin
    expect(tools.find((t: any) => t.name === 'read').source).toBe('builtin');
    expect(tools.find((t: any) => t.name === 'read').hotAdded).toBe(false);
  });

  it('tool.list 返回工具所属的工具包（移出操作的依据）', async () => {
    const { client, wait } = setup({ bundle: makeBundles([], true) });
    client.send({ kind: 'request', id: 'mem', method: 'tool.list' });
    const resp = await wait('mem');
    const tools = (resp.result as any).tools;
    expect(tools.find((t: any) => t.name === 'read').bundles.sort()).toEqual(['coding', 'common']);
    expect(tools.find((t: any) => t.name === 'bash').bundles.sort()).toEqual(['common', 'mine']);
    // 不属于任何包
    expect(tools.find((t: any) => t.name === 'mcp__chrome-devtools__click').bundles).toEqual([]);
  });

  it('tool.bundles 返回可加入的工具包列表', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'b1', method: 'tool.bundles' });
    const resp = await wait('b1');
    expect(resp.ok).toBe(true);
    expect((resp.result as any).bundles.map((b: any) => b.name)).toEqual(['common', 'coding', 'mine']);
  });

  it('全量模式下无 bundle 过滤', async () => {
    const { client, wait } = setup({ bundle: makeBundles([], true) });
    client.send({ kind: 'request', id: 'l1', method: 'tool.list' });
    const resp = await wait('l1');
    const tools = (resp.result as any).tools;
    expect(tools.every((t: any) => t.bundleFiltered === false)).toBe(true);
  });

  it('tool.toggle 禁用/启用工具', async () => {
    const registry = makeToolRegistry();
    const { client, wait } = setup({ tool: registry });
    client.send({ kind: 'request', id: 't1', method: 'tool.toggle', params: { name: 'bash', enabled: false } });
    const resp = await wait('t1');
    expect(resp.ok).toBe(true);
    expect(resp.result).toEqual({ ok: true, name: 'bash', enabled: false });
    expect(registry.isEnabled('bash')).toBe(false);

    client.send({ kind: 'request', id: 't2', method: 'tool.toggle', params: { name: 'bash', enabled: true } });
    await wait('t2');
    expect(registry.isEnabled('bash')).toBe(true);
  });

  it('tool.toggle 不存在的工具 → 报错', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 't1', method: 'tool.toggle', params: { name: 'nope', enabled: true } });
    const resp = await wait('t1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not found');
  });

  it('后端组件缺失 → 报错', async () => {
    const { client, wait } = setup({ tool: null });
    client.send({ kind: 'request', id: 'l1', method: 'tool.list' });
    const resp = await wait('l1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not supported');
  });
});
