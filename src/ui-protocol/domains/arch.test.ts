/**
 * arch.test.ts — arch 域的 links 段（Phase 6 第 3 步）
 *
 * 验收线：「links 段两个入口都能看到能力状态与计数」。
 * 本文件管 **UI 协议域**那侧：`arch.list` 的返回里必须带 `links`，
 * 且数据源**未注入时为 null**（前端据此显示"能力未注册（走核心兜底）"，而不是留白/报错）。
 * 协议层零业务依赖：域只调注入的 `getLinks()`，自己不认识 tools/channels（见 arch.ts 注释）。
 *
 * ⚠️ 签名以类型为准（首版凭印象写，被编译拦下）：`DomainAction = (params, ctx: RequestContext)`，
 * 故 list 需要两个实参；`ArchDataLike` 还必须实现 `togglePlugin`。
 */
import { describe, expect, it } from 'vitest';
import { createArchDomain } from './arch.js';
import type { ArchDataLike } from './arch.js';

function stubArch(): ArchDataLike {
  return {
    getCatalog: () => [],
    getEntries: () => [],
    getManifest: () => null,
    getAssemblyDescribe: () => null,
    togglePlugin: () => ({ ok: true }),
  };
}

/** 域的 action 签名是 (params, ctx) —— 测试只需前者，ctx 用空对象占位 */
const callList = (domain: ReturnType<typeof createArchDomain>): Promise<unknown> =>
  (domain.list as (p: unknown, c: unknown) => Promise<unknown>)(undefined, {});

describe('arch 域 · links 段', () => {
  it('注入 getLinks → list() 的返回带上 links 文本', async () => {
    const domain = createArchDomain({
      getArch: () => stubArch(),
      getLinks: () => '── 联动（links）──\n  能力未注册（走核心兜底）',
    });
    const result = (await callList(domain)) as { links: string | null };
    expect(result.links).toContain('── 联动（links）──');
    expect(result.links).toContain('能力未注册（走核心兜底）');
  });

  it('未注入 getLinks → links 为 null（附加信息缺失不该拖垮整屏）', async () => {
    const domain = createArchDomain({ getArch: () => stubArch() });
    const result = (await callList(domain)) as { links: string | null; catalog: unknown[] };
    expect(result.links).toBeNull();
    expect(Array.isArray(result.catalog)).toBe(true); // 其余字段照常
  });

  it('getArch 未装配时仍按既有语义抛错（links 的缺失不影响该契约）', async () => {
    const domain = createArchDomain({ getArch: () => null, getLinks: () => 'x' });
    await expect(callList(domain)).rejects.toThrow(/not assembled/);
  });
});
