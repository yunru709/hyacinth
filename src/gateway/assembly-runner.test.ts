/**
 * assembly-runner 原语测试（P6-1 交付物）。
 *
 * 覆盖：拓扑排序（provides 满足 needs → 先执行）、环检测、缺依赖 fail-fast、
 * factory provide 就绪直接执行、mount 返回值按 provides 登记、重复 id / 重复
 * provides / 与 factory provide 冲突等解析期错误。
 */
import { describe, it, expect } from 'vitest';
import { AssemblyRunner, type AssemblyContribution } from './assembly-runner.js';

describe('AssemblyRunner（装配贡献原语，P6-1）', () => {
  it('needs 全部由 factory provide 时按声明序直接执行', async () => {
    const runner = new AssemblyRunner();
    runner.provide('configCenter', { get: () => 1 });
    runner.provide('cwd', '/tmp');

    const order: string[] = [];
    const contribs: AssemblyContribution[] = [
      { id: 'a', needs: ['cwd'], mount: () => { order.push('a'); } },
      { id: 'b', needs: ['configCenter', 'cwd'], mount: () => { order.push('b'); } },
    ];

    await runner.run(contribs);
    expect(order).toEqual(['a', 'b']);
  });

  it('拓扑：provides 满足他人 needs 的贡献先执行', async () => {
    const runner = new AssemblyRunner();
    runner.provide('seed', 'x');

    const order: string[] = [];
    const contribs: AssemblyContribution[] = [
      {
        id: 'consumer',
        needs: ['thing'],
        mount: (deps) => { order.push(`consumer:${deps.thing}`); },
      },
      {
        id: 'producer',
        needs: ['seed'],
        provides: ['thing'],
        mount: (deps) => { order.push(`producer:${deps.seed}`); return { thing: `made-from-${deps.seed}` }; },
      },
    ];

    await runner.run(contribs);
    expect(order).toEqual(['producer:x', 'consumer:made-from-x']);
  });

  it('mount 返回值按 provides 键登记，run 结果可被 factory 取用', async () => {
    const runner = new AssemblyRunner();
    const results = await runner.run([
      { id: 'kb', needs: [], provides: ['kbApi'], mount: () => ({ kbApi: { kbState: { lastQuery: '' } } }) },
    ]);
    expect(results.get('kbApi')).toEqual({ kbState: { lastQuery: '' } });
  });

  it('缺依赖 fail-fast：needs 键无人提供 → 报错并点名', async () => {
    const runner = new AssemblyRunner();
    await expect(
      runner.run([{ id: 'orphan', needs: ['ghost'], mount: () => {} }]),
    ).rejects.toThrow(/ghost/);
    await expect(
      runner.run([{ id: 'orphan', needs: ['ghost'], mount: () => {} }]),
    ).rejects.toThrow(/缺失依赖/);
  });

  it('环检测：贡献互相等待 → 报错标明环', async () => {
    const runner = new AssemblyRunner();
    const contribs: AssemblyContribution[] = [
      { id: 'a', needs: ['b.out'], provides: ['a.out'], mount: () => ({ a: 1 }) },
      { id: 'b', needs: ['a.out'], provides: ['b.out'], mount: () => ({ b: 1 }) },
    ];
    await expect(runner.run(contribs)).rejects.toThrow(/环/);
  });

  it('重复 id 报错', async () => {
    const runner = new AssemblyRunner();
    await expect(
      runner.run([
        { id: 'dup', needs: [], mount: () => {} },
        { id: 'dup', needs: [], mount: () => {} },
      ]),
    ).rejects.toThrow(/duplicate contribution id "dup"/);
  });

  it('重复 provides 键报错（歧义）', async () => {
    const runner = new AssemblyRunner();
    await expect(
      runner.run([
        { id: 'x', provides: ['k'], needs: [], mount: () => ({ k: 1 }) },
        { id: 'y', provides: ['k'], needs: [], mount: () => ({ k: 2 }) },
      ]),
    ).rejects.toThrow(/provided by both/);
  });

  it('provides 与 factory provide 冲突报错', async () => {
    const runner = new AssemblyRunner();
    runner.provide('k', 'factory-value');
    await expect(
      runner.run([{ id: 'x', provides: ['k'], needs: [], mount: () => ({ k: 1 }) }]),
    ).rejects.toThrow(/already provided by factory code/);
  });

  it('mount 返回未声明键报错（防 typo 静默丢值）', async () => {
    const runner = new AssemblyRunner();
    await expect(
      runner.run([
        {
          id: 'typo',
          provides: ['kbApi'],
          needs: [],
          mount: () => ({ kbApI: 1 }), // 拼写错误
        },
      ]),
    ).rejects.toThrow(/未声明的键 "kbApI"/);
  });

  it('mount 失败的错误向上传播（不吞）', async () => {
    const runner = new AssemblyRunner();
    await expect(
      runner.run([{ id: 'boom', needs: [], mount: () => { throw new Error('mount exploded'); } }]),
    ).rejects.toThrow('mount exploded');
  });

  // ── 增量多批（行数收尾第二批铺路）──────────────────────────────────

  it('多批 run：第一批产出，第二批消费（mount 结果持久化到 provided）', async () => {
    const runner = new AssemblyRunner();
    runner.provide('seed', 'x');
    const order: string[] = [];

    const batch1 = await runner.run([
      {
        id: 'producer',
        needs: ['seed'],
        provides: ['thing'],
        mount: (d) => { order.push('p1'); return { thing: `made-${d.seed}` }; },
      },
    ]);
    expect(batch1.get('thing')).toBe('made-x');

    const batch2 = await runner.run([
      { id: 'consumer', needs: ['thing'], mount: (d) => { order.push(`c:${d.thing}`); } },
    ]);
    expect(order).toEqual(['p1', 'c:made-x']);
  });

  it('多批 run：同一 runner 重复执行同 id 抛错（防副作用重复）', async () => {
    const runner = new AssemblyRunner();
    await runner.run([{ id: 'a', needs: [], mount: () => {} }]);
    await expect(
      runner.run([{ id: 'a', needs: [], mount: () => {} }]),
    ).rejects.toThrow(/执行过/);
  });

  it('多批 run：第二批依赖第一批提供的键 + factory 新 provide 混合', async () => {
    const runner = new AssemblyRunner();
    runner.provide('seed', 'x');
    await runner.run([
      { id: 'producer', needs: ['seed'], provides: ['thing'], mount: () => ({ thing: 't1' }) },
    ]);
    runner.provide('later', 'L'); // 批间注入新依赖
    const batch2 = await runner.run([
      {
        id: 'consumer',
        needs: ['thing', 'later'],
        mount: (d) => { expect(d).toMatchObject({ thing: 't1', later: 'L' }); },
      },
    ]);
    expect(batch2.has('thing')).toBe(false); // 批 2 不重复产出
  });
});
