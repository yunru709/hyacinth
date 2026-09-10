import { describe, it, expect } from 'vitest';
import { AssemblyRegistry, type AssemblyEntry } from './assembly-registry.js';

const graph: AssemblyEntry[] = [
  { id: 'configManager', kind: 'instance', phase: 'P-A', provides: 'config.json 原文', note: 'boot 引导' },
  { id: 'mainProvider', kind: 'instance', phase: 'P-B', provides: '主模型实例' },
];
const slots: AssemblyEntry[] = [
  { id: 'slot:input', kind: 'slot', phase: 'P-C', defaultImpl: 'builtin:input-normalize' },
];
const services: AssemblyEntry[] = [
  { id: 'service:compressor', kind: 'service', phase: 'P-B' },
];

describe('本体注册表 AssemblyRegistry', () => {
  it('三路注入合并；重复 id fail-fast', () => {
    const reg = new AssemblyRegistry({ graphEntries: graph, slotEntries: slots, serviceEntries: services });
    expect(reg.list()).toHaveLength(4);
    expect(() =>
      new AssemblyRegistry({
        graphEntries: [...graph, graph[0]],
        slotEntries: [],
        serviceEntries: [],
      }),
    ).toThrow(/duplicate entry id "configManager"/);
  });

  it('list 按 kind 过滤；get 精确查询', () => {
    const reg = new AssemblyRegistry({ graphEntries: graph, slotEntries: slots, serviceEntries: services });
    expect(reg.list('instance')).toHaveLength(2);
    expect(reg.list('slot')).toHaveLength(1);
    expect(reg.list('service')).toHaveLength(1);
    expect(reg.get('service:compressor')?.kind).toBe('service');
    expect(reg.get('slot:input')?.defaultImpl).toBe('builtin:input-normalize');
    expect(reg.get('missing')).toBeUndefined();
  });

  it('describe 按装配阶段分组', () => {
    const reg = new AssemblyRegistry({ graphEntries: graph, slotEntries: slots, serviceEntries: services });
    const text = reg.describe();
    expect(text).toContain('── P-A ──');
    expect(text).toContain('configManager [instance] → config.json 原文');
    expect(text).toContain('── P-B ──');
    expect(text).toContain('slot:input [slot] = builtin:input-normalize');
  });
});
