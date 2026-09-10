import { describe, it, expect, afterEach } from 'vitest';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { injectHotReloadConfigCenter, getHotReloadConfig, pollIntervalMs } from './hot-reload-config.js';

function stubConfigCenter(values: Record<string, unknown>): RuntimeConfigCenter {
  return {
    get: (path: string) => values[path],
  } as unknown as RuntimeConfigCenter;
}

afterEach(() => {
  injectHotReloadConfigCenter(null);
});

describe('hotReload 配置出口', () => {
  it('未注入时回退默认值（5s）', () => {
    expect(pollIntervalMs()).toBe(5000);
    expect(getHotReloadConfig('debounceMs', 500)).toBe(500);
  });

  it('注入后读取 hotReload.pollIntervalMs', () => {
    injectHotReloadConfigCenter(
      stubConfigCenter({ 'hotReload.pollIntervalMs': 2000, 'hotReload.debounceMs': 300 }),
    );
    expect(pollIntervalMs()).toBe(2000);
    expect(getHotReloadConfig('debounceMs', 500)).toBe(300);
  });

  it('未配置的键回退默认值', () => {
    injectHotReloadConfigCenter(stubConfigCenter({ 'hotReload.pollIntervalMs': 2000 }));
    expect(getHotReloadConfig('watchMcp', true)).toBe(true);
  });
});

describe('watcher-base poll 模式间隔走配置（回归闸）', () => {
  it('spec 未传 pollIntervalMs 时使用 hotReload.pollIntervalMs', async () => {
    const { createWatcher } = await import('./watcher-base.js');
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'hrcfg-'));
    const file = join(dir, 'conf.json');
    await writeFile(file, '{"v":1}');

    // 注入短轮询间隔（100ms）→ 应能在短时间内触发 reload
    injectHotReloadConfigCenter(
      stubConfigCenter({ 'hotReload.pollIntervalMs': 100 }),
    );
    let reloaded = false;
    const handles = createWatcher({
      name: 'cfg-test',
      mode: 'poll',
      paths: () => [file],
      reload: () => {
        reloaded = true;
      },
    });

    // 等一个轮询周期再改文件
    await new Promise((r) => setTimeout(r, 150));
    await writeFile(file, '{"v":2}');
    await new Promise((r) => setTimeout(r, 250));

    for (const h of handles) h.close();
    expect(reloaded).toBe(true);
  });
});
