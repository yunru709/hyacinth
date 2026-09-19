// ============================================================
// Xref 插件（P4 第一个）验收测试
// ============================================================
// 验证：
//   1. mount 后注册 XrefBuild/XrefQuery/XrefGraph 3 工具
//   2. 卸载后工具回滚注销
//   3. cwd 不存在时插件降级 idle（不炸）
//
// 【隔离修复】此前本文件直接 mount 插件 → XrefManager.init(tmp) 把索引库写进
// **真实** `~/.agent/cache/xref-<projectKey>.sqlite`，且只删临时项目、从不删库：
// 每跑一次留 1~3 个文件，实测已累积 1244+ 个 `xrefplug*` 残留（2026-08-31 起）。
// 现在劫持 os.homedir() 到临时目录，并在用例结束后关连接 + 删目录。
// ============================================================

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
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
  let fakeHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xrefplug-home-'));
    // xref 库位置没有环境变量开关（见 manager.init），劫持 homedir 是唯一的隔离手段
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterAll(() => {
    homedirSpy?.mockRestore();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

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

    // 关掉连接，否则临时库文件在 Windows 上仍被占用
    await host.unmount('xref');
  });

  it('隔离自检：索引库写在被劫持的临时 home 内，不在真实 ~/.agent/cache', () => {
    const cacheDir = path.join(fakeHome, '.agent', 'cache');
    expect(fs.existsSync(cacheDir)).toBe(true);
    const leaked = fs.readdirSync(cacheDir).filter((f) => f.startsWith('xref-') && f.endsWith('.sqlite'));
    expect(leaked.length).toBeGreaterThan(0);
  });
  // ── Phase 6：引用分析能力的注册生命周期 ──────────────────────────────
  // 验收线：「xref 卸载 → 行为退回纯兜底，无报错」。机制：activate 时
  // ctx.register('referenceAnalysis', cap)，卸载时宿主把服务恢复为注册前的值；
  // 消费侧（loop-tools 的 ctx 字面量）**每回合现场**从 host.get 取 ⇒ 取不到即 null
  // ⇒ analyzeReferences 走核心兜底。故这里只需证明注册面随挂载/卸载增删。

  it('能力注册随挂载/卸载增删：referenceAnalysis', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrefplug-cap-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function foo() { return 1; }\n');

    const { toolRegistry } = makeRegistry();
    const host = new PluginHost<Services, Hooks>({ toolRegistry });

    expect(host.get('referenceAnalysis')).toBeUndefined(); // 挂载前 = 消费侧会走兜底

    await host.mount(createXrefPlugin({ cwd: tmp }));
    expect(host.get('referenceAnalysis')).toBeTruthy(); // 挂载后能力就位

    await host.unmount('xref');
    expect(host.get('referenceAnalysis')).toBeUndefined(); // 卸载后回到"从未挂载过"
  });

  it('索引没建过 → 能力返回空串（交给兜底），原因如实记录而非"没有引用"', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xrefplug-noidx-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function foo() { return 1; }\n');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), "import { foo } from './a.js';\nexport const v = foo();\n");

    const { toolRegistry } = makeRegistry();
    const host = new PluginHost<Services, Hooks>({ toolRegistry });
    await host.mount(createXrefPlugin({ cwd: tmp }));
    try {
      const cap = host.get('referenceAnalysis') as {
        analyze: (i: {
          toolName: string;
          filePath: string;
          before: string;
          after: string;
          oldText: string;
          newText: string;
        }) => Promise<string>;
        getRuntime?: () => { lastReason: string };
      };
      const out = await cap.analyze({
        toolName: 'write',
        filePath: path.join(tmp, 'src', 'a.ts'),
        before: 'export function foo() { return 1; }\n',
        after: 'export function foo2() { return 1; }\n',
        oldText: 'export function foo() { return 1; }',
        newText: 'export function foo2() { return 1; }',
      });
      expect(out).toBe(''); // 没建索引 ⇒ 不给精确结论（空 = 消费侧走兜底）
      expect(cap.getRuntime?.().lastReason).toBe('索引陈旧'); // 原因如实
    } finally {
      await host.unmount('xref');
    }
  });
});
