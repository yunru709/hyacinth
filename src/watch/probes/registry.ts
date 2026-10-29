/**
 * Probe 注册表（2026-10-29）
 *
 * 为什么要有它：Watch 的 `kind` 会持续增加（UI 区域、文件、HTTP、进程、端口、
 * 将来还有剪贴板、窗口标题、DOM 选择器…）。如果写成 if/switch，
 * 这个文件三个月就会变成两千行上帝对象。
 *
 * 约定：**加一种类型 = 加一个文件 + 在 index.ts 里 register 一行**，
 * 不改任何既有代码路径。
 */

import type { Probe, WatchKind } from '../types.js';

const registry = new Map<WatchKind, Probe>();

/** 注册一个 Probe；同 kind 重复注册直接抛错（避免静默覆盖导致排查困难） */
export function registerProbe(probe: Probe): void {
  if (registry.has(probe.kind)) {
    throw new Error(`Probe already registered for kind "${probe.kind}"`);
  }
  registry.set(probe.kind, probe);
}

export function getProbe(kind: WatchKind): Probe {
  const p = registry.get(kind);
  if (!p) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown watch kind "${kind}"; available: ${known}`);
  }
  return p;
}

export function hasProbe(kind: string): kind is WatchKind {
  return registry.has(kind as WatchKind);
}

export function listProbes(): Probe[] {
  return [...registry.values()];
}

/** 仅供测试：清空注册表（生产代码不要调用） */
export function __resetProbeRegistry(): void {
  registry.clear();
}
