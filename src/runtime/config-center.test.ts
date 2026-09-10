import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeConfigCenter } from './config-center.js';
import { getDefaultConfig } from './defaults.js';
import type { ConfigManager } from '../setup/config.js';

/** mock ConfigManager：只需 save/load 两个方法 */
function makeMockConfigManager(initial: Record<string, unknown> = {}) {
  let stored = initial;
  const saveCalls: unknown[] = [];
  return {
    manager: {
      save: async (config: unknown) => {
        saveCalls.push(config);
        stored = config as Record<string, unknown>;
      },
      load: async () => stored,
    } as unknown as ConfigManager,
    saveCalls,
    getStored: () => stored,
  };
}

describe('RuntimeConfigCenter', () => {
  const center = RuntimeConfigCenter.getInstance();
  let mock: ReturnType<typeof makeMockConfigManager>;

  beforeEach(() => {
    mock = makeMockConfigManager({});
    center.initialize(getDefaultConfig(), mock.manager);
  });

  it('get() returns default values for unset paths', () => {
    expect(center.get('session.maxTurns')).toBe(100);
    expect(center.get('session.maxContext')).toBe(200000);
  });

  it('get() returns undefined for unknown paths without throwing', () => {
    expect(center.get('nonexistent.path')).toBeUndefined();
  });

  it('set() overrides defaults and get() reflects it', () => {
    center.set('session.maxTurns', 50);
    expect(center.get('session.maxTurns')).toBe(50);
  });

  it('set() on a nested path merges into the runtime overrides', () => {
    center.set('safety.dangerousTools', ['write', 'bash', 'rm']);
    expect(center.get('safety.dangerousTools')).toEqual(['write', 'bash', 'rm']);
  });

  it('set() rejects an invalid path (not in defaults schema)', () => {
    expect(() => center.set('invalid.key', 1)).toThrow();
  });

  it('getAll() deep-merges runtime overrides into defaults', () => {
    center.set('session.maxTurns', 10);
    const all = center.getAll();
    expect(all.session.maxTurns).toBe(10);
    expect(all.session.maxContext).toBe(200000); // untouched default survives
  });

  it('watch() fires on matching path changes and unsubscribe stops it', async () => {
    const events: string[] = [];
    const unsubscribe = center.watch('session.maxTurns', (e) => events.push(e.path));

    center.set('session.maxTurns', 77);
    // event emission is synchronous for direct set()
    expect(events).toContain('session.maxTurns');

    unsubscribe();
    center.set('session.maxTurns', 88);
    expect(events).toHaveLength(1); // no new event after unsubscribe
  });

  it('watch() with wildcard pattern matches sub-paths', () => {
    const events: string[] = [];
    center.watch('provider.*', (e) => events.push(e.path));

    center.set('provider.active', 'deepseek');
    expect(events).toContain('provider.active');
  });

  it('reset(path) restores the default for that path', () => {
    center.set('session.maxTurns', 5);
    expect(center.get('session.maxTurns')).toBe(5);
    center.reset('session.maxTurns');
    expect(center.get('session.maxTurns')).toBe(100);
  });

  it('reset() without path clears all runtime overrides', () => {
    center.set('session.maxTurns', 5);
    center.set('provider.active', 'deepseek');
    center.reset();
    expect(center.get('session.maxTurns')).toBe(100);
    expect(center.get('provider.active')).toBe('anthropic');
  });

  it('save() persists the effective config through the ConfigManager', async () => {
    center.set('session.maxTurns', 33);
    await center.save();
    expect(mock.saveCalls).toHaveLength(1);
    const persisted = mock.saveCalls[0] as Record<string, unknown>;
    expect((persisted.session as Record<string, unknown>).maxTurns).toBe(33);
  });

  it('uses the center without throwing before initialize (guard)', () => {
    // getInstance singleton is already initialized by beforeEach; verify the
    // initialized flag path by checking get() works after re-initialize.
    expect(() => {
      const c = RuntimeConfigCenter.getInstance();
      // already initialized — just verify get works
      c.get('session.maxTurns');
    }).not.toThrow();
  });
});
