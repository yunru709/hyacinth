import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveBootstrapEntry } from './bootstrap.js';

let install: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'bootstrap-test-'));
});

afterEach(() => {
  rmSync(install, { recursive: true, force: true });
});

function writePointer(version: string) {
  mkdirSync(join(install, 'releases'), { recursive: true });
  writeFileSync(join(install, 'releases', 'current.json'), JSON.stringify({ version, lastGood: version }));
}

describe('resolveBootstrapEntry', () => {
  it('有效指针 → 返回 releases/v<version>/dist/index.js', () => {
    writePointer('0.9.57');
    mkdirSync(join(install, 'releases', 'v0.9.57', 'dist'), { recursive: true });
    writeFileSync(join(install, 'releases', 'v0.9.57', 'dist', 'index.js'), '');
    expect(resolveBootstrapEntry(install)).toBe(join(install, 'releases', 'v0.9.57', 'dist', 'index.js'));
  });

  it('无 releases/current.json（首次部署/扁平布局）→ null', () => {
    expect(resolveBootstrapEntry(install)).toBeNull();
  });

  it('指针指向的版本目录缺失 → null（fallback 扁平入口）', () => {
    writePointer('9.9.9');
    expect(resolveBootstrapEntry(install)).toBeNull();
  });

  it('损坏 JSON → null', () => {
    mkdirSync(join(install, 'releases'), { recursive: true });
    writeFileSync(join(install, 'releases', 'current.json'), '{ not json');
    expect(resolveBootstrapEntry(install)).toBeNull();
  });
});
