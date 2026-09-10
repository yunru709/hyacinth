// ============================================================
// UI 协议层 — 工具包域测试
// ============================================================
// 用真实 ToolBundleRegistry + 临时配置目录验证全流程：
//  list / activate / deactivate / create / delete / addTools / removeTools
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { ToolBundleRegistry } from '../../tools/bundle-registry.js';
import { createBundleDomain } from './bundle.js';
import type { UiResponse } from '../types.js';

let tmpRoot: string;
let registry: ToolBundleRegistry;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'ui-protocol-bundle-'));
  // 注入临时配置路径，避免读写真实 ~/.agent/tool-bundles.json
  registry = new ToolBundleRegistry(process.cwd(), path.join(tmpRoot, 'tool-bundles.json'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function setup() {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('bundle', createBundleDomain({ getBundleRegistry: () => registry }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const wait = async (id: string, timeout = 3000): Promise<UiResponse> => {
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

describe('工具包域', () => {
  it('bundle.list 返回全部工具包与激活状态', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'l1', method: 'bundle.list' });
    const resp = await wait('l1');
    expect(resp.ok).toBe(true);
    const result = resp.result as any;
    // v2 迁移后默认只激活 coding 包（不再是全量模式），见 bundle-registry.ts DEFAULT_CONFIG
    expect(result.allMode).toBe(false);
    expect(result.bundles.length).toBeGreaterThanOrEqual(3);
    expect(result.bundles.some((b: any) => b.name === 'common' && b.builtin)).toBe(true);
  });

  it('bundle.create → list 可见；bundle.addTools/removeTools 修改工具集', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'c1', method: 'bundle.create', params: { name: 'mytest', description: '测试包', tools: ['read'] } });
    const created = await wait('c1');
    expect(created.ok).toBe(true);
    expect((created.result as any).name).toBe('mytest');

    client.send({ kind: 'request', id: 'a1', method: 'bundle.addTools', params: { name: 'mytest', tools: ['bash', 'git'] } });
    const added = await wait('a1');
    expect(added.ok).toBe(true);
    expect(registry.get('mytest')!.tools).toEqual(expect.arrayContaining(['bash', 'git']));

    client.send({ kind: 'request', id: 'r1', method: 'bundle.removeTools', params: { name: 'mytest', tools: ['bash'] } });
    await wait('r1');
    expect(registry.get('mytest')!.tools).not.toContain('bash');
    expect(registry.get('mytest')!.tools).toContain('git');
  });

  it('bundle.activate 切换激活集；deactivate 回全量模式', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'act1', method: 'bundle.activate', params: { names: ['coding'] } });
    const act = await wait('act1');
    expect(act.ok).toBe(true);
    expect(registry.isAllMode()).toBe(false);
    expect(registry.getActive().map((b) => b.name)).toContain('coding');

    client.send({ kind: 'request', id: 'de1', method: 'bundle.deactivate' });
    await wait('de1');
    expect(registry.isAllMode()).toBe(true);
  });

  it('bundle.delete 删除自定义包；内置包不可删', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'c1', method: 'bundle.create', params: { name: 'delme', description: 'x', tools: [] } });
    await wait('c1');
    client.send({ kind: 'request', id: 'd1', method: 'bundle.delete', params: { name: 'delme' } });
    const del = await wait('d1');
    expect(del.ok).toBe(true);
    expect(registry.get('delme')).toBeUndefined();

    // 内置包删除 → 报错
    client.send({ kind: 'request', id: 'd2', method: 'bundle.delete', params: { name: 'common' } });
    const delBuiltin = await wait('d2');
    expect(delBuiltin.ok).toBe(false);
  });

  it('激活不存在的包 → 报错', async () => {
    const { client, wait } = setup();
    client.send({ kind: 'request', id: 'a1', method: 'bundle.activate', params: { names: ['ghost'] } });
    const resp = await wait('a1');
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain('not found');
  });
});
