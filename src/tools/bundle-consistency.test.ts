/**
 * bundle-consistency.test.ts — 守住「注册表 ↔ 工具包」的一致性
 *
 * 背景（2026-09-19 审计发现）：工具包列表是**手写的**，而没有任何测试守住它与注册表
 * 的一致，于是漂移了 —— 实测 **47 个已注册工具不在任何非 all 包内**，默认（coding）
 * 模式下即不可见。其中最确定的一条是拼写：
 *
 *     bundle 里写 'multi-edit'（连字符）  而实际工具名是 'multi_edit'（下划线）
 *
 * → coding 包里那条是死条目，`multi_edit` 在默认模式下直接消失。
 *
 * 本文件两道守卫：
 *   ① 每个包里的每个条目都必须是**真实存在的工具名**（抓拼写/改名漂移）
 *   ② 每个已声明的工具都必须属于某个非 all 包，或落入显式白名单（抓"漏进包"）
 *
 * ⚠️ 为什么用"从源码推导 + 白名单"而不是运行时全量清单：
 *   `registerRuntimeControlTools(...)` 需要 9 个运行时实例（loop / 各 router / registry），
 *   单测里造不出来；既有契约测试也明确回避了 createDefaultRegistry()。
 *   因此这里扫描「声明了 Tool 接口的类」里的 name 字面量，动态来源（MCP 服务器端命名、
 *   Python 桥元数据）走**显式白名单**——白名单本身会被打印出来，不许暗箱。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

/** 动态注册、无法从 TS 字面量推导的工具名（含理由，必须写明） */
const DYNAMIC_TOOLS: Record<string, string> = {
  'delegate_to_agent': '运行时注册，name 声明形式与其他 Tool 类不同（src/agents/delegate-tool.ts）',
  'view_image': 'multimodal 内联对象工具（src/multimodal/index.ts）',
  'view_media': '同上',
  'docx_read': 'Python 桥：名字来自 .py 元数据，不在 TS 源码里',
  'xlsx_read': '同上',
};
/** 前缀形式（MCP 工具名来自服务器端工具列表，只能按前缀识别） */
const DYNAMIC_PREFIXES: Array<[string, string]> = [
  ['mcp__', 'MCP 桥：名字来自 MCP 服务器的工具列表，静态不可枚举'],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|dist/.test(e.name)) walk(p, out); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** 这些文件里的 `name:` / `readonly name` 字面量**不是工具名**（实测踩到的两处假阳性）：
 *   - bundle-registry.ts   → 声明的是**包名**（all/common/coding…）
 *   - knowledge/fts5-retriever.ts → 是 Retriever 实现，恰好也叫 `readonly name = 'fts5'`
 */
const NON_TOOL_FILES = new Set([
  'src/tools/bundle-registry.ts',
  'src/knowledge/fts5-retriever.ts',
]);

/**
 * 源码里的"工具名宇宙"。
 * ⚠️ 不能只扫 `implements Tool` 的类 —— 实测漏掉了 runtime-control 下那一大批工具
 * （它们是普通对象/lambda，不是 Tool 类），导致守则①把 `set_channel_role` 这类
 * **真实存在**的工具误报为"找不到对应工具"。
 * ⚠️ 也不能只扫 src/tools —— 实测 `kb_*` 六个工具声明在 `src/knowledge/tools.ts`，
 * 不覆盖到就会被守则②漏检（漏检比误报更危险）。
 */
function declaredToolNames(): Map<string, string> {
  const found = new Map<string, string>();
  const roots = [
    path.join(ROOT, 'src', 'tools'),
    path.join(ROOT, 'src', 'agents'),
    path.join(ROOT, 'src', 'multimodal'),
    path.join(ROOT, 'src', 'knowledge'),
    path.join(ROOT, 'src', 'skills'),    // use_skill（实测漏检 → 守则①误报）
    path.join(ROOT, 'src', 'rollback'),  // rollback / rollback_status（同上）
  ];
  // 单文件入口：整个 src/channels 不能扫（那里有大量**渠道名** name: 'feishu' 等，会变假阳性），
  // 但 send_channel_message 这个工具正好声明在 dispatcher.ts 里。
  const extraFiles = [path.join(ROOT, 'src', 'channels', 'dispatcher.ts')];
  const files: string[] = [];
  for (const r of roots) if (fs.existsSync(r)) files.push(...walk(r));
  for (const f of extraFiles) if (fs.existsSync(f)) files.push(f);

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (NON_TOOL_FILES.has(rel)) continue;
    for (const m of src.matchAll(/readonly\s+name\s*=\s*'([a-z0-9_]+)'/g)) found.set(m[1]!, rel);
    // 普通对象形式的工具（runtime-control / knowledge / rollback / channels 下大量使用）
    for (const m of src.matchAll(/^\s*name:\s*'([a-z0-9_]+)'/gm)) {
      if (!found.has(m[1]!)) found.set(m[1]!, rel);
    }
  }
  return found;
}

/** 解析 bundle-registry.ts 里每个包的 tools 列表 */
function bundleTools(): Record<string, string[]> {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'bundle-registry.ts'), 'utf8');
  const out: Record<string, string[]> = {};
  for (const block of src.split(/const BUILTIN_/).slice(1)) {
    const nm = /name:\s*'([a-z]+)'/.exec(block)?.[1];
    if (!nm) continue;
    const arr = /tools:\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? '';
    out[nm] = [...arr.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]!);
  }
  return out;
}

const isDynamic = (n: string): boolean =>
  n in DYNAMIC_TOOLS || DYNAMIC_PREFIXES.some(([pre]) => n.startsWith(pre));

describe('工具包 ↔ 注册表 一致性', () => {
  const declared = declaredToolNames();
  const bundles = bundleTools();
  const nonAll = new Set<string>();
  for (const [nm, list] of Object.entries(bundles)) {
    if (nm === 'all') continue;
    for (const t of list) nonAll.add(t);
  }

  it('白名单不是暗箱：打印本测试依赖的动态工具白名单', () => {
    const lines = [
      ...Object.entries(DYNAMIC_TOOLS).map(([k, v]) => `  ${k}  ← ${v}`),
      ...DYNAMIC_PREFIXES.map(([k, v]) => `  ${k}*  ← ${v}`),
    ];
    // 白名单刻意保持很短；变长说明有工具在绕过"声明即入包"的路径
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(declared.size).toBeGreaterThan(15); // 扫描确实抓到了东西，别静默退化成空集
  });

  it('守则①：每个包里的条目都必须是真实存在的工具名', () => {
    const bad: string[] = [];
    for (const [bname, list] of Object.entries(bundles)) {
      if (bname === 'all') continue;
      for (const t of list) {
        if (!declared.has(t) && !isDynamic(t)) bad.push(`${bname}: '${t}'`);
      }
    }
    expect(bad, `包内条目找不到对应工具（多半是拼写/改名漂移）：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('守则②：每个已声明的工具都必须属于某个非 all 包（或在白名单内）', () => {
    const missing = [...declared.keys()].filter((n) => !nonAll.has(n) && !isDynamic(n));
    expect(
      missing,
      `以下工具不在任何非 all 包内 —— 默认（coding）模式下将**不可见**：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
