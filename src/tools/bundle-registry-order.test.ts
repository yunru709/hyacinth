/**
 * 工具包**渲染顺序**稳定性 —— 缓存抖动的守卫（2026-10-14）。
 *
 * 背景：Zone 2 的 `tool_bundles` 段位于 Zone 2 **末尾**，其后紧跟整个 Zone 3（对话历史）。
 * 自动前缀缓存的判据是"从头开始连续逐字节相同" ⇒ 该段顺序一变，**整块缓存作废**。
 *
 * 而 `list()` 返回 `Object.values(config.bundles)`，是**插入顺序**；MCP 包在运行期会被
 * `syncTools` 删了重建（server 断开 ⇒ 删包；重连 ⇒ create() 追加到末尾）⇒ 顺序漂移。
 *
 * 本测试锁死：**listStable() 在"断连删包 + 重连建包"后顺序不变**；并附一条**对照断言**
 * （未排序的 list() 在同一操作后顺序**确实会变**）—— 防止守卫退化成空转的假绿。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolBundleRegistry } from './bundle-registry.js';

const CHROME_DESC = 'MCP server «chrome-devtools» 的全部工具（1 个）— 按需激活';
const CHROME_TOOLS = ['mcp__chrome-devtools__click'];

/** 建一个含两个 MCP 包的 registry（模拟两个 server 已连上） */
function makeRegistry(): ToolBundleRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-order-'));
  const reg = new ToolBundleRegistry(dir, path.join(dir, 'tool-bundles.json'));
  reg.syncTools('mcp-chrome-devtools', CHROME_DESC, CHROME_TOOLS);
  reg.syncTools('mcp-rea', 'MCP server «rea» 的全部工具（1 个）— 按需激活', ['mcp__rea__xrefs']);
  return reg;
}

/** 模拟一次 MCP 断连 + 重连（syncBundleFor 的两条路径：删包 / 建包） */
function reconnect(reg: ToolBundleRegistry): void {
  reg.syncTools('mcp-chrome-devtools', '', []);      // 断开 ⇒ tools 为空 ⇒ 删包
  reg.syncTools('mcp-chrome-devtools', CHROME_DESC, CHROME_TOOLS); // 重连 ⇒ create() 追加到末尾
}

describe('工具包渲染顺序稳定（缓存守卫）', () => {
  it('listStable() 恒按 name 升序', () => {
    const names = makeRegistry().listStable().map((b) => b.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('MCP 断连删包 + 重连建包 ⇒ listStable() 顺序不变（缓存不因此作废）', () => {
    const reg = makeRegistry();
    const before = reg.listStable().map((b) => b.name);

    reconnect(reg);

    expect(reg.listStable().map((b) => b.name)).toEqual(before);
  });

  it('（对照）未排序 list() 在同一操作后顺序**确实会变** —— 证明上个用例不是空转', () => {
    const reg = makeRegistry();
    const before = reg.list().map((b) => b.name);

    reconnect(reg);

    // 删了再建 ⇒ 被挪到对象末尾 ⇒ 原始插入顺序改变。
    // 若此断言失败，说明上面的守卫没测到真东西（探针假绿）。
    expect(reg.list().map((b) => b.name)).not.toEqual(before);
  });
});
