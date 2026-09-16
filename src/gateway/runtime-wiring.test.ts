/**
 * runtime-wiring 渠道能力路由单测 + 反硬编码守卫。
 *
 * 覆盖两类不变量：
 *   1. 行为 —— 定时任务「最后兜底」与陪伴「推送目标」**按能力选**（persistent +
 *      fallbackPriority），本地 loop 以 localDefault 能力注册；主动推送模式判定同样按能力。
 *   2. 守卫 —— 核心不得再出现「按渠道名找 loop / 按渠道名判推送」的写法
 *      （历史反模式：`channelLoops.get('feishu')`、`channelLoops.set('tui')`、
 *        `usedChannel !== 'tui'`）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupChannelRegistries, findPersistentChannelLoop, installSchedulerHandler } from './runtime-wiring.js';
import type { ChannelLoopEntry } from '../channels/interface.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** 假 loop：记录 notifyTaskFired 的调用实参，便于断言推送 / 通知两种模式 */
function makeLoop(sessionId = 'tui_20260916-000000-aaaa'): { loop: Any; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const loop: Any = {
    notifyTaskFired: async (...args: unknown[]) => {
      calls.push(args);
    },
    sessionDir: path.join(os.tmpdir(), 'sessions', sessionId),
  };
  return { loop, calls };
}

/** 假 configCenter：只服务 schedule.channelFallback 查询 */
function makeConfigCenter(fallback?: string[]): Any {
  return { get: (k: string) => (k === 'schedule.channelFallback' ? fallback : undefined) };
}

/** 假 HeartbeatScheduler：捕获 handler 并支持手动触发 */
function makeScheduler(): { scheduler: Any; fire: (t: Any) => Promise<void> } {
  let handler: Any;
  return {
    scheduler: { setHandler: (fn: Any) => { handler = fn; } } as Any,
    fire: async (t: Any) => handler(t),
  };
}

/** 假持久渠道条目（自注册进全局注册表的形态，与 feishu/clawbot 实际写法一致） */
function registerPersistent(
  name: string,
  priority: number,
  calls: unknown[][] = [],
): void {
  const registry = (globalThis as Any).__channelLoopRegistry as Map<string, ChannelLoopEntry>;
  registry.set(name, {
    notifyTaskFired: async (...args: unknown[]) => {
      calls.push(args);
    },
    sendProactiveMessage: async () => {},
    capabilities: { persistent: true, fallbackPriority: priority },
  });
}

const aiTask = (over: Record<string, unknown> = {}): Any => ({
  name: 'T1',
  action: { type: 'agent', target: 'x' },
  ...over,
});

beforeEach(() => {
  // 两个注册表都是 globalThis 单例 —— 每个用例前清空，避免互相污染
  delete (globalThis as Any).__channelLoopRegistry;
  delete (globalThis as Any).__channelLoopSessionRegistry;
  delete (globalThis as Any).__channelSessionRegistry;
});

describe('渠道能力路由：最后兜底与本地默认', () => {
  it('多持久渠道同时在线 → 按 fallbackPriority 裁决（飞书 10 胜 ClawBot 5）', () => {
    const { loop } = makeLoop();
    const { resolveChannelLoop } = setupChannelRegistries(loop, 'tui', makeConfigCenter());
    registerPersistent('clawbot', 5);
    registerPersistent('feishu', 10);

    const r = resolveChannelLoop(aiTask());
    expect(r.channel).toBe('feishu');
    expect(r.level).toBe('last-resort');
  });

  it('高优先级渠道下线 → 次高优先级顶上（不再回落本地 loop）', () => {
    const { loop } = makeLoop();
    const registrySetup = setupChannelRegistries(loop, 'tui', makeConfigCenter());
    registerPersistent('clawbot', 5);

    const r = registrySetup.resolveChannelLoop(aiTask());
    expect(r.channel).toBe('clawbot');
  });

  it('无持久渠道 → 回落本地默认渠道（渠道名 = 启动渠道）', () => {
    const { loop } = makeLoop();
    const { resolveChannelLoop } = setupChannelRegistries(loop, 'tui', makeConfigCenter());

    const r = resolveChannelLoop(aiTask());
    expect(r.channel).toBe('tui');
    expect(r.level).toBe('last-resort');
  });

  it('未声明启动渠道（CLI / serve）→ 本地默认渠道名为 local', () => {
    const { loop } = makeLoop();
    const { resolveChannelLoop } = setupChannelRegistries(loop, undefined, makeConfigCenter());
    expect(resolveChannelLoop(aiTask()).channel).toBe('local');
  });

  it('显式指名与降级链仍按名字直取（这两条本就要求指名，非硬编码）', () => {
    const { loop } = makeLoop();
    const { resolveChannelLoop } = setupChannelRegistries(loop, 'tui', makeConfigCenter());
    registerPersistent('clawbot', 5);

    expect(resolveChannelLoop(aiTask({ channel: 'clawbot' }))).toMatchObject({ channel: 'clawbot', level: 'primary' });
    expect(resolveChannelLoop(aiTask({ channel: 'offline', fallback: ['clawbot'] }))).toMatchObject({
      channel: 'clawbot',
      level: 'fallback',
    });
  });

  it('本地 loop 以 localDefault 能力注册，且是薄壳（不污染业务实例）', () => {
    const { loop } = makeLoop();
    const { registries } = setupChannelRegistries(loop, 'tui', makeConfigCenter());

    const entry = registries.channelLoops.get('tui') as ChannelLoopEntry;
    expect(entry.capabilities?.localDefault).toBe(true);
    expect(entry.capabilities?.persistent).toBeUndefined();
    expect(entry as unknown).not.toBe(loop); // 薄壳而非裸 loop
  });

  it('channelSessions 仅在显式声明渠道时注册', () => {
    const a = makeLoop();
    const withCh = setupChannelRegistries(a.loop, 'tui', makeConfigCenter());
    expect(withCh.registries.channelSessions.get('tui')).toBeTypeOf('function');

    delete (globalThis as Any).__channelSessionRegistry;
    const b = makeLoop();
    const withoutCh = setupChannelRegistries(b.loop, undefined, makeConfigCenter());
    expect(withoutCh.registries.channelSessions.size).toBe(0);
  });
});

describe('findPersistentChannelLoop（按能力挑选）', () => {
  it('无持久渠道 → null（localDefault 不算持久）', () => {
    const m = new Map<string, ChannelLoopEntry>([
      ['tui', { notifyTaskFired: async () => {}, capabilities: { localDefault: true } }],
    ]);
    expect(findPersistentChannelLoop(m)).toBeNull();
  });

  it('同优先级 → 先注册者胜（Map 保序，结果稳定）', () => {
    const m = new Map<string, ChannelLoopEntry>([
      ['a', { notifyTaskFired: async () => {}, capabilities: { persistent: true, fallbackPriority: 1 } }],
      ['b', { notifyTaskFired: async () => {}, capabilities: { persistent: true, fallbackPriority: 1 } }],
    ]);
    expect(findPersistentChannelLoop(m)?.name).toBe('a');
  });

  it('优先级缺省为 0，可被任一显式优先级的持久渠道超越', () => {
    const m = new Map<string, ChannelLoopEntry>([
      ['zero', { notifyTaskFired: async () => {}, capabilities: { persistent: true } }],
      ['ten', { notifyTaskFired: async () => {}, capabilities: { persistent: true, fallbackPriority: 10 } }],
    ]);
    expect(findPersistentChannelLoop(m)?.name).toBe('ten');
  });
});

describe('主动推送模式判定按能力（不再写死 usedChannel !== 的本地渠道名）', () => {
  it('持久渠道 + 支持主动推送 → 走推送（notifyTaskFired 带 sessionId）', async () => {
    const { loop } = makeLoop();
    const { resolveChannelLoop, registries } = setupChannelRegistries(loop, 'tui', makeConfigCenter());
    const feishuCalls: unknown[][] = [];
    registerPersistent('feishu', 10, feishuCalls);

    const { scheduler, fire } = makeScheduler();
    installSchedulerHandler({
      heartbeatScheduler: scheduler,
      loop,
      channelLoops: registries.channelLoops,
      resolveChannelLoop,
      configCenter: makeConfigCenter(),
    } as Any);

    await fire(aiTask({ sessionId: 'sess-1' }));
    expect(feishuCalls).toHaveLength(1);
    expect(feishuCalls[0]).toEqual(['T1', 'sess-1']); // 推送模式：两参
  });

  it('本地默认渠道 → 仅通知（单参，不误入推送模式）', async () => {
    const { loop, calls } = makeLoop();
    const { resolveChannelLoop, registries } = setupChannelRegistries(loop, 'tui', makeConfigCenter());

    const { scheduler, fire } = makeScheduler();
    installSchedulerHandler({
      heartbeatScheduler: scheduler,
      loop,
      channelLoops: registries.channelLoops,
      resolveChannelLoop,
      configCenter: makeConfigCenter(),
    } as Any);

    await fire(aiTask({ sessionId: 'sess-2' }));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['T1']); // 通知模式：单参
  });
});

describe('反硬编码守卫：核心不得按渠道名路由', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  /**
   * 剥掉注释后再断言：守卫只针对**代码**。注释里引用历史反模式（如"曾经写死 xxx"）
   * 是有价值的文档，不该被守卫误伤。
   */
  const readCode = (rel: string): string =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // 行注释（避开 https:// 之类）

  it('runtime-wiring 不再按渠道名找 loop / 判推送，且统一走能力选择', () => {
    const src = readCode('src/gateway/runtime-wiring.ts');
    // 历史反模式，必须绝迹（注释里提到不算 —— 这里断言的是代码写法）
    expect(src).not.toContain("channelLoops.get('feishu')");
    expect(src).not.toContain("channelLoops.set('tui'");
    expect(src).not.toContain("usedChannel !== 'tui'");
    // 能力选择入口必须存在且被使用
    expect(src).toContain('export function findPersistentChannelLoop(');
    expect(src).toContain('findPersistentChannelLoop(channelLoops)');
  });

  it('本地主 loop 通过能力登记（localDefault），而非写死渠道名', () => {
    const src = read('src/gateway/runtime-wiring.ts');
    expect(src).toContain('capabilities: { localDefault: true }');
    expect(src).toContain("const localChannelName = channel ?? 'local'");
  });

  it('CLI 声明 --channel 并把渠道透传给 createAgent（含前缀注册）', () => {
    const src = read('src/gateway/cli.ts');
    expect(src).toContain(".option('--channel <id>'");
    expect(src).toContain('channel: cliChannel,');
    expect(src).toContain('registerChannelPrefixes(`${cliChannel}_`, cliChannel)');
  });
});
