/**
 * assembly-graph 守卫测试（P6-0 交付物，P6-1 更新守卫 C，P6-4 守卫 B 改单一真源）。
 *
 * 把 factory.ts 的隐式装配顺序变成可 diff 的东西：
 * - 守卫 A：声明表不虚构 —— 每条 anchor 必须真实存在于 factory.ts 源码；
 * - 守卫 B：factory 直接 new 业务类 == 白名单（scripts/assembly-whitelist.mjs 单一真源，
 *   与 verify:layers 规则 3 同源 —— P6 每迁移一个出 factory，白名单同步删一条）；
 * - 守卫 C1：P6-1 后 setHooks 重建缺陷不复现（缺陷注释已消灭 + manager 不重建宿主）；
 * - 守卫 C2：非缺陷的时序约束注释仍在（:240/:863，P6-2/3 机制化前不可误删）；
 * - 守卫 D：清单 id 唯一；
 * - 守卫 E：AgentLoop 构造签名 (services, opts) 两层（P6-2）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { ASSEMBLY_GRAPH, ASSEMBLY_IDS } from './assembly-graph.js';
import { ALLOWED_DIRECT_NEW, ASSEMBLY_EXCLUDED } from '../../scripts/assembly-whitelist.mjs';

const factorySrc = fs.readFileSync(new URL('./factory.ts', import.meta.url), 'utf-8');
// 装配主体：P6-19 薄壳化后编排主体在 agent-assembly.ts（factory 仅为对外薄壳）。
const assemblyBodySrc = fs.readFileSync(new URL('./agent-assembly.ts', import.meta.url), 'utf-8');
// 装配代码集合：agent-assembly.ts（主体）+ factory.ts（薄壳）+ 全部外移的
// 贡献批/接线模块。声明表 anchor 可落在任一装配文件中（外移不改变清单，只改变落点）。
const assemblySrc =
  factorySrc +
  '\n' +
  assemblyBodySrc +
  '\n' +
  fs.readFileSync(new URL('./base-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./boot.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./tool-registration.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./runtime-wiring.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./bypass-wiring.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./config-wiring.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./bootstrap-wiring.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./context-chain-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./orchestrator-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./infra-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./channel-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./plugin-manager-contribution.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./core-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./context-sources.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./plugin-contributions.ts', import.meta.url), 'utf-8') +
  '\n' +
  fs.readFileSync(new URL('./runtime-contributions.ts', import.meta.url), 'utf-8');

/** 装配主体内 `new X(` 的业务类集合（排除语言/库/装配工具类型，口径与白名单一致） */
function scanNewClasses(): Set<string> {
  const found = new Set<string>();
  const re = /new ([A-Z][A-Za-z0-9]*)\s*[<(]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(assemblyBodySrc))) {
    if (!ASSEMBLY_EXCLUDED.has(m[1])) found.add(m[1]);
  }
  return found;
}

describe('assembly-graph（P6-0 装配声明表守卫）', () => {
  it('守卫 D：清单 id 唯一', () => {
    expect(new Set(ASSEMBLY_IDS).size).toBe(ASSEMBLY_IDS.length);
  });

  it('守卫 A：每条 anchor 都真实存在于装配代码（factory.ts / plugin-contributions.ts；清单不虚构、代码删除必同步清单）', () => {
    const missing = ASSEMBLY_GRAPH.filter((e) => !assemblySrc.includes(e.anchor));
    expect(missing.map((e) => `${e.id} → ${e.anchor}`)).toEqual([]);
  });

  it('守卫 B：装配主体直接 new 业务类 = 白名单（P6-4 门禁单一真源；迁移时删白名单条目）', () => {
    const classes = scanNewClasses();
    // 实际 new 集 == 白名单（双向：防偷偷加实例 / 防白名单虚增豁免）
    expect(classes).toEqual(ALLOWED_DIRECT_NEW);
    expect(classes.size).toBe(ALLOWED_DIRECT_NEW.size);
    // 基线内容快照仍保留：改名/删除都会红，提示同步白名单
    expect([...classes].sort().join('\n')).toMatchSnapshot();
  });

  it('守卫 C1：P6-1 后 setHooks 重建宿主缺陷不复现（缺陷注释消灭 + manager 不重建宿主）', () => {
    // 三条「重建宿主后挂载」注释必须已随 P6-1 迁移消失
    const gone = [
      'setHooks 会重建宿主，若提前挂载会被丢弃',
      '知识库插件挂载（setHooks 重建宿主后）',
      'Xref 插件挂载（setHooks 重建宿主后）',
    ];
    expect(gone.filter((a) => factorySrc.includes(a))).toEqual([]);
    // manager.setHooks 委托给 PluginHost 追加注入 —— 不得再 new PluginHost
    const managerSrc = fs.readFileSync(new URL('../plugins/manager.ts', import.meta.url), 'utf-8');
    const setHooksBody = managerSrc.slice(managerSrc.indexOf('setHooks('), managerSrc.indexOf('loadAll('));
    expect(setHooksBody).not.toContain('new PluginHost');
  });

  it('守卫 C2：非缺陷的时序约束注释仍在（机制化前不可误删；随接线抽离落点同步）', () => {
    const anchors = [
      'Provider Config Loader（时序锚：必须在 getDefaultConfig 之前',
      '不依赖 loop 的工具在 AgentLoop 之前注册',
    ];
    const missing = anchors.filter((a) => !assemblySrc.includes(a));
    expect(missing).toEqual([]);
  });

  it('守卫 E：AgentLoop 构造签名为 (services, opts) 两层（P6-2：新增服务不再逐字段列举）', () => {
    const loopSrc = fs.readFileSync(new URL('../orchestrator/loop.ts', import.meta.url), 'utf-8');
    // 服务表 + 配置两层签名固定
    expect(loopSrc).toMatch(/constructor\(\s*services: AgentLoopServices/);
    expect(loopSrc).toMatch(/opts: AgentLoopConfigOptions\)/);
    // 旧逐字段签名（options: AgentLoopOptions）已不存在
    expect(loopSrc).not.toMatch(/constructor\(\s*options: AgentLoopOptions\)/);
  });
});
