import { describe, it, expect, beforeEach } from 'vitest';
import { GenericRegistry, type RegistryItem } from './base.js';

interface MockItem extends RegistryItem {
  value: string;
}

function makeItem(name: string, value = 'v'): MockItem {
  return { name, value, source: 'builtin' };
}

/** GenericRegistry 是抽象类，测试用最小具体子类 */
class MockRegistry extends GenericRegistry<MockItem> {}

describe('GenericRegistry', () => {
  let registry: MockRegistry;

  beforeEach(() => {
    registry = new MockRegistry();
  });

  it('registers and retrieves items', () => {
    registry.register(makeItem('a'));
    expect(registry.get('a')?.value).toBe('v');
    expect(registry.has('a')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('overwrites an existing item with the same name', () => {
    registry.register(makeItem('a', 'v1'));
    registry.register(makeItem('a', 'v2'));
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('a')?.value).toBe('v2');
  });

  it('unregisters items and reports false for missing', () => {
    registry.register(makeItem('a'));
    expect(registry.unregister('a')).toBe(true);
    expect(registry.unregister('a')).toBe(false);
    expect(registry.has('a')).toBe(false);
    expect(registry.isEmpty()).toBe(true);
  });

  it('tracks enabled/disabled state independently of existence', () => {
    registry.register(makeItem('a'));
    registry.register(makeItem('b'));

    registry.disable('a');
    expect(registry.isEnabled('a')).toBe(false);
    expect(registry.isEnabled('b')).toBe(true);

    const enabled = registry.getEnabled().map((i) => i.name);
    const disabled = registry.getDisabled().map((i) => i.name);
    expect(enabled).toEqual(['b']);
    expect(disabled).toEqual(['a']);
  });

  it('enable/disable on unknown names is a safe no-op', () => {
    expect(() => registry.disable('nope')).not.toThrow();
    expect(() => registry.enable('nope')).not.toThrow();
  });

  it('emits register/unregister/enable/disable events', () => {
    const events: Array<{ event: string; name: string }> = [];
    registry.onEvent((event, name) => events.push({ event, name }));

    registry.register(makeItem('a'));
    registry.disable('a');
    registry.enable('a');
    registry.unregister('a');

    expect(events.map((e) => `${e.event}:${e.name}`)).toEqual([
      'register:a',
      'disable:a',
      'enable:a',
      'unregister:a',
    ]);
  });

  it('offEvent stops receiving events', () => {
    const events: string[] = [];
    const listener = (event: string) => events.push(event);
    registry.onEvent(listener);
    registry.register(makeItem('a'));
    registry.offEvent(listener);
    registry.register(makeItem('b'));
    expect(events).toEqual(['register']);
  });

  it('a listener throwing does not break other listeners or the registry', () => {
    const boom = () => { throw new Error('listener failed'); };
    const seen: string[] = [];
    registry.onEvent(boom);
    registry.onEvent((event) => seen.push(event));
    expect(() => registry.register(makeItem('a'))).not.toThrow();
    expect(seen).toEqual(['register']);
    expect(registry.has('a')).toBe(true);
  });
});
