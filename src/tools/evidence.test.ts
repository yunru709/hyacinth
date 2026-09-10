/**
 * 验证证据判定（P1-B）单测。
 */
import { describe, it, expect } from 'vitest';
import { isVerificationEvidence } from './evidence.js';

describe('isVerificationEvidence', () => {
  it('非 bash 工具不构成验证证据（read/write/edit 是待验证对象，不是证据）', () => {
    expect(isVerificationEvidence('edit', { file_path: '/a.ts' })).toBe(false);
    expect(isVerificationEvidence('write', { file_path: '/a.ts' })).toBe(false);
    expect(isVerificationEvidence('read', { file_path: '/a.ts' })).toBe(false);
  });

  it('bash 验证类命令构成证据', () => {
    expect(isVerificationEvidence('bash', { command: 'npm test' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'pnpm test -- --run' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'pytest tests/test_x.py' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'cargo test' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'go test ./...' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'tsc --noEmit' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'npm run build' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'npm run lint' })).toBe(true);
    expect(isVerificationEvidence('bash', { command: 'eslint src/' })).toBe(true);
  });

  it('bash 非验证命令不构成证据', () => {
    expect(isVerificationEvidence('bash', { command: 'ls -la' })).toBe(false);
    expect(isVerificationEvidence('bash', { command: 'git status' })).toBe(false);
    expect(isVerificationEvidence('bash', { command: 'echo hello' })).toBe(false);
    expect(isVerificationEvidence('bash', { command: 'cat package.json' })).toBe(false);
  });

  it('缺 command / 非字符串不构成证据', () => {
    expect(isVerificationEvidence('bash', {})).toBe(false);
    expect(isVerificationEvidence('bash', { command: 123 })).toBe(false);
    expect(isVerificationEvidence('bash', undefined)).toBe(false);
  });
});
