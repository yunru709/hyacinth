/**
 * Watch 模块类型定义（2026-10-29）
 *
 * 设计意图见 docs/watch.md。这里只强调一条最容易写错的约定：
 *
 *   **Probe 只回答「此刻是什么样」，不回答「变没变」。**
 *
 * Probe 每次采样返回一个可比较的指纹 `value`。是否算"变化"由上层
 * （wait 循环 / WatchService）用 `distance()` 和阈值判定。
 * 这样同一个 Probe 既能用于同步等待，也能用于后台挂起，还能被单测直接断言。
 *
 * 指纹取值建议（各 Probe 实现遵守，便于统一推理）：
 *   - 状态类（process / port / http-带期望值）：'met' | 'pending' —— 达成期望即 met
 *   - 内容类（file / http-无期望值 / ui_region）：内容摘要或哈希
 * 这样「pending → met」和「内容 A → 内容 B」都自然表现为 value 变化。
 */

export type WatchKind = 'ui_region' | 'file' | 'http' | 'process' | 'port';

/** UI 区域：[left, top, right, bottom]，虚拟桌面像素坐标 */
export type Region = [number, number, number, number];

export interface UiRegionSpec {
  kind: 'ui_region';
  /** 省略 = 全屏。强烈建议限定，否则光标闪烁即误报 */
  region?: Region;
  /** dHash 汉明距离阈值（0..64），默认 6 */
  threshold?: number;
}

export interface FileSpec {
  kind: 'file';
  path: string;
  /**
   * content：比对文件内容摘要（大文件取头尾各 64KB），对"写了一半"也敏感
   * mtime：比对 size+mtimeMs，开销极低但改回原样会漏
   */
  watch?: 'content' | 'mtime';
}

export interface HttpSpec {
  kind: 'http';
  url: string;
  method?: 'GET' | 'HEAD' | 'POST';
  /** 期望状态码；给定则命中时为 'met' */
  expectStatus?: number;
  /** 期望响应体包含的子串；给定则命中时为 'met' */
  expectContains?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 是否允许内网地址（默认 false，见 security 段） */
  allowPrivateHost?: boolean;
}

export interface ProcessSpec {
  kind: 'process';
  /** 二选一；name 为不区分大小写的进程名（不含 .exe 也可） */
  name?: string;
  pid?: number;
  /** running：等它出现；exit：等它结束 */
  expect: 'running' | 'exit';
}

export interface PortSpec {
  kind: 'port';
  host?: string;
  port: number;
  /** open：等端口可连；closed：等端口关闭 */
  expect: 'open' | 'closed';
  timeoutMs?: number;
  allowPrivateHost?: boolean;
}

export type WatchSpec = UiRegionSpec | FileSpec | HttpSpec | ProcessSpec | PortSpec;

/** 一次采样的结果 */
export interface ProbeSample {
  /** 采样本身是否成功（失败≠没变化，上层要区分） */
  ok: boolean;
  /** 可比较指纹；相等即"没变" */
  value: string;
  /** 供 distance() 使用的原始数据 */
  raw?: unknown;
  /** 采样失败原因 */
  error?: string;
}

/** 采样器实例：可有内部状态（如缓存），用后 dispose */
export interface ProbeInstance {
  sample(signal?: AbortSignal): Promise<ProbeSample>;
  /**
   * 0 = 未变，>0 = 变化程度。
   * 缺省语义：value 不相等则 1。UI 区域会重写为汉明距离。
   */
  distance?(baseline: ProbeSample, current: ProbeSample): number;
  dispose?(): void;
}

/** 采样器工厂 */
export interface Probe {
  readonly kind: WatchKind;
  /** 一行说明，进工具描述给模型看 */
  readonly description: string;
  /** 校验参数并产出实例；参数非法抛 Error（调用方转成 tool error） */
  create(spec: WatchSpec): ProbeInstance;
}

/** 一次等待/监控的结果 */
export interface WatchResult {
  ok: boolean;
  changed: boolean;
  kind: WatchKind;
  /** 命中的距离值 */
  distance: number;
  elapsedMs: number;
  /** 实际采样次数 */
  samples: number;
  /** 未命中时的最大距离（便于调阈值） */
  maxDistance?: number;
  error?: string;
}

/** 默认距离：指纹不同即 1 */
export function defaultDistance(a: ProbeSample, b: ProbeSample): number {
  return a.value === b.value ? 0 : 1;
}
