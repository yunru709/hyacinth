// ============================================================
// ManifestLoader 测试 — 上下文清单加载器
// ============================================================
// 用真实临时文件系统驱动（mock homedir → 临时目录，因为 P-Config 收敛后
// ManifestLoader 只读全局 ~/.agent/context-manifest.json），覆盖：
//  1. load()：文件缺失 → 生成默认值并落盘；合法文件 → 读取
//  2. load()：JSON 语法错误 → 降级默认值；版本不支持 → 抛错
//  3. 查询：getZone / getEnabledZones（按序过滤）/ getSections（按优先级）/ isZoneEnabled
//  4. setZoneEnabled：内存即时生效 + 落盘（新 loader 可读回）；zone 不存在 → 报错不落盘
//  5. reload()：文件变更后重新读取
// ============================================================

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManifestLoader } from './manifest-loader.js';
import { DEFAULT_CONTEXT_MANIFEST } from './manifest-defaults.js';

const tmpDirs: string[] = [];
let homeDir: string;

const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn(() => homeDir) }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-loader-home-'));
  tmpDirs.push(homeDir);
});

function tmpCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-loader-'));
  tmpDirs.push(dir);
  return dir;
}

function manifestPath(): string {
  return path.join(homeDir, '.agent', 'context-manifest.json');
}

function writeManifest(content: string): void {
  fs.mkdirSync(path.join(homeDir, '.agent'), { recursive: true });
  fs.writeFileSync(manifestPath(), content, 'utf-8');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe('load()：加载与兜底', () => {
  it('文件缺失 → 生成默认 manifest 并落盘', () => {
    const cwd = tmpCwd();
    const loader = new ManifestLoader(cwd);
    const m = loader.load();

    expect(m.version).toBe(1);
    expect(m.zones.zone1.enabled).toBe(true);
    expect(fs.existsSync(manifestPath())).toBe(true);
  });

  it('合法文件 → 读取全局覆盖', () => {
    const cwd = tmpCwd();
    writeManifest(JSON.stringify({
      version: 1,
      zones: {
        zone1: { name: 'Override', order: 1, enabled: false, sections: [{ name: 's1', source: 'x', priority: 0, type: 'static' }] },
      },
    }));

    const loader = new ManifestLoader(cwd);
    const m = loader.load();
    expect(m.zones.zone1.name).toBe('Override');
    expect(m.zones.zone1.enabled).toBe(false);
  });

  it('JSON 语法错误 → 降级默认值（不抛错）', () => {
    const cwd = tmpCwd();
    writeManifest('{ broken json');

    const loader = new ManifestLoader(cwd);
    const m = loader.load();
    expect(m.version).toBe(1);
    expect(m.zones.zone1).toBeDefined();
  });

  it('版本不支持 → 抛错', () => {
    const cwd = tmpCwd();
    writeManifest(JSON.stringify({ version: 2, zones: {} }));

    const loader = new ManifestLoader(cwd);
    expect(() => loader.load()).toThrow(/Unsupported manifest version/);
  });

  it('zone 缺少 enabled 布尔 → 抛错', () => {
    const cwd = tmpCwd();
    writeManifest(JSON.stringify({ version: 1, zones: { zone1: { name: 'X', order: 1, sections: [] } } }));

    const loader = new ManifestLoader(cwd);
    expect(() => loader.load()).toThrow(/missing "enabled" boolean/);
  });
});

describe('查询接口', () => {
  it('getZone 返回指定 zone；不存在 → undefined', () => {
    const loader = new ManifestLoader(tmpCwd());
    expect(loader.getZone('zone1')?.name).toBe('Anchor');
    expect(loader.getZone('nope')).toBeUndefined();
  });

  it('getEnabledZones 只返回 enabled 且按 order 排序', () => {
    const loader = new ManifestLoader(tmpCwd());
    const zones = loader.getEnabledZones();
    expect(zones.map(([name]) => name)).toEqual(['zone1', 'zone3', 'zone4', 'zone5']);
    expect(zones.map(([, z]) => z.order)).toEqual([1, 3, 4, 5]);
  });

  it('getSections 按 priority 排序返回；zone 不存在 → 空数组', () => {
    const loader = new ManifestLoader(tmpCwd());
    const sections = loader.getSections('zone5');
    expect(sections.map((s) => s.priority)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(loader.getSections('nope')).toEqual([]);
  });

  it('isZoneEnabled 反映 zone 开关；不存在 → false', () => {
    const loader = new ManifestLoader(tmpCwd());
    expect(loader.isZoneEnabled('zone1')).toBe(true);
    expect(loader.isZoneEnabled('zone2')).toBe(false);
    expect(loader.isZoneEnabled('nope')).toBe(false);
  });
});

describe('setZoneEnabled：写入开关', () => {
  it('开关生效于内存且落盘，新 loader 可读回', () => {
    const cwd = tmpCwd();
    const loader = new ManifestLoader(cwd);
    loader.load();

    loader.setZoneEnabled('zone1', false);
    expect(loader.isZoneEnabled('zone1')).toBe(false);

    // 新实例（未缓存）从磁盘读回
    const fresh = new ManifestLoader(cwd);
    expect(fresh.isZoneEnabled('zone1')).toBe(false);
    expect(fresh.isZoneEnabled('zone5')).toBe(true);
  });

  it('开启默认关闭的 zone（zone2）', () => {
    const cwd = tmpCwd();
    const loader = new ManifestLoader(cwd);
    loader.setZoneEnabled('zone2', true);

    expect(loader.isZoneEnabled('zone2')).toBe(true);
    expect(new ManifestLoader(cwd).isZoneEnabled('zone2')).toBe(true);
  });

  it('zone 不存在 → 报错且不落盘', () => {
    const cwd = tmpCwd();
    const loader = new ManifestLoader(cwd);
    loader.load(); // 先生成默认文件
    const before = fs.readFileSync(manifestPath(), 'utf-8');

    expect(() => loader.setZoneEnabled('nope', true)).toThrow(/not found/);

    // 落盘内容不变
    expect(fs.readFileSync(manifestPath(), 'utf-8')).toBe(before);
  });
});

describe('reload()：重新读取磁盘', () => {
  it('外部修改文件后 reload 拾取变更', () => {
    const cwd = tmpCwd();
    const loader = new ManifestLoader(cwd);
    expect(loader.isZoneEnabled('zone1')).toBe(true);

    // 模拟外部进程直接改磁盘文件（不经过 loader，避免动到内存缓存引用）
    const onDisk = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    onDisk.zones.zone1.enabled = false;
    fs.writeFileSync(manifestPath(), JSON.stringify(onDisk, null, 2), 'utf-8');

    expect(loader.isZoneEnabled('zone1')).toBe(true); // 未 reload 仍是缓存
    loader.reload();
    expect(loader.isZoneEnabled('zone1')).toBe(false);
  });
});

describe('默认值一致性', () => {
  it('缺失文件生成的默认值结构与 manifest-defaults 一致', () => {
    const loader = new ManifestLoader(tmpCwd());
    const m = loader.load();
    expect(m).toEqual(DEFAULT_CONTEXT_MANIFEST);
  });
});
