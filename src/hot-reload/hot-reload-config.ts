import type { RuntimeConfigCenter } from '../runtime/config-center.js';

/**
 * 热重载配置出口 — watcher-base 的 poll 模式默认轮询间隔走 configCenter（hotReload.* 键）。
 *
 * 模式与 tools/tool-config.ts 等一致：factory.ts 初始化 configCenter 后注入；
 * 注入前（bootstrap / 单测）回退硬编码默认值，零行为变化。
 *
 * 键位约定（schema/defaults 同步登记；其余 hotReload.* 键由 manager.ts 消费）：
 *   hotReload.pollIntervalMs  poll 模式轮询间隔（默认 5000）
 */

let _configCenter: RuntimeConfigCenter | null = null;

/** 注入 RuntimeConfigCenter（factory.ts 初始化后调用）；传 null 还原（测试用） */
export function injectHotReloadConfigCenter(cc: RuntimeConfigCenter | null): void {
  _configCenter = cc;
}

/** 读取 hotReload 配置键，未注入/未配置/异常一律回退 fallback */
export function getHotReloadConfig<T>(key: string, fallback: T): T {
  if (!_configCenter) return fallback;
  try {
    const v = _configCenter.get<T>(`hotReload.${key}`);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function pollIntervalMs(): number {
  return getHotReloadConfig<number>('pollIntervalMs', 5000);
}
