import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveInstallRoot,
  readPointer,
  writePointerAtomic,
  listReleases,
  pruneReleases,
  migrateLegacyDist,
  releasesDir,
  pointerPath,
  releaseDir,
} from './releases.js';

let install: string;
let prevCleanup: (() => void) | null = null;

function cleanup() {
  try {
    rmSync(install, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function touchDir(p: string) {
  mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'releases-test-'));
  prevCleanup = cleanup;
});

afterEach(() => {
  prevCleanup?.();
});

describe('resolveInstallRoot', () => {
  it('从 <install>/dist/<entry> 解析出安装根', () => {
    expect(resolveInstallRoot(join(install, 'dist', 'index.js'))).toBe(install);
    expect(resolveInstallRoot(join(install, 'dist', 'bootstrap.js'))).toBe(install);
  });
});

describe('指针读写', () => {
  it('roundtrip：写入后读回一致', () => {
    writePointerAtomic(install, { version: '1.2.3', lastGood: '1.2.2' });
    expect(readPointer(install)).toEqual({ version: '1.2.3', lastGood: '1.2.2' });
  });

  it('指针文件不存在 → null', () => {
    expect(readPointer(install)).toBeNull();
  });

  it('损坏 JSON → null', () => {
    touchDir(releasesDir(install));
    writeFileSync(pointerPath(install), '{ not json');
    expect(readPointer(install)).toBeNull();
  });

  it('缺字段 → null', () => {
    touchDir(releasesDir(install));
    writeFileSync(pointerPath(install), JSON.stringify({ version: '1.0.0' }));
    expect(readPointer(install)).toBeNull();
  });
});

describe('listReleases / pruneReleases', () => {
  it('只列出 v 前缀版本目录', () => {
    touchDir(releaseDir(install, '0.9.56'));
    touchDir(releaseDir(install, '0.9.57'));
    touchDir(join(releasesDir(install), 'current.json'));
    touchDir(join(releasesDir(install), 'other'));
    expect(listReleases(install).sort()).toEqual(['v0.9.56', 'v0.9.57']);
  });

  it('prune 保留 keep 个且 exclude 永不清', () => {
    touchDir(releaseDir(install, '0.9.55'));
    touchDir(releaseDir(install, '0.9.56'));
    touchDir(releaseDir(install, '0.9.57'));
    touchDir(releaseDir(install, '1.0.0'));

    // keep=3：无需删除
    pruneReleases(install, 3, ['v0.9.55']);
    expect(listReleases(install).sort()).toEqual(['v0.9.55', 'v0.9.56', 'v0.9.57', 'v1.0.0']);

    // keep=2：删最旧的 v0.9.56（v0.9.55 被 exclude 保护）
    pruneReleases(install, 2, ['v0.9.55']);
    expect(listReleases(install).sort()).toEqual(['v0.9.55', 'v0.9.57', 'v1.0.0']);

    // keep=1：再删 v0.9.57，exclude 的 v0.9.55 仍保留
    pruneReleases(install, 1, ['v0.9.55']);
    expect(listReleases(install).sort()).toEqual(['v0.9.55', 'v1.0.0']);
  });
});

describe('migrateLegacyDist', () => {
  it('把现有 dist + package.json 复制为版本基线（releases/v<version>/）', () => {
    touchDir(join(install, 'dist'));
    writeFileSync(join(install, 'dist', 'index.js'), 'console.log("old")');
    writeFileSync(join(install, 'package.json'), JSON.stringify({ version: '0.9.56' }));

    migrateLegacyDist(install, '0.9.56');

    expect(readFileSync(releaseDir(install, '0.9.56') + '/dist/index.js', 'utf-8')).toBe('console.log("old")');
    expect(JSON.parse(readFileSync(releaseDir(install, '0.9.56') + '/package.json', 'utf-8')).version).toBe('0.9.56');
    // 运行中的旧安装不被移动，仅复制
    expect(readFileSync(join(install, 'dist', 'index.js'), 'utf-8')).toBe('console.log("old")');
  });

  it('幂等：目标已存在时跳过', () => {
    touchDir(releaseDir(install, '0.9.56'));
    writeFileSync(releaseDir(install, '0.9.56') + '/package.json', '{}');
    migrateLegacyDist(install, '0.9.56');
    expect(readFileSync(releaseDir(install, '0.9.56') + '/package.json', 'utf-8')).toBe('{}');
  });
});
