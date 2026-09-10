// ============================================================
// UI 协议层 — 命令域测试
// ============================================================
// 验证：
//  1. command.list 导出分类树（category/label/commands + name/description/args）
//  2. command.execute 分派后端命令 → 注入 executor 执行成功
//  3. 纯 UI 命令（clear/help/exit 等 + executeLocal）→ unsupported 标记
//  4. 未知命令 → command-not-found
//  5. 无 executor 的后端命令 → backend-not-wired
// ============================================================

import { describe, it, expect } from 'vitest';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createCommandDomain, type CommandDefLike, type CommandRegistryLike } from './command.js';
import type { UiResponse } from '../types.js';

// ── mock 命令注册表 ────────────────────────────────────────

function makeRegistry(): CommandRegistryLike {
  const commands: CommandDefLike[] = [
    {
      name: 'clear',
      description: '清屏',
      category: 'system',
      executeLocal: true,
    },
    {
      name: 'help',
      description: '显示帮助信息',
      category: 'system',
      executeLocal: true,
    },
    {
      name: 'model',
      description: '模型管理（在线/本地/设置/信息）',
      category: 'model',
      children: [
        { name: 'switch', description: '切换模型', category: 'model' },
        { name: 'set-thinking', description: '设置思考模式', category: 'model' },
      ],
    },
    {
      name: 'config',
      description: '调整参数...',
      category: 'config',
      children: [
        { name: 'maxTurns', description: '设置轮次上限', category: 'config', args: '<number>' },
      ],
    },
    {
      name: 'session',
      description: '会话管理',
      category: 'session',
      children: [
        { name: 'list', description: '列出所有会话', category: 'session' },
        { name: 'load', description: '加载会话', category: 'session', args: '<id>' },
      ],
    },
  ];

  const byCategory = new Map<string, CommandDefLike[]>();
  const add = (cmd: CommandDefLike, parentName?: string) => {
    const display = parentName ? { ...cmd, name: `${parentName}/${cmd.name}` } : cmd;
    const group = byCategory.get(display.category!) ?? [];
    group.push(display);
    byCategory.set(display.category!, group);
    if (cmd.children) {
      for (const child of cmd.children) add(child, parentName ? `${parentName}/${cmd.name}` : cmd.name);
    }
  };
  for (const cmd of commands) add(cmd);

  return {
    getByCategory: () => byCategory,
    find: (name: string) => {
      // 扁平查找（含子命令路径）
      const flat: CommandDefLike[] = [];
      const walk = (cmds: CommandDefLike[], prefix = '') => {
        for (const c of cmds) {
          const full = prefix ? `${prefix}/${c.name}` : c.name;
          flat.push({ ...c, name: full });
          if (c.children) walk(c.children, full);
        }
      };
      walk(commands);
      return flat.find((c) => c.name === name);
    },
  };
}

function setup(executor?: (cmd: CommandDefLike, args: string) => unknown) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  const domain = createCommandDomain({ registry: makeRegistry(), executor });
  server.registerDomain('command', domain);
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return { client, responses, flush };
}

describe('命令域', () => {
  it('command.list 导出分类树（category/label/commands）', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'command.list' });
    await flush();

    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    const { categories, total } = responses[0].result as any;

    // 分类树存在：system / model / config / session
    const catNames = categories.map((c: any) => c.category);
    expect(catNames).toContain('system');
    expect(catNames).toContain('model');
    expect(catNames).toContain('config');
    expect(catNames).toContain('session');

    // 每类有 label + commands
    const modelCat = categories.find((c: any) => c.category === 'model');
    expect(modelCat.label).toBe('模型');
    // 子命令继承父分类并带路径前缀
    expect(modelCat.commands.some((c: any) => c.name === 'model/switch')).toBe(true);
    expect(modelCat.commands.some((c: any) => c.name === 'model/set-thinking')).toBe(true);

    // args 正确导出
    const configCat = categories.find((c: any) => c.category === 'config');
    const maxTurns = configCat.commands.find((c: any) => c.name === 'config/maxTurns');
    expect(maxTurns.args).toBe('<number>');

    // 总数 > 0
    expect(total).toBeGreaterThan(0);
  });

  it('command.execute 后端命令 → 注入 executor 执行成功（含完整路径 fullName）', async () => {
    const executed: Array<{ name: string; args: string; fullName?: string }> = [];
    const executor = (cmd: CommandDefLike, args: string, fullName?: string) => {
      executed.push({ name: cmd.name, args, fullName });
      return { switched: true, model: args };
    };
    const { client, responses, flush } = setup(executor);

    client.send({
      kind: 'request',
      id: 'r1',
      method: 'command.execute',
      params: { name: 'model/switch', args: 'claude-sonnet-5' },
    });
    await flush();

    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({
      name: 'model/switch',
      args: 'claude-sonnet-5',
      fullName: 'model/switch',
    });
    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(responses[0].result).toMatchObject({ ok: true, command: 'model/switch' });
    expect((responses[0].result as any).result).toEqual({ switched: true, model: 'claude-sonnet-5' });
  });

  it('command.execute 纯 UI 命令（executeLocal）→ unsupported: ui-only', async () => {
    const { client, responses, flush } = setup();
    // clear 是 executeLocal 命令
    client.send({ kind: 'request', id: 'r1', method: 'command.execute', params: { name: 'clear' } });
    await flush();

    expect(responses[0]).toMatchObject({ id: 'r1', ok: true });
    expect(responses[0].result).toMatchObject({
      ok: true,
      unsupported: true,
      reason: 'ui-only',
      command: 'clear',
    });
  });

  it('command.execute 纯 UI 命令（help/exit 白名单）→ unsupported: ui-only', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'command.execute', params: { name: 'help' } });
    await flush();
    expect(responses[0].result).toMatchObject({ unsupported: true, reason: 'ui-only' });
  });

  it('command.execute 未知命令 → command-not-found', async () => {
    const { client, responses, flush } = setup();
    client.send({ kind: 'request', id: 'r1', method: 'command.execute', params: { name: 'nope/nothing' } });
    await flush();
    expect(responses[0].result).toMatchObject({ ok: false, reason: 'command-not-found' });
  });

  it('command.execute 无 executor 的后端命令 → backend-not-wired', async () => {
    const { client, responses, flush } = setup(); // 不注入 executor
    client.send({ kind: 'request', id: 'r1', method: 'command.execute', params: { name: 'model/switch' } });
    await flush();
    expect(responses[0].result).toMatchObject({ ok: true, unsupported: true, reason: 'backend-not-wired' });
  });
});
