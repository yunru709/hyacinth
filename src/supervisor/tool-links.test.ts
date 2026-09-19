/**
 * tool-links.test.ts — 联动清单模块的契约（第三圈：关系声明化）
 *
 * 锁五件事（对着行为，不读注释）：
 *  ① 结构校验宽容但**保留类 kind 明确拒绝**（veto/intercept 本轮不实现 —— 报错要说清为什么）
 *  ② 语义校验（事件名 ∈ 目录、handler 已注册）需要外部知识 ⇒ 由调用方注入
 *  ③ **没有清单文件 ⇒ 出厂默认 = 今天的行为**（这是"迁移不改变行为"的关键保证）
 *  ④ 坏文件（非 JSON / 根不是对象）⇒ 默认 + 错误，**绝不抛**
 *  ⑤ 清单 → 执行序列：保序、过滤 disabled、跳过未注册（热更中间态）
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOOL_LINKS_VERSION,
  ToolLinkRegistry,
  defaultToolLinks,
  loadToolLinks,
  parseToolLinks,
  resolveToolLinks,
  toolLinksPath,
  validateToolLinks,
  type ToolLinkHandler,
} from './tool-links.js';

let realHome: string;
let fakeHome: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  realHome = os.homedir();
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'toollinks-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterAll(() => {
  homedirSpy.mockRestore();
  expect(os.homedir()).toBe(realHome);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

describe('parseToolLinks（结构校验）', () => {
  it('① 合法清单原样通过；缺 enabled 表示"想要"（缺省视为启用）', () => {
    const { manifest, errors } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [{ on: 'afterToolExecute:edit', handler: 'core.references-append' }],
    });
    expect(errors).toEqual([]);
    expect(manifest.links).toHaveLength(1);
    expect(manifest.links[0]?.enabled).toBeUndefined(); // 由调用方按"缺省=启用"处理
  });

  it('① 保留类 kind（veto/intercept）**明确拒绝**，报错说明"本轮未实现 + 需要新契约"', () => {
    const { manifest, errors } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [{ on: 'beforeToolExecute', handler: 'core.read-gate', kind: 'veto' }],
    });
    expect(manifest.links).toHaveLength(0);
    expect(errors.join('\n')).toContain('reserved');
    expect(errors.join('\n')).toContain('veto/intercept need a new contract');
  });

  it('① 非法条目剔除但合法条目保留（宽容策略，与 extension-registry 同款）', () => {
    const { manifest, errors } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [
        { handler: 'x' }, // 缺 on
        { on: 'afterToolExecute:edit', handler: 'ok' },
        { on: 'afterToolExecute:edit', handler: 'ok' }, // 重复
        { on: 'afterToolExecute:edit', handler: 'y', enabled: 'yes' }, // enabled 非布尔
      ],
    });
    expect(manifest.links.map((l) => l.handler)).toEqual(['ok']);
    expect(errors).toHaveLength(3);
  });

  it('① 根不是对象 / links 不是数组 ⇒ 空清单 + 错误', () => {
    expect(parseToolLinks(null).errors).toHaveLength(1);
    expect(parseToolLinks([]).errors).toHaveLength(1);
    expect(parseToolLinks({ links: 'nope' }).errors).toContain('links must be an array');
  });

  it('① 版本不符 ⇒ 记错（不做迁移；将来加版本时在这里分派）', () => {
    const { errors } = parseToolLinks({ version: 99, links: [] });
    expect(errors.join(' ')).toContain('unsupported version');
  });
});

describe('validateToolLinks（语义校验：知识由调用方注入）', () => {
  it('② 事件名必须在目录里、处理器必须已注册', () => {
    const { manifest } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [
        { on: 'afterToolExecute:edit', handler: 'core.ok' },
        { on: 'noSuchHook', handler: 'core.ok' },
        { on: 'afterToolExecute:edit', handler: 'core.missing' },
      ],
    });
    const errors = validateToolLinks(manifest, {
      eventNames: ['afterToolExecute', 'beforeToolExecute'],
      handlerIds: ['core.ok'],
    });
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('unknown event "noSuchHook"');
    expect(errors.join('\n')).toContain('unknown handler "core.missing"');
  });
});

describe('loadToolLinks（读文件 + 保旧语义的输入）', () => {
  it('③ **没有清单文件 ⇒ 出厂默认 = 今天的行为**（迁移不改变行为的关键保证）', () => {
    fs.rmSync(toolLinksPath(), { force: true });
    const r = loadToolLinks();
    expect(r.existed).toBe(false);
    expect(r.errors).toEqual([]);
    // 默认清单必须覆盖今天那几个消费者（写死断言，防默认值被悄悄改小）
    const ids = new Set(r.manifest.links.map((l) => l.handler));
    expect(ids.has('core.references-append')).toBe(true);
    expect(ids.has('core.diagnostics-append')).toBe(true);
    expect(ids.has('core.dependency-impact-enrich')).toBe(true);
    expect(ids.has('core.evidence-ledger-append')).toBe(true);
  });

  it('④ 坏文件（非 JSON）⇒ 默认 + 错误，绝不抛', () => {
    fs.mkdirSync(path.dirname(toolLinksPath()), { recursive: true });
    fs.writeFileSync(toolLinksPath(), '{ 这不是 JSON', 'utf8');
    const r = loadToolLinks();
    expect(r.existed).toBe(true);
    expect(r.errors.join(' ')).toContain('invalid JSON');
    expect(r.manifest.links.length).toBeGreaterThan(0); // 仍可用（默认）
  });

  it('③ 有合法清单 ⇒ 用它（且不再返回默认）', () => {
    fs.writeFileSync(
      toolLinksPath(),
      JSON.stringify({ version: TOOL_LINKS_VERSION, links: [{ on: 'afterToolExecute:edit', handler: 'core.only' }] }),
      'utf8',
    );
    const r = loadToolLinks();
    expect(r.existed).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.manifest.links.map((l) => l.handler)).toEqual(['core.only']);
  });
});

describe('ToolLinkRegistry + resolveToolLinks（清单 → 执行序列）', () => {
  const mk = (id: string, on: string | string[]): ToolLinkHandler => ({
    id,
    kind: 'append',
    owner: 'core',
    on,
    run: async () => `ran:${id}`,
  });

  it('重复注册 / 本轮未实现的 kind ⇒ 注册即抛（把"契约没实现"挡在最早处）', () => {
    const reg = new ToolLinkRegistry();
    reg.register(mk('a', 'afterToolExecute:edit'));
    expect(() => reg.register(mk('a', 'afterToolExecute:edit'))).toThrow(/already registered/);
    expect(() => reg.register({ ...mk('b', 'x'), kind: 'veto' as never })).toThrow(/not implemented in this round/);
  });

  it('⑤ 保序 + 过滤 enabled:false + 跳过未注册（热更中间态兜底）', () => {
    const reg = new ToolLinkRegistry();
    reg.register(mk('h1', 'afterToolExecute:edit'));
    reg.register(mk('h2', ['afterToolExecute:edit', 'afterToolExecute:write']));
    const { manifest } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [
        // 注意：`enabled:false` 写在**原有那一行**上是"关掉这条"；若新增一行同 (on,handler)
        // 的 disabled 条目，会被 parse 判成**重复绑定**并记错（⇒ watcher 层会整份保旧）。
        // 这个区别是有意的：重复条目会让人怀疑"到底跑几次"。
        { on: 'afterToolExecute:edit', handler: 'h1', enabled: false },
        { on: 'afterToolExecute:edit', handler: 'h2' },
        { on: 'afterToolExecute:edit', handler: 'nope' }, // 未注册 ⇒ 跳过（不抛）
        { on: 'afterToolExecute:write', handler: 'h2' },
      ],
    });
    expect(manifest.links).toHaveLength(4); // 4 条都合法（enabled:false 也是合法条目）
    const seq = resolveToolLinks(manifest, reg, 'afterToolExecute:edit').map((x) => x.handler.id);
    expect(seq).toEqual(['h2']); // h1 被 enabled:false 过滤；nope 未注册被跳过
    expect(resolveToolLinks(manifest, reg, 'afterToolExecute:write').map((x) => x.handler.id)).toEqual(['h2']);
  });

  it('⑤ 处理器可声明"只关心钩子层"（on 不带 :tool）⇒ 该钩子上任何工具都触发', () => {
    const reg = new ToolLinkRegistry();
    reg.register(mk('all-tools', 'afterToolExecute'));
    const { manifest } = parseToolLinks({
      version: TOOL_LINKS_VERSION,
      links: [{ on: 'afterToolExecute', handler: 'all-tools' }],
    });
    expect(resolveToolLinks(manifest, reg, 'afterToolExecute:edit')).toHaveLength(1);
    expect(resolveToolLinks(manifest, reg, 'afterToolExecute:bash')).toHaveLength(1);
  });
});

describe('出厂默认清单的形状', () => {
  it('顺序即执行顺序（诊断在前、引用自检在后 —— 与今天的可见顺序一致）', () => {
    const links = defaultToolLinks().links;
    const writeOrder = links.filter((l) => l.on === 'afterToolExecute:write').map((l) => l.handler);
    expect(writeOrder.indexOf('core.diagnostics-append')).toBeLessThan(writeOrder.indexOf('core.references-append'));
  });
});
