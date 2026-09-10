/**
 * 安全内核配置出口 —— 与 tools/tool-config.ts 同一模式：
 * gateway 装配层注入 configCenter 后，内核按 `security.*` 键读取；
 * 注入前（bootstrap 早期 / 单测）回退硬编码默认值，零行为差异。
 *
 * 键位约定（P1 登记 config-schema/defaults；P0 只读不写）：
 *   security.mode                     enforce | observe | off（默认 enforce，env HYACINTH_SECURITY_MODE 优先）
 *   security.envGuard                 balanced | strict | off（默认 balanced）
 *   security.network.blockPrivate     是否拦 LLM 归因的私网请求（默认 true）
 *   security.network.allowLoopback    私网拦截是否放行回环（默认 true）
 */

import type { SecurityMode } from './types.js';

/** 最小配置读取面（结构化兼容 RuntimeConfigCenter，避免 kernel 反向依赖 runtime 层） */
export interface SecurityConfigReader {
  get(path: string): unknown;
}

let _reader: SecurityConfigReader | null = null;

/** 注入配置读取面（gateway/wiring 调用）；传 null 还原（测试用） */
export function injectSecurityConfigReader(reader: SecurityConfigReader | null): void {
  _reader = reader;
}

/** 读 `security.<key>`，未注入/未配置/异常一律回退 fallback */
export function getSecurityConfig<T>(key: string, fallback: T): T {
  if (!_reader) return fallback;
  try {
    const v = _reader.get(`security.${key}`);
    return (v === undefined || v === null) ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/** 解析当前安全模式：env 优先（进程启动即生效）> configCenter > 默认 enforce */
export function resolveSecurityMode(): SecurityMode {
  const env = process.env.HYACINTH_SECURITY_MODE;
  if (env === 'observe' || env === 'enforce' || env === 'off') return env;
  return getSecurityConfig<SecurityMode>('mode', 'enforce');
}
