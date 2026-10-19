import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { stageRelease, smokeTestRelease, findExtractedDir, ensureSelfBuildBaseline } from './install.js';
import { readPointer, releaseDir } from './releases.js';

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

    expect(res).toEqual({ version: '0.9.57', buildId: '0.9.57', depChanged: false });
    // 新版本在 releases/v0.9.57/
    expect(readFileSync(join(releaseDir(install, '0.9.57'), 'dist', 'index.js'), 'utf-8')).toBe('new');
    // 首迁基线在 releases/v0.9.56/
    expect(readFileSync(join(releaseDir(install, '0.9.56'), 'dist', 'index.js'), 'utf-8')).toBe('old');
    // installDir/dist 保持原样
    expect(readFileSync(join(install, 'dist', 'index.js'), 'utf-8')).toBe('old');
    // 依赖无变化 → 不触发 pnpm install
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('自构建唯一 buildId：不覆盖同 semver 的旧 release，并写 meta.json', () => {
    // 旧安装：扁平 dist + package.json（首迁移会复制成 releases/v0.9.56 基线）
    touch(join(install, 'dist', 'index.js'), 'old');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56', dependencies: {} }));
    // 新构建仍是 0.9.56，但 buildId 唯一
    makeSrc({ version: '0.9.56', dependencies: {} }, { 'index.js': 'new' });
    const buildId = '0.9.56-20261019T120000-abcdef12';

    const res = stageRelease(extracted, install, {
      currentVersion: '0.9.56',
      currentBuildId: '0.9.56',
      buildId,
      gitHead: 'abcdef123456',
      source: 'local-source',
      onStatus: () => {},
    });

    expect(res).toEqual({ version: '0.9.56', buildId, depChanged: false });
    // 新构建进唯一目录；旧基线 v0.9.56 仍是旧内容（回退目标没被覆盖）
    expect(readFileSync(join(releaseDir(install, buildId), 'dist', 'index.js'), 'utf-8')).toBe('new');
    expect(readFileSync(join(releaseDir(install, '0.9.56'), 'dist', 'index.js'), 'utf-8')).toBe('old');
    const meta = JSON.parse(readFileSync(join(releaseDir(install, buildId), 'meta.json'), 'utf-8'));
    expect(meta).toMatchObject({ version: '0.9.56', buildId, source: 'local-source' });
  });

  it('同 buildId 已存在 → 拒绝覆盖（release 目录不可变）', () => {
    touch(join(install, 'dist', 'index.js'), 'old');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56', dependencies: {} }));
    makeSrc({ version: '0.9.56', dependencies: {} }, { 'index.js': 'new' });
    const buildId = '0.9.56-existing';
    touch(join(releaseDir(install, buildId), 'dist', 'index.js'), 'keep-me');

    expect(() =>
      stageRelease(extracted, install, {
        currentVersion: '0.9.56',
        currentBuildId: '0.9.56',
        buildId,
        onStatus: () => {},
      }),
    ).toThrow(/release 已存在/);
    // 原内容未被覆盖
    expect(readFileSync(join(releaseDir(install, buildId), 'dist', 'index.js'), 'utf-8')).toBe('keep-me');
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

describe('ensureSelfBuildBaseline（编译前备份旧产物）', () => {
  it('扁平安装：先复制旧 dist 为 release，写指针，再把入口切到 bootstrap', () => {
    touch(join(install, 'dist', 'index.js'), 'old-index');
    touch(join(install, 'dist', 'bootstrap.js'), 'old-bootstrap');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56' }));

    const id = ensureSelfBuildBaseline(install, '0.9.56');

    expect(id).toBe('0.9.56');
    // 旧编译产物进 release（回退目标）
    expect(readFileSync(join(releaseDir(install, '0.9.56'), 'dist', 'index.js'), 'utf-8')).toBe('old-index');
    // 指针指向基线
    expect(readPointer(install)).toEqual({ version: '0.9.56', lastGood: '0.9.56' });
    // 扁平入口切到 bootstrap（下次重启走指针）
    expect(readFileSync(join(install, 'dist', 'index.js'), 'utf-8')).toBe('old-bootstrap');
  });

  it('已有指针：不重复写基线、不改变当前 release', () => {
    touch(join(install, 'dist', 'index.js'), 'old-index');
    touch(join(install, 'dist', 'bootstrap.js'), 'old-bootstrap');
    touch(join(install, 'package.json'), JSON.stringify({ version: '0.9.56' }));
    const first = ensureSelfBuildBaseline(install, '0.9.56');

    const second = ensureSelfBuildBaseline(install, '0.9.56');

    expect(second).toBe(first);
    expect(readPointer(install)?.version).toBe(first);
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

  it('buildId 与 semver 分离：目录用 buildId，输出校验 semver', () => {
    const buildId = '0.9.61-20261019T120000-abcdef12';
    const version = '0.9.61';
    const entry = join(releaseDir(install, buildId), 'dist', 'index.js');
    touch(entry, `console.log('${version}');`);

    expect(smokeTestRelease(install, buildId, version)).toBe(true);
    // 只给 buildId 时，输出里没有 buildId → false（防止调用方漏传 semver）
    expect(smokeTestRelease(install, buildId)).toBe(false);
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
