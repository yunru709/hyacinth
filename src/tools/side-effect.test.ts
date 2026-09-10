import { describe, it, expect } from 'vitest';
import {
  sideEffectOf,
  isWriteTool,
  isExecTool,
  isMutatingTool,
  deriveDangerousTools,
  LEGACY_SIDE_EFFECT,
} from './side-effect.js';

describe('side-effect', () => {
  it('legacy 表覆盖全部内置写/执行工具', () => {
    expect(sideEffectOf('write')).toBe('write');
    expect(sideEffectOf('edit')).toBe('write');
    expect(sideEffectOf('multi_edit')).toBe('write');
    expect(sideEffectOf('insert')).toBe('write');
    expect(sideEffectOf('json_edit')).toBe('write');
    expect(sideEffectOf('delete')).toBe('write');
    expect(sideEffectOf('bash')).toBe('exec');
    expect(sideEffectOf('git_tool')).toBe('exec');
    expect(sideEffectOf('db_query')).toBe('exec');
    expect(sideEffectOf('process')).toBe('exec');
  });

  it('未知/只读工具默认 read（与旧行为一致：不在危险名单 → 自动放行）', () => {
    expect(sideEffectOf('read')).toBe('read');
    expect(sideEffectOf('grep')).toBe('read');
    expect(sideEffectOf('glob')).toBe('read');
    expect(sideEffectOf('mcp__server__anything')).toBe('read');
    expect(sideEffectOf('unknown_tool')).toBe('read');
  });

  it('声明优先于旧表', () => {
    expect(sideEffectOf('edit', 'exec')).toBe('exec');
    expect(sideEffectOf('bash', 'read')).toBe('read');
    expect(isMutatingTool('edit', 'read')).toBe(false);
  });

  it('isWriteTool / isExecTool / isMutatingTool 语义', () => {
    expect(isWriteTool('edit')).toBe(true);
    expect(isWriteTool('bash')).toBe(false);
    expect(isExecTool('bash')).toBe(true);
    expect(isMutatingTool('edit')).toBe(true);
    expect(isMutatingTool('bash')).toBe(true);
    expect(isMutatingTool('read')).toBe(false);
  });

  it('deriveDangerousTools 含全部 legacy 非只读工具，不含只读', () => {
    const names = deriveDangerousTools();
    expect(names).toContain('edit');
    expect(names).toContain('multi_edit');
    expect(names).toContain('bash');
    expect(names).toContain('json_edit');
    expect(names).not.toContain('read');
    expect(names).not.toContain('grep');
  });

  it('deriveDangerousTools 纳入注册表声明的 write/exec 工具', () => {
    const names = deriveDangerousTools(() => [
      { name: 'plugin_write', sideEffect: 'write' as const },
      { name: 'plugin_exec', sideEffect: 'exec' as const },
      { name: 'plugin_read', sideEffect: 'read' as const },
      { name: 'no_declare' },
    ]);
    expect(names).toContain('plugin_write');
    expect(names).toContain('plugin_exec');
    expect(names).not.toContain('plugin_read');
    expect(names).not.toContain('no_declare');
  });

  it('legacy 表不含 read 条目（read 一律由兜底返回）', () => {
    for (const effect of Object.values(LEGACY_SIDE_EFFECT)) {
      expect(effect).not.toBe('read');
    }
  });
});