/**
 * ui_region probe 单测（2026-10-29）
 *
 * ⚠️ 关键约束：这里**绝不能**让 probe 走到默认的 PowerShell 采样器 ——
 * 那会真的截取当前屏幕（慢、且与被测逻辑无关）。所以每个用例都先注入
 * 假采样器，结束后用 afterEach 重置，避免污染其它测试文件。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { dhashFromGray } from './region-sampler-ps.js';
import {
  hammingDistanceHex,
  setDefaultRegionSampler,
  setDefaultWindowSampler,
  uiRegionProbe,
} from './ui-region.js';

afterEach(() => {
  setDefaultRegionSampler(null);
  setDefaultWindowSampler(null);
});

describe('hammingDistanceHex', () => {
  it('相同指纹距离为 0', () => {
    expect(hammingDistanceHex('0123456789abcdef', '0123456789abcdef')).toBe(0);
  });

  it('全异指纹距离为 64', () => {
    expect(hammingDistanceHex('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('单 bit 差异为 1', () => {
    expect(hammingDistanceHex('0000000000000000', '0000000000000001')).toBe(1);
  });

  it('格式不合法时退化为 0/64，而不是静默 0', () => {
    expect(hammingDistanceHex('short', 'also-short')).toBe(64);
    expect(hammingDistanceHex('bad', 'bad')).toBe(0);
  });
});

describe('dhashFromGray', () => {
  it('9x8 共 72 个灰度值 → 16 位十六进制', () => {
    const pixels = Array.from({ length: 72 }, (_, i) => (i % 2 === 0 ? 255 : 0));
    const hash = dhashFromGray(pixels);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('像素数量不对时报错', () => {
    expect(() => dhashFromGray([1, 2, 3])).toThrow(/72/);
  });

  it('纯色图与条纹图可区分', () => {
    const flat = dhashFromGray(Array.from({ length: 72 }, () => 128));
    const striped = dhashFromGray(Array.from({ length: 72 }, (_, i) => (i % 2 === 0 ? 255 : 0)));
    expect(hammingDistanceHex(flat, striped)).toBeGreaterThan(0);
  });
});

describe('ui_region probe', () => {
  it('注入的采样器被调用，且指纹变化时距离正确', async () => {
    let value = '0000000000000000';
    setDefaultRegionSampler(async () => value);

    const probe = uiRegionProbe.create({ kind: 'ui_region', region: [0, 0, 100, 100] });
    const first = await probe.sample();
    expect(first.ok).toBe(true);
    expect(first.value).toBe('0000000000000000');

    value = '000000000000000f'; // 低 4 位不同
    const second = await probe.sample();

    const distance = probe.distance!(first, second);
    expect(distance).toBe(4);
  });

  it('采样器抛错时返回 ok=false，不抛给调用方', async () => {
    setDefaultRegionSampler(async () => {
      throw new Error('capture exploded');
    });
    const probe = uiRegionProbe.create({ kind: 'ui_region' });
    const sample = await probe.sample();
    expect(sample.ok).toBe(false);
    expect(sample.error).toMatch(/capture exploded/);
  });

  it('region 支持整屏省略', async () => {
    let calledWith: unknown = 'not-called';
    setDefaultRegionSampler(async (region) => {
      calledWith = region;
      return 'ffffffffffffffff';
    });
    const probe = uiRegionProbe.create({ kind: 'ui_region' });
    await probe.sample();
    expect(calledWith).toBeUndefined();
  });

  it('region 参数非法时 create 直接抛错', () => {
    expect(() => uiRegionProbe.create({ kind: 'ui_region', region: [0, 0, 10] } as never)).toThrow(/4/);
    expect(() => uiRegionProbe.create({ kind: 'ui_region', region: [100, 100, 10, 10] })).toThrow(/right > left/);
    expect(() => uiRegionProbe.create({ kind: 'ui_region', threshold: 99 })).toThrow(/0\.\.64/);
  });
});

describe('ui_region probe — windowTitle（WGC 窗口采样）', () => {
  it('windowTitle 给了就走窗口采样器，且忽略 region', async () => {
    let seenTitle: string | undefined;
    setDefaultWindowSampler(async (title) => {
      seenTitle = title;
      return 'abcdef0123456789';
    });
    setDefaultRegionSampler(async () => {
      throw new Error('region sampler should NOT be called when windowTitle set');
    });

    const probe = uiRegionProbe.create({
      kind: 'ui_region',
      windowTitle: 'My Window',
      region: [0, 0, 10, 10],
    });
    const sample = await probe.sample();
    expect(sample.ok).toBe(true);
    expect(sample.value).toBe('abcdef0123456789');
    expect(seenTitle).toBe('My Window');
  });

  it('没有 windowTitle 时仍走区域采样器', async () => {
    let regionCalled = false;
    setDefaultRegionSampler(async () => {
      regionCalled = true;
      return '0000000000000000';
    });
    setDefaultWindowSampler(async () => {
      throw new Error('window sampler should NOT be called without windowTitle');
    });
    const probe = uiRegionProbe.create({ kind: 'ui_region', region: [0, 0, 100, 100] });
    const sample = await probe.sample();
    expect(sample.ok).toBe(true);
    expect(regionCalled).toBe(true);
  });

  it('窗口采样器抛错 → ok=false，不抛给调用方', async () => {
    setDefaultWindowSampler(async () => {
      throw new Error('wgc exploded');
    });
    const probe = uiRegionProbe.create({ kind: 'ui_region', windowTitle: 'Whatever' });
    const sample = await probe.sample();
    expect(sample.ok).toBe(false);
    expect(sample.error).toMatch(/wgc exploded/);
  });

  it('windowTitle 变化时 distance 按汉明距离', async () => {
    let value = '0000000000000000';
    setDefaultWindowSampler(async () => value);
    const probe = uiRegionProbe.create({ kind: 'ui_region', windowTitle: 'W' });
    const first = await probe.sample();
    value = '00000000000000ff';
    const second = await probe.sample();
    expect(probe.distance!(first, second)).toBe(8);
  });
});
