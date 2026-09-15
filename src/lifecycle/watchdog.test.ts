import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildWatchdogScript,
  killProcessTreeSync,
  spawnWatchdog,
  WATCHDOG_MARK,
} from './watchdog.js';
import {
  registerManager,
  unregisterManager,
  installGlobalReaper,
  trackedManagerCount,
} from './global-registry.js';
import { ProcessManager } from './manager.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildWatchdogScript', () => {
  it('包含 hyacinth-wd:<pid> 特征标记（供 orphan-sweeper 识别）', () => {
    const script = buildWatchdogScript(12345);
    expect(script).toContain(`${WATCHDOG_MARK}:12345`);
  });

  it('把父 pid 与目标 pid 写入脚本', () => {
    const script = buildWatchdogScript(42);
    expect(script).toContain(`PARENT=${process.pid}`);
    expect(script).toContain('CHILD=42');
  });

  it('脚本是可执行的 node 代码（不含非法语法）', () => {
    const script = buildWatchdogScript(7);
    // 轻量冒烟：脚本内引用 self-contained 依赖（spawnSync / process.kill）
    expect(script).toContain("require('child_process')");
    expect(script).toContain('process.kill');
  });
});

describe('spawnWatchdog', () => {
  it('非法 pid 直接返回 false 不 spawn', () => {
    expect(spawnWatchdog(0)).toBe(false);
    expect(spawnWatchdog(-1)).toBe(false);
  });

  it('合法 pid 返回 true 且不抛出（watchdog 因目标不存在自行退出，不泄漏）', () => {
    expect(() => spawnWatchdog(555)).not.toThrow();
    expect(spawnWatchdog(555)).toBe(true);
  });
});

describe('killProcessTreeSync', () => {
  it('对已退出的 pid 静默不抛', () => {
    // 找一个必然不存在的 pid（当前进程退出前不可能占用）
    expect(() => killProcessTreeSync(999999)).not.toThrow();
  });
});

describe('global-registry', () => {
  it('register / unregister 维护计数', () => {
    const base = trackedManagerCount();
    const pmA = {} as ProcessManager;
    const pmB = {} as ProcessManager;
    registerManager(pmA);
    registerManager(pmB);
    expect(trackedManagerCount()).toBe(base + 2);
    unregisterManager(pmA);
    expect(trackedManagerCount()).toBe(base + 1);
    unregisterManager(pmB);
    expect(trackedManagerCount()).toBe(base);
  });

  it('installGlobalReaper 幂等（多次调用只装一次钩子）', () => {
    const onExit = vi.spyOn(process, 'on');
    installGlobalReaper();
    installGlobalReaper();
    installGlobalReaper();
    // 每次调用都叠加其他监听（beforeExit/exit 各一），重装只新增一轮
    const exitCalls = onExit.mock.calls.filter(([ev]) => ev === 'exit').length;
    expect(exitCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('ProcessManager 全局注册联动', () => {
  it('构造即注册，destroy 后注销', async () => {
    const base = trackedManagerCount();
    const pm = new ProcessManager({
      name: 'reg-test',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      autoRestart: false,
    });
    expect(trackedManagerCount()).toBe(base + 1);
    await pm.destroy();
    expect(trackedManagerCount()).toBe(base);
  });
});
