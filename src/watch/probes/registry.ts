/**
 * Probe 注册表（2026-10-29）
 *
 * 为什么要有这一层：`watch` 是个"万能监控"工具，如果所有 kind 都写在一个
 * switch 里，三个月后必然是两千行的上帝对象。这里强制一个 kind 一个文件、
 * 实现 `Probe` 接口、在注册表登记，加新类型=加文件+一行注册。
 */

import type { Probe, ProbeInstance, WatchKind, WatchSpec } from '../types.js';

export class ProbeRegistry {
  private probes = new Map<WatchKind, Probe>();

  register(probe: Probe): void {
    this.probes.set(probe.kind, probe);
  }

  get(kind: WatchKind): Probe | undefined {
    return this.probes.get(kind);
  }

  has(kind: WatchKind): boolean {
    return this.probes.has(kind);
  }

  /** 已注册的 kind 列表（进工具描述） */
  kinds(): WatchKind[] {
    return [...this.probes.keys()].sort();
  }

  /** kind → 一行说明（进工具描述） */
  describe(): Array<{ kind: WatchKind; description: string }> {
    return this.kinds().map((k) => ({ kind: k, description: this.probes.get(k)!.description }));
  }

  /**
   * 按 spec 产出实例。未注册的 kind 抛错（而不是静默返回 undefined），
   * 因为调用方是工具层，需要把错误原样告诉模型。
   */
  create(spec: WatchSpec): ProbeInstance {
    const probe = this.probes.get(spec.kind);
    if (!probe) {
      throw new Error(
        `unknown watch kind '${spec.kind}'; registered: ${this.kinds().join(', ') || '(none)'}`,
      );
    }
    return probe.create(spec);
  }
}
