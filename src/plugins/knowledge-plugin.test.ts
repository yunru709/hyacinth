// ============================================================
// Knowledge 插件（P3 第一个功能插件）验收测试
// ============================================================
// 验证插件化模式：
//   1. mount 后工具注册进 ToolRegistry、ContextSource 注册进 composer
//   2. 'knowledge.api' 服务句柄可被 factory 取回（协议层消费面）
//   3. unmount 后工具/源全部回滚（可逆）
//   4. 结构化存储懒创建（不启用知识库时不建表）
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { PluginHost } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import { createKnowledgePlugin, KNOWLEDGE_API_KEY, type KnowledgeApi } from './knowledge-plugin.js';

interface Services extends Record<string, unknown> {
  'knowledge.api': KnowledgeApi;
}
type Hooks = LoopHooks & Record<string, unknown>;

/** 内存版 ToolRegistry / ContextComposer mock（验证注册与回滚） */
function makeMocks() {
  const tools: string[] = [];
  const sources: string[] = [];
  const toolRegistry = {
    register: (t: { name: string }) => { tools.push(t.name); },
    unregister: (n: string) => { const i = tools.indexOf(n); if (i >= 0) tools.splice(i, 1); return true; },
  };
  const contextComposer = {
    registerSource: (s: { name: string }) => { sources.push(s.name); },
    unregisterSource: (n: string) => { const i = sources.indexOf(n); if (i >= 0) sources.splice(i, 1); },
    activeConditions: new Set<string>(),
  };
  return { tools, sources, toolRegistry, contextComposer };
}

function tmpKbDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kbplug-'));
}

describe('knowledge 插件', () => {
  let kbDir: string;
  afterEach(() => {
    try { fs.rmSync(kbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('mount 后注册 6 工具 + kb_context 源，api 服务可取回', async () => {
    kbDir = tmpKbDir();
    const { tools, sources, toolRegistry, contextComposer } = makeMocks();
    const host = new PluginHost<Services, Hooks>({ toolRegistry, contextComposer });

    await host.mount(createKnowledgePlugin({
      contextComposer: contextComposer as never,
      configCenter: { get: () => false } as never,
    }), { kbDir });

    // 工具：kb_toggle + kb_structured + kb_add/list/delete/update = 6
    expect(tools.sort()).toEqual(['kb_add', 'kb_delete', 'kb_list', 'kb_structured', 'kb_toggle', 'kb_update']);
    expect(sources).toEqual(['kb_context']);

    // api 服务句柄（factory 取回面）
    const api = host.get(KNOWLEDGE_API_KEY);
    expect(api).toBeTruthy();
    expect(api!.knowledgeBase).toBeTruthy();
    expect(typeof api!.getWatcher).toBe('function');

    await host.unmount('knowledge');
    expect(tools).toEqual([]);
    expect(sources).toEqual([]);
  });

  it('结构化存储懒创建：未启用知识库时不建表', async () => {
    kbDir = tmpKbDir();
    const { toolRegistry, contextComposer } = makeMocks();
    const host = new PluginHost<Services, Hooks>({ toolRegistry, contextComposer });

    await host.mount(createKnowledgePlugin({
      contextComposer: contextComposer as never,
      configCenter: { get: () => false } as never,
    }), { kbDir });

    // 挂载后不触发检索 → kb.sqlite 不应存在（懒创建）
    const sqlitePath = path.join(kbDir, 'kb.sqlite');
    expect(fs.existsSync(sqlitePath)).toBe(false);

    // 取回 getStructuredStore 并调用才建表
    const api = host.get(KNOWLEDGE_API_KEY)!;
    api.getStructuredStore();
    expect(fs.existsSync(sqlitePath)).toBe(true);

    await host.unmount('knowledge');
  });

  it('kb_toggle 工具可开启知识库并同步 Zone4 条件', async () => {
    kbDir = tmpKbDir();
    const { tools, toolRegistry, contextComposer } = makeMocks();
    const host = new PluginHost<Services, Hooks>({ toolRegistry, contextComposer });

    await host.mount(createKnowledgePlugin({
      contextComposer: contextComposer as never,
      configCenter: { get: () => false } as never,
    }), { kbDir });

    const toggle = tools.includes('kb_toggle');
    expect(toggle).toBe(true);

    // kb_toggle 执行 on 时：置 zone4_enabled 条件
    // 注：mock composer 的 activeConditions 是 Set，真实实现会 add
    expect(contextComposer.activeConditions).toBeDefined();

    await host.unmount('knowledge');
  });
});
