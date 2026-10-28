import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCompanionState,
  checkCompanionInvariants,
  pickExitNormalSession,
} from './companion-state.js';

let root: string;
let compCharDir: string;
let normalDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  compCharDir = path.join(root, 'companion', 'alice');
  normalDir = path.join(root, 'sessions', 'normal', 'tui_x');
  mkdirSync(compCharDir, { recursive: true });
  mkdirSync(normalDir, { recursive: true });
  writeFileSync(path.join(compCharDir, 'meta.json'), JSON.stringify({ type: 'companion' }));
  writeFileSync(path.join(normalDir, 'meta.json'), JSON.stringify({ type: 'normal' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveCompanionState', () => {
  it('companion session → mode companion，char 取 activeCompanionName', () => {
    const s = resolveCompanionState({ sessionDir: compCharDir, activeRouter: { name: 'companion', activeCompanionName: 'alice' } });
    expect(s.mode).toBe('companion');
    expect(s.character).toBe('alice');
  });
  it('companion session 无 activeCompanionName → 回退 session 目录名', () => {
    const s = resolveCompanionState({ sessionDir: compCharDir, activeRouter: { name: 'companion' } });
    expect(s.mode).toBe('companion');
    expect(s.character).toBe('alice');
  });
  it('normal session → mode normal，char 空', () => {
    const s = resolveCompanionState({ sessionDir: normalDir, activeRouter: { name: 'normal' } });
    expect(s.mode).toBe('normal');
    expect(s.character).toBe('');
  });
  it('meta 缺失 → 安全默认 normal（不炸）', () => {
    const emptyDir = path.join(root, 'sessions', 'normal', 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const s = resolveCompanionState({ sessionDir: emptyDir, activeRouter: { name: 'normal' } });
    expect(s.mode).toBe('normal');
  });
  it('pendingSessionDir 指向 companion → 视为 companion（切换未落地的有效态）', () => {
    const s = resolveCompanionState({ sessionDir: normalDir, pendingSessionDir: compCharDir, activeRouter: { name: 'companion', activeCompanionName: 'alice' } });
    expect(s.mode).toBe('companion');
    expect(s.character).toBe('alice');
  });
});

describe('checkCompanionInvariants', () => {
  it('一致的 companion 态 → 无违规', () => {
    const s = resolveCompanionState({
      sessionDir: compCharDir,
      activeRouter: { name: 'companion', activeCompanionName: 'alice' },
      bypassManager: { isActive: () => true },
    });
    expect(checkCompanionInvariants(s)).toEqual([]);
  });
  it('世界引擎在普通会话跑 → 报 I1', () => {
    const s = resolveCompanionState({
      sessionDir: normalDir,
      activeRouter: { name: 'normal' },
      bypassManager: { isActive: () => true },
    });
    expect(checkCompanionInvariants(s).map((v) => v.code)).toContain('I1_WORLD_WITHOUT_COMPANION');
  });
  it('router 与 session 不一致 → 报 I3', () => {
    const s = resolveCompanionState({ sessionDir: normalDir, activeRouter: { name: 'companion' } });
    expect(checkCompanionInvariants(s).map((v) => v.code)).toContain('I3_ROUTER_SESSION_MISMATCH');
  });
});

describe('pickExitNormalSession（确定性三级）', () => {
  it('内存有 → memory', () => {
    const s = resolveCompanionState({
      sessionDir: compCharDir,
      activeRouter: { name: 'companion', activeCompanionName: 'alice' },
      _normalSessionDir: normalDir,
    });
    expect(pickExitNormalSession(s, 'tui')).toEqual({ dir: normalDir, source: 'memory' });
  });
  it('内存无但持久化有 → persisted', () => {
    writeFileSync(path.join(root, 'companion', '.active-sessions.json'), JSON.stringify({ tui: normalDir }));
    const s = resolveCompanionState({ sessionDir: compCharDir, activeRouter: { name: 'companion', activeCompanionName: 'alice' } });
    expect(pickExitNormalSession(s, 'tui')).toEqual({ dir: normalDir, source: 'persisted' });
  });
  it('都没有 → none', () => {
    const s = resolveCompanionState({ sessionDir: compCharDir, activeRouter: { name: 'companion', activeCompanionName: 'alice' } });
    expect(pickExitNormalSession(s, 'tui')).toEqual({ dir: '', source: 'none' });
  });
});
