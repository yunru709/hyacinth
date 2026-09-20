import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// mock homedir → 临时目录，避免污染真实 ~/.agent
const mockHome = mkdtempSync(join(tmpdir(), 'pending-test-'));
const pendingFile = join(mockHome, '.agent', UPDATE_PENDING_MARKER);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

import {
  writeUpdatePending,
  readUpdatePending,
  clearUpdatePending,
  UPDATE_PENDING_MARKER,
} from './protocol.js';

beforeEach(() => {
  mkdirSync(dirname(pendingFile), { recursive: true });
});

afterEach(() => {
  clearUpdatePending();
  rmSync(mockHome, { recursive: true, force: true });
});

describe('升级待定案标记（pending-update）', () => {
  it('roundtrip：写入后读回一致', () => {
    writeUpdatePending({ version: '1.2.3', lastGood: '1.2.2' });
    expect(readUpdatePending()).toEqual({ version: '1.2.3', lastGood: '1.2.2' });
  });

  it('无标记 → null', () => {
    expect(readUpdatePending()).toBeNull();
  });

  it('损坏 JSON → null', () => {
    writeFileSync(pendingFile, '{ not json');
    expect(readUpdatePending()).toBeNull();
  });

  it('缺字段 → null', () => {
    writeFileSync(pendingFile, JSON.stringify({ version: '1.0.0' }));
    expect(readUpdatePending()).toBeNull();
  });

  it('clear 删除标记', () => {
    writeUpdatePending({ version: '1.2.3', lastGood: '1.2.2' });
    expect(clearUpdatePending()).toBe(true);
    expect(existsSync(pendingFile)).toBe(false);
    expect(readUpdatePending()).toBeNull();
  });
});
