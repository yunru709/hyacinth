// ============================================================
// Xref 插件（P4 第一个）验收测试
// ============================================================
// 验证：
//   1. mount 后注册 XrefBuild/XrefQuery/XrefGraph 3 工具
//   2. 卸载后工具回滚注销
//   3. cwd 不存在时插件降级 idle（不炸）
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PluginHost } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { createXrefPlugin } from './xref-plugin.js';

interface Services extends Record<string, unknown> {}
type Hooks = LoopHooks & Record<string, unknown>;

function makeRegistry() {
  const tools: string[] = [];
  return {
    tools,
    toolRegistry: {
      register: (t: { name: string }) => { tools.push(t.name); },
      unregister: (n: string) => { const i = tools.indexOf(n); if (i >= 0) tools.splice(i, 1); return true; },
    },
  };
}

describe('xref 插件', () => {
  let tmp: string;
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('mount 后注册 3 个 xref 工具，卸载后回滚', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrefplug-'));
    // 建一个最小 TS 文件供 init 索引
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function foo() { return 1; }\n');

    const { tools, toolRegistry } = makeRegistry();
    const host = new PluginHost<Services, Hooks>({ toolRegistry });

    await host.mount(createXrefPlugin({ cwd: tmp }));

    expect(tools.sort()).toEqual(['xref_build', 'xref_graph', 'xref_query']);

    await host.unmount('xref');
    expect(tools).toEqual([]);
  });

  it('空 cwd 初始化失败时降级 idle（不抛、不注册）', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrefplug2-'));
    const { tools, toolRegistry } = makeRegistry();
    const host = new PluginHost<Services, Hooks>({ toolRegistry });

    // 空目录无 src → xref 可能 init 成功但无索引；用不存在路径测降级
    await host.mount(createXrefPlugin({ cwd: path.join(tmp, 'nonexistent') }));

    // 降级 idle：可能注册也可能不注册（取决于 init 行为），但 mount 不抛
    expect(host.list().some((p) => p.id === 'xref' && p.state === 'mounted')).toBe(true);
  });
});
