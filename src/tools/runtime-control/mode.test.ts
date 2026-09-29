/**
 * switch_mode —— 模式通用入口的契约。
 *
 * 锁三件事：
 *   ① `list` 只列**已注册**的模式（新模式注册后自动出现，工具不认识具体模式）
 *   ② `enter` 走统一编排；未注册的名字**报错并列出可用模式**（不静默）
 *   ③ `exit` = 回默认模式（null 语义 —— 工具自己不写死"回 normal" ✗）
 */
import { describe, it, expect } from 'vitest';
import { createSwitchModeTool } from './mode.js';
import { registerRouter } from '../../context/profiles.js';
import type { IContextRouter } from '../../context/router.js';
import type { AgentLoop } from '../../orchestrator/loop.js';

function registerMode(name: string, description?: string): void {
  registerRouter({
    name,
    description,
    toolAllowlist: [],
    toolBlacklist: [],
    skipSections: [],
    skipRuntimeSources: [],
    sourceOverrides: {},
    filterHistory: (h: unknown[]) => h,
    getTaskPrompt: () => '',
  } as unknown as IContextRouter);
}

function makeLoop(current: string, configDefault?: string) {
  const state = { name: current };
  const loop = {
    get activeRouter() {
      return { name: state.name };
    },
    async syncRouter(target?: string) {
      if (typeof target === 'string' && target) state.name = target;
    },
    getConfigValue: (k: string) => (k === 'startup.defaultMode' ? configDefault : undefined),
  };
  return { loop: loop as unknown as AgentLoop, state };
}

describe('switch_mode 工具', () => {
  it('list：列出已注册模式 ＋ 标注当前 ＋ 带上描述', async () => {
    registerMode('sw-list-a', '用于测试的模式 A');
    const { loop } = makeLoop('sw-list-a');

    const out = await createSwitchModeTool(loop).execute({ action: 'list' });
    expect(out).toContain('sw-list-a');
    expect(out).toContain('用于测试的模式 A');
    expect(out).toContain('← 当前');
  });

  it('enter：走统一编排切过去', async () => {
    registerMode('sw-enter-b');
    const { loop, state } = makeLoop('normal');

    const out = await createSwitchModeTool(loop).execute({ action: 'enter', mode: 'sw-enter-b' });
    expect(state.name).toBe('sw-enter-b');
    expect(out).toContain('已进入');
  });

  it('enter 未注册模式 → 报错并列出可用模式（不静默停在旧模式）', async () => {
    registerMode('sw-known-c');
    const { loop, state } = makeLoop('normal');

    const out = await createSwitchModeTool(loop).execute({ action: 'enter', mode: 'sw-nope-c' });
    expect(out).toContain('切换失败');
    expect(out).toContain('sw-known-c');
    expect(state.name).toBe('normal');
  });

  it('enter 缺 mode 参数 → 给引导，不抛错', async () => {
    const { loop } = makeLoop('normal');
    const out = await createSwitchModeTool(loop).execute({ action: 'enter' });
    expect(out).toContain('需要 mode 参数');
  });

  it('exit：回默认模式；配置 == 当前模式时走"自退出守卫"，不原地重进', async () => {
    registerMode('sw-exit-d');
    const { loop, state } = makeLoop('sw-exit-d', 'sw-exit-d');

    const out = await createSwitchModeTool(loop).execute({ action: 'exit' });
    expect(out).toContain('已退出');
    expect(state.name).toBe('normal');
  });

  it('未知 action → 返回可用动作，不抛错', async () => {
    const { loop } = makeLoop('normal');
    const out = await createSwitchModeTool(loop).execute({ action: 'nope' });
    expect(out).toContain('未知操作');
  });
});
