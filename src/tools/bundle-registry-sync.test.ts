/**
 * MCP 工具包自动同步 —— syncTools() 的契约测试（2026-10-13，孑遗指派）。
 *
 * 背景：每个 MCP server 自动拥有一个独立工具包 `mcp-<server>`，供 activate_bundle 按需启用
 * （REA 实测 170 个工具，常驻工具列表既耗上下文又拖低选择准确率）。
 *
 * 本文件重点钉住**两个静默陷阱**（都是读源码时发现的，不是想当然）：
 *   ① `tools: []` 在本框架的语义是「无过滤 = 全量」（见 BUILTIN_ALL）
 *      ⇒ 若 MCP 断开后留下**空包**，用户「激活它」= 放开一切 ✗ 与按需收窄正好相反。
 *   ② 删掉「唯一被激活的包」会让 activeBundles 变空，而空激活集**同样等于全量**
 *      （getActiveToolNames: `if (actives.length === 0) return []`）✗
 * 两条都必须「宁可少放行」：空则删包、激活集空则回填 common。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolBundleRegistry } from './bundle-registry.js';

describe('MCP 工具包自动同步（syncTools）', () => {
  let dir: string;
  let cfgPath: string;
  let reg: ToolBundleRegistry;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bundle-'));
    cfgPath = path.join(dir, 'tool-bundles.json');
    reg = new ToolBundleRegistry(dir, cfgPath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('① 首次同步：建包，工具名逐字保留（必须是全名 mcp__<server>__<tool>）', () => {
    reg.syncTools('mcp-rea', 'MCP server «rea» 的全部工具', ['mcp__rea__a', 'mcp__rea__b']);
    const b = reg.get('mcp-rea');
    expect(b).toBeDefined();
    expect(b?.tools).toEqual(['mcp__rea__a', 'mcp__rea__b']);
    // 同步包不是内置包：不能带 builtin 标记，否则 load() 会按内置包做工具回填/元数据覆盖
    expect(b?.builtin).toBeUndefined();
  });

  it('② 对齐语义（非增量）：多退少补，不留幽灵条目', () => {
    reg.syncTools('mcp-rea', 'd', ['mcp__rea__a', 'mcp__rea__b']);
    reg.syncTools('mcp-rea', 'd', ['mcp__rea__b', 'mcp__rea__c']);
    expect(reg.get('mcp-rea')?.tools).toEqual(['mcp__rea__b', 'mcp__rea__c']);
  });

  it('③ 【守卫】空列表 ⇒ 删包，绝不留空包（空 tools = 全量语义）', () => {
    reg.syncTools('mcp-rea', 'd', ['mcp__rea__a']);
    expect(reg.get('mcp-rea')).toBeDefined();

    reg.syncTools('mcp-rea', 'd', []);
    expect(reg.get('mcp-rea')).toBeUndefined(); // 留空包 = 激活它等于放开一切 ✗
  });

  it('④ 【守卫】删掉「唯一被激活的包」⇒ 激活集回填 common，不得静默滑进全量', () => {
    reg.syncTools('mcp-rea', 'd', ['mcp__rea__a']);
    reg.activate(['mcp-rea']);
    expect(reg.isAllMode()).toBe(false);

    reg.syncTools('mcp-rea', 'd', []); // server 断开

    // 关键断言：仍**不是**全量模式，且激活集非空
    expect(reg.isAllMode()).toBe(false);
    expect(reg.getActive().map((b) => b.name)).toEqual(['common']);
    expect(reg.getActiveToolNames().length).toBeGreaterThan(0);
  });

  it('⑤ 删包不影响其它激活包（只在激活集真的空掉时才回填）', () => {
    reg.syncTools('mcp-a', 'd', ['mcp__a__t']);
    reg.syncTools('mcp-b', 'd', ['mcp__b__t']);
    reg.activate(['mcp-a', 'mcp-b']);

    reg.syncTools('mcp-a', 'd', []);

    expect(reg.getActive().map((b) => b.name)).toEqual(['mcp-b']);
    expect(reg.isAllMode()).toBe(false);
  });

  it('⑥ 幂等：同一份清单重复同步不产生重复条目', () => {
    reg.syncTools('mcp-x', 'd', ['mcp__x__t']);
    reg.syncTools('mcp-x', 'd', ['mcp__x__t']);
    expect(reg.get('mcp-x')?.tools).toEqual(['mcp__x__t']);
  });

  it('⑦ 落盘：换实例重读仍在（跨 restart 存活）', () => {
    reg.syncTools('mcp-rea', 'd', ['mcp__rea__a']);
    const reg2 = new ToolBundleRegistry(dir, cfgPath);
    expect(reg2.get('mcp-rea')?.tools).toEqual(['mcp__rea__a']);
  });

  it('⑧ 对不存在的包同步空列表是空操作（removeServer 可能被重复调用）', () => {
    expect(() => reg.syncTools('mcp-ghost', 'd', [])).not.toThrow();
    expect(reg.get('mcp-ghost')).toBeUndefined();
  });
});
