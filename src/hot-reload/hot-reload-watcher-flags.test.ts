/**
 * hot-reload-watcher-flags.test.ts — 守卫：**每个 watcher 的开关都必须在配置默认值里声明**
 *
 * 为什么需要它（2026-09-19 活体验证当场抓到的真 bug，症状极具迷惑性）：
 *
 *   manager 的注册判据是：
 *       if (spec.flag && !this.deps.configCenter.get(spec.flag)) continue;
 *   而 `get()` 是「默认值 + 运行时覆盖」的合并结果 ⇒ **默认值里没声明**的开关返回 undefined
 *   ⇒ 被判成"用户显式关掉" ⇒ 该 watcher **永不注册**。
 *
 *   迷惑之处：**冷启动装载照常成功**（那条路不经过 watcher，走的是装配时的直接调用），
 *   所以日志里一切正常，只有"改文件后毫无动静"。而且单测抓不到 —— 它取决于
 *   "开关默认值落在哪个文件"，而单测通常不装配配置中心。
 *
 * 本守卫把这条易漏点变成**测试期**错误：新增 watcher 时忘了去 defaults.ts 声明，这里就红。
 * （同类易漏：新增 watcher 还要动 ① manager 的 specs 表 ② 依赖经 runtime-contributions 透传
 *   —— 那两处漏了会编译报错，只有"默认值"这处是**静默**的，所以最需要守卫。）
 */
import { describe, expect, it } from 'vitest';
import { HotReloadManager } from './manager.js';
import { getDefaultConfig } from '../runtime/defaults.js';

describe('watcher 开关的声明完整性', () => {
  it('每个 watcher spec 的 flag 都必须在 getDefaultConfig() 里有默认值', () => {
    // watcherSpecs() 是纯方法（只返回字面量表、不碰 this.deps）⇒ 空依赖即可构造
    const mgr = new HotReloadManager({} as never);
    const specs = (mgr as unknown as { watcherSpecs(): { flag?: string }[] }).watcherSpecs();

    const flags = specs
      .map((s) => s.flag)
      .filter((f): f is string => typeof f === 'string' && f.length > 0);

    // 防假绿：表空了会让下面的循环空转、断言恒真
    expect(flags.length, 'watcherSpecs() 里应当有多个带开关的条目').toBeGreaterThanOrEqual(10);

    const cfg = getDefaultConfig() as unknown as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    for (const flag of flags) {
      const [section, key] = flag.split('.');
      const value = section && key ? cfg[section]?.[key] : undefined;
      if (value === undefined) missing.push(flag);
    }

    // 失败信息要能直接告诉人"该怎么办"
    expect(
      missing,
      `以下 watcher 开关没有默认值 ⇒ 它们的 watcher 永不注册（去 src/runtime/defaults.ts 补声明）：${missing.join(', ')}`,
    ).toEqual([]);
  });
});
