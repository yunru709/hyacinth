import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { stageRelease, smokeTestRelease, findExtractedDir } from './install.js';
import { releaseDir } from './releases.js';

const mockExecSync = vi.mocked(execSync);

let install: string;
let extracted: string;

function touch(p: string, content = '') {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'stage-test-'));
  extracted = mkdtempSync(join(tmpdir(), 'stage-src-'));
  mockExecSync.mockReset();
});

afterEach(() => {
  rmSync(install, { recursive: true, force: true });
  rmSync(extracted, { recursive: true, force: true });
});

function makeSrc(pkg: Record<string, unknown>, distFiles: Record<string, string>) {
  mkdirSync(join(extracted, 'dist'), { recursive: true });
  writeFileSync(join(extracted, 'package.json'), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(distFiles)) {
    touch(join(extracted, 'dist', rel), content);
  }
}

describe('stageRelease', () => {
  it('新版本落盘 releases/<version>/，installDir/dist 不动（旧安装零触碰）', () => {
    // 旧安装：扁平 dist + package.json
    touch(join(install, 'dist', 'index.js'), 'old');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56', dependencies: {} }));
    // 新版本
    makeSrc({ version: '0.9.57', dependencies: {} }, { 'index.js': 'new' });

    const res = stageRelease(extracted, install, {
      currentVersion: '0.9.56',
      onStatus: () => {},
    });

    expect(res).toEqual({ version: '0.9.57', depChanged: false });
    // 新版本在 releases/v0.9.57/
    expect(readFileSync(join(releaseDir(install, '0.9.57'), 'dist', 'index.js'), 'utf-8')).toBe('new');
    // 首迁基线在 releases/v0.9.56/
    expect(readFileSync(join(releaseDir(install, '0.9.56'), 'dist', 'index.js'), 'utf-8')).toBe('old');
    // installDir/dist 保持原样
    expect(readFileSync(join(install, 'dist', 'index.js'), 'utf-8')).toBe('old');
    // 依赖无变化 → 不触发 pnpm install
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('依赖变化 → 在版本目录内触发 install', () => {
    touch(join(install, 'dist', 'index.js'), 'old');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56', dependencies: { a: '1' } }));
    makeSrc({ version: '0.9.57', dependencies: { b: '2' } }, { 'index.js': 'new' });

    stageRelease(extracted, install, { currentVersion: '0.9.56', onStatus: () => {} });

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync.mock.calls[0]![0]).toContain('pnpm install');
    // cwd 是版本目录（新依赖只进版本目录，不碰共享 node_modules）
    expect(mockExecSync.mock.calls[0]![1]).toMatchObject({ cwd: releaseDir(install, '0.9.57') });
  });

  it('依赖安装失败 → 恢复 installDir/package.json 为重装旧依赖自愈 → 抛错', () => {
    touch(join(install, 'dist', 'index.js'), 'old');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56', dependencies: { a: '1' } }));
    makeSrc({ version: '0.9.57', dependencies: { b: '2' } }, { 'index.js': 'new' });

    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('install failed');
      })
      .mockImplementationOnce(() => undefined as unknown as ReturnType<typeof execSync>); // 旧依赖重装自愈成功

    expect(() =>
      stageRelease(extracted, install, { currentVersion: '0.9.56', onStatus: () => {} }),
    ).toThrow('install failed');

    // installDir/package.json 已恢复为旧版本依赖
    const restored = JSON.parse(readFileSync(join(install, 'package.json'), 'utf-8'));
    expect(restored.dependencies).toEqual({ a: '1' });
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync.mock.calls[1]![1]).toMatchObject({ cwd: install });
  });

  it('缺少 dist/ 或 package.json → 抛错且不产生版本目录', () => {
    makeSrc({ version: '0.9.57' }, {});
    rmSync(join(extracted, 'dist'), { recursive: true, force: true });

    expect(() =>
      stageRelease(extracted, install, { currentVersion: '0.9.56', onStatus: () => {} }),
    ).toThrow('缺少 dist/');
    expect(existsSync(releaseDir(install, '0.9.57'))).toBe(false);
  });
});

describe('smokeTestRelease', () => {
  it('真 spawn：入口可加载且输出版本号 → true', () => {
    const ver = '9.9.9';
    // 模拟真实入口：--version 时打印版本号（真实 cli 由 argv[1] 读 package.json 版本）
    const entry = join(releaseDir(install, ver), 'dist', 'index.js');
    touch(entry, `console.log('${ver}');`);
    touch(join(releaseDir(install, ver), 'package.json'), JSON.stringify({ version: ver }));

    expect(smokeTestRelease(install, ver)).toBe(true);
  });

  it('缺 dist/index.js → false', () => {
    expect(smokeTestRelease(install, '9.9.9')).toBe(false);
  });

  it('入口退出非 0 → false', () => {
    const ver = '9.9.9';
    const entry = join(releaseDir(install, ver), 'dist', 'index.js');
    touch(entry, `process.exit(1);`);
    expect(smokeTestRelease(install, ver)).toBe(false);
  });
});

describe('findExtractedDir', () => {
  it('单子目录解压 → 定位子目录；多条目 → 返回 tmpDir', () => {
    const sub = join(extracted, 'hyacinth-0.9.57');
    mkdirSync(sub, { recursive: true });
    expect(findExtractedDir(extracted)).toBe(sub);

    touch(join(extracted, 'extra.txt'));
    expect(findExtractedDir(extracted)).toBe(extracted);
  });
});
