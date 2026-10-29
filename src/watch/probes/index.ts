/**
 * 默认 Probe 注册表组装（2026-10-29）
 *
 * 加新 kind 只需要：写一个实现 `Probe` 的文件 → 在这里 register 一行。
 * 不要在这个文件里写任何判定逻辑（那属于 wait.ts / watch-service.ts）。
 */

import { fileProbe } from './file.js';
import { httpProbe } from './http.js';
import { portProbe } from './port.js';
import { processProbe } from './process.js';
import { ProbeRegistry } from './registry.js';
import { uiRegionProbe } from './ui-region.js';

export { ProbeRegistry } from './registry.js';
export { fileProbe } from './file.js';
export { httpProbe } from './http.js';
export { portProbe } from './port.js';
export { processProbe } from './process.js';
export { uiRegionProbe, setDefaultRegionSampler, hammingDistanceHex } from './ui-region.js';
export type { RegionSampler } from './ui-region.js';

/** 默认注册表：当前实现的 5 种 probe */
export function createDefaultProbeRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry();
  registry.register(fileProbe);
  registry.register(httpProbe);
  registry.register(portProbe);
  registry.register(processProbe);
  // ui_region 的采样器惰性解析：默认 PowerShell 兜底，
  // 上层可用 setDefaultRegionSampler() 换成更快实现（如 MCP GrabRegionHash）
  registry.register(uiRegionProbe);
  return registry;
}
