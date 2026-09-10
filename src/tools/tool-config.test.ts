import { describe, it, expect, afterEach } from 'vitest';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { injectToolConfigCenter, getToolConfig } from './tool-config.js';

function stubConfigCenter(values: Record<string, unknown>, throwOnGet = false): RuntimeConfigCenter {
  return {
    get: (path: string) => {
      if (throwOnGet) throw new Error('boom');
      return values[path];
    },
  } as unknown as RuntimeConfigCenter;
}

afterEach(() => {
  injectToolConfigCenter(null);
});

describe('getToolConfig', () => {
  it('未注入时回退硬编码默认值', () => {
    expect(getToolConfig('read.maxLines', 2000)).toBe(2000);
    expect(getToolConfig('bash.timeoutSec', 600)).toBe(600);
  });

  it('注入后读取 tools.* 配置', () => {
    injectToolConfigCenter(stubConfigCenter({ 'tools.read.maxLines': 500 }));
    expect(getToolConfig('read.maxLines', 2000)).toBe(500);
  });

  it('未配置的键回退默认值', () => {
    injectToolConfigCenter(stubConfigCenter({ 'tools.read.maxLines': 500 }));
    expect(getToolConfig('glob.maxResults', 1000)).toBe(1000);
  });

  it('configCenter.get 抛异常时回退默认值（不炸工具）', () => {
    injectToolConfigCenter(stubConfigCenter({}, true));
    expect(getToolConfig('db.maxRows', 200)).toBe(200);
  });
});

describe('内置工具读取 tools.* 配置（回归闸）', () => {
  it('ReadTool 尊重 tools.read.maxLines', async () => {
    const { ReadTool } = await import('./read.js');
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    // 造一个 30 行的文件，把 maxLines 配成 10 → 只返回 10 行
    const dir = await mkdtemp(join(tmpdir(), 'toolcfg-'));
    const file = join(dir, 'a.txt');
    await writeFile(file, Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n'));

    injectToolConfigCenter(stubConfigCenter({ 'tools.read.maxLines': 10 }));
    const out = await new ReadTool().execute({ file_path: file });
    // 输出带行号前缀（N→line-x），用 includes 统计
    expect(out.split('\n').filter((l) => l.includes('line-')).length).toBe(10);

    // 不注入 → 默认 2000 行上限，30 行全返回
    injectToolConfigCenter(null);
    const out2 = await new ReadTool().execute({ file_path: file });
    expect(out2.split('\n').filter((l) => l.includes('line-')).length).toBe(30);
  });
});
