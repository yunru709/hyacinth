import type { RuntimeConfigCenter } from '../runtime/config-center.js';

/**
 * 工具配置出口 — 内置工具的参数默认值统一走 configCenter（tools.* 键）。
 *
 * 模式与 provider/local-config.ts 一致：factory.ts 初始化 configCenter 后注入，
 * 注入前（bootstrap / 单测）各工具回退硬编码默认值，零行为变化。
 *
 * 键位约定（schema/defaults 同步登记）：
 *   tools.read.maxLines            read 单次最大行数（默认 2000）
 *   tools.executor.timeoutMs       工具执行默认超时（默认 300000）
 *   tools.glob.maxResults          glob 最大返回条数（默认 1000）
 *   tools.grep.maxFileSizeBytes    grep 单文件扫描上限（默认 1MB）
 *   tools.bash.timeoutSec          bash 默认超时秒（默认 600）
 *   tools.bash.maxOutputBytes      bash 输出截断字节（默认 500KB）
 *   tools.http.timeoutMs           http_request 默认超时（默认 30000）
 *   tools.http.maxResponseBytes    http_request 响应截断字节（默认 50KB）
 *   tools.db.maxRows               db_query 最大返回行数（默认 200）
 */

let _configCenter: RuntimeConfigCenter | null = null;

/** 注入 RuntimeConfigCenter（factory.ts 初始化后调用）；传 null 还原（测试用） */
export function injectToolConfigCenter(cc: RuntimeConfigCenter | null): void {
  _configCenter = cc;
}

/** 读取工具配置键（tools.<key>），未注入/未配置/异常一律回退 fallback */
export function getToolConfig<T>(key: string, fallback: T): T {
  if (!_configCenter) return fallback;
  try {
    const v = _configCenter.get<T>(`tools.${key}`);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}
