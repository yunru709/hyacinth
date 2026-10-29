/**
 * WatchService —— 后台挂起模式（2026-10-29）
 *
 * 与 wait 模式的差别：
 *   wait      ：调用方阻塞着，等到变化或超时才返回（适合短时等待）
 *   background：立刻返回 watchId，agent 完全空闲，变化时抛事件（适合长时等待）
 *
 * 本类只负责「跑探测、判变化、抛事件」，**不认识会话**：
 * 事件通过构造时注入的 `onEvent` 交出去，由上层决定是唤醒一轮对话、
 * 写日志、还是只堆在队列里等人来查。这样 watch 层不依赖 orchestrator/gateway。
 *
 * 唤醒风暴防护（必须）：
 * 一次变化可能引来一轮完整的 LLM 调用，而光标闪一下就能触发一次。
 * 因此每个 watch 命中后进入冷却期（默认 30s），期间不采样、不重复抛事件；
 * 冷却结束会自动重建基准继续监控，避免"一直在命中"的持续风暴。
 */

import type { ProbeInstance, ProbeSample, WatchKind, WatchSpec } from './types.js';
import { defaultDistance } from './types.js';
import type { ProbeRegistry } from './probes/registry.js';

/** 监控的归属会话：事件只能唤醒"登记它"的那个会话，否则多会话会互相串线 */
export interface WatchOwner {
  channel: string;
  sessionId: string;
}

export interface WatchEvent {
  watchId: string;
  kind: WatchKind;
  /** 变化程度（指纹距离） */
  distance: number;
  /** 触发时刻（ms） */
  at: number;
  note?: string;
  /** 便于人读的 spec 摘要 */
  summary: string;
  /** 登记该监控的会话（无归属时不唤醒，只记事件） */
  owner?: WatchOwner;
}

export interface WatchInfo {
  watchId: string;
  kind: WatchKind;
  note?: string;
  startedAt: number;
  /** 累计触发次数 */
  hits: number;
  /** 累计采样次数 */
  samples: number;
  /** 最近一次采样错误（若有） */
  lastError?: string;
  /** 是否处于冷却中 */
  cooling: boolean;
  summary: string;
  once: boolean;
  /**
   * 归属会话（2026-10-29）：undefined 表示"只记事件、不唤醒"。
   * 暴露出来是为了 ① 诊断时能看出监控属于哪个会话；② 测试能验证归属正确。
   */
  owner?: WatchOwner;
}

export interface StartOptions {
  note?: string;
  intervalMs?: number;
  threshold?: number;
  settleFrames?: number;
  /** 触发一次后自动停止 */
  once?: boolean;
  cooldownMs?: number;
  /** 归属会话：事件触发时用于唤醒对应会话 */
  owner?: WatchOwner;
}

export interface WatchServiceOptions {
  registry: ProbeRegistry;
  /** 事件出口。上层可在此唤醒会话 / 记日志 */
  onEvent: (event: WatchEvent) => void | Promise<void>;
  defaultIntervalMs?: number;
  defaultCooldownMs?: number;
  clock?: () => number;
  /** 注入点（单测用假定时器） */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const MIN_INTERVAL_MS = 200;

interface Entry {
  info: WatchInfo;
  spec: WatchSpec;
  probe: ProbeInstance;
  baseline: ProbeSample | null;
  streak: number;
  threshold: number;
  settleFrames: number;
  intervalMs: number;
  cooldownMs: number;
  coolingUntil: number;
  timer: unknown;
  owner?: WatchOwner;
}

function summarize(spec: WatchSpec): string {
  switch (spec.kind) {
    case 'file':
      return `file ${spec.path} (${spec.watch ?? 'content'})`;
    case 'http':
      return `http ${spec.method ?? 'GET'} ${spec.url}`;
    case 'process':
      return `process ${spec.pid !== undefined ? `pid=${spec.pid}` : spec.name} ${spec.expect}`;
    case 'port':
      return `port ${spec.host ?? '127.0.0.1'}:${spec.port} ${spec.expect}`;
    case 'ui_region':
      return `ui_region ${spec.region ? spec.region.join(',') : 'fullscreen'}`;
    default:
      return (spec as { kind: string }).kind;
  }
}

export class WatchService {
  private entries = new Map<string, Entry>();
  private seq = 0;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(private readonly opts: WatchServiceOptions) {
    this.now = opts.clock ?? (() => Date.now());
    this.setIntervalFn =
      opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown as { unref?: () => void });
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as never));
  }

  start(spec: WatchSpec, options: StartOptions = {}): WatchInfo {
    const probe = this.opts.registry.create(spec);
    const watchId = `w${++this.seq}-${spec.kind}`;
    const intervalMs = Math.max(
      MIN_INTERVAL_MS,
      options.intervalMs ?? this.opts.defaultIntervalMs ?? DEFAULT_INTERVAL_MS,
    );

    const info: WatchInfo = {
      watchId,
      kind: spec.kind,
      note: options.note,
      startedAt: this.now(),
      hits: 0,
      samples: 0,
      cooling: false,
      summary: summarize(spec),
      once: options.once ?? false,
      owner: options.owner,
    };

    const entry: Entry = {
      info,
      spec,
      probe,
      baseline: null,
      streak: 0,
      threshold: options.threshold ?? 0,
      settleFrames: Math.max(1, options.settleFrames ?? 1),
      intervalMs,
      cooldownMs: Math.max(0, options.cooldownMs ?? this.opts.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS),
      coolingUntil: 0,
      timer: null,
      owner: options.owner,
    };

    entry.timer = this.setIntervalFn(() => {
      void this.tick(watchId);
    }, intervalMs);
    // 不阻止进程退出
    const t = entry.timer as { unref?: () => void };
    if (typeof t?.unref === 'function') t.unref();

    this.entries.set(watchId, entry);
    return { ...info };
  }

  stop(watchId: string): boolean {
    const entry = this.entries.get(watchId);
    if (!entry) return false;
    this.clearIntervalFn(entry.timer);
    entry.probe.dispose?.();
    this.entries.delete(watchId);
    return true;
  }

  list(): WatchInfo[] {
    const now = this.now();
    return [...this.entries.values()].map((e) => ({
      ...e.info,
      cooling: e.coolingUntil > now,
    }));
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }

  /** 抛事件 + 进冷却 + once 自停。抽出来是因为「首帧即达成」和「中途变化」都要走它。 */
  private async fire(watchId: string, entry: Entry, distance: number): Promise<void> {
    const now = this.now();
    entry.info.hits += 1;
    entry.streak = 0;
    entry.coolingUntil = now + entry.cooldownMs;

    const event: WatchEvent = {
      watchId,
      kind: entry.spec.kind,
      distance,
      at: now,
      note: entry.info.note,
      summary: entry.info.summary,
      owner: entry.owner,
    };

    try {
      await this.opts.onEvent(event);
    } catch {
      /* 事件消费方的异常不影响监控本身 */
    }

    if (entry.info.once) this.stop(watchId);
  }

  /** 单次 tick：采样 → 判变化 → 抛事件 / 重建基准。异常全部吞掉并记录，绝不让定时器崩。 */
  private async tick(watchId: string): Promise<void> {
    const entry = this.entries.get(watchId);
    if (!entry) return;

    const now = this.now();
    if (entry.coolingUntil > now) return; // 冷却中：不采样、不抛事件

    if (entry.coolingUntil !== 0 && entry.coolingUntil <= now) {
      // 冷却结束：**只重建基准，不判定、不触发**。
      //
      // ⚠️ 2026-10-30 真机实测 bug：这里原来是 `entry.baseline = null`，
      //    下一帧立刻走 `!baseline → isSatisfied(sample) → fire(w, entry, 0)` 的
      //    首帧短路。于是「达成式条件只要持续成立」（如微信一直不在）就每过一个
      //    冷却周期重报一次 —— 实测 hits 涨到 11、distance 全为 0，
      //    同一条 say 被反复播报十几次，用户明确反馈"一直在反复说话"。
      //
      // 正确语义：冷却结束后把**当前状态**作为新基准。
      //   状态没变 ⇒ distance 恒为 0 ⇒ 不会再触发；
      //   状态若已回到未达成（如微信重新启动）⇒ 基准更新，下次再达成时可正常触发。
      entry.coolingUntil = 0;
      entry.streak = 0;
      try {
        const s = await entry.probe.sample();
        entry.info.samples += 1;
        entry.baseline = s.ok ? s : null;
      } catch {
        entry.baseline = null;
      }
      return; // 本帧只重建基线，不参与判定
    }

    let sample: ProbeSample;
    try {
      sample = await entry.probe.sample();
    } catch (err) {
      entry.info.lastError = (err as Error).message;
      return;
    }
    entry.info.samples += 1;

    if (!sample.ok) {
      entry.info.lastError = sample.error ?? 'sample failed';
      return; // 失败不算变化
    }
    entry.info.lastError = undefined;

    if (!entry.baseline) {
      // 达成式 probe（process/port/带期望值的 http）：首帧就成立时立即触发一次。
      // 否则基准=met，之后一直 met，距离恒为 0 ⇒ 永远不触发（与 wait 同一缺陷）。
      if (entry.probe.isSatisfied?.(sample)) {
        await this.fire(watchId, entry, 0);
        return;
      }
      entry.baseline = sample;
      return;
    }

    const baseline = entry.baseline;
    const distanceOf = entry.probe.distance ?? defaultDistance;
    const d = distanceOf(baseline, sample);

    if (d > entry.threshold) {
      entry.streak += 1;
      if (entry.streak < entry.settleFrames) return;

      // ⚠️ 达成式 probe 只报「**新达成**」（pending → met），反向不算命中。
      //
      // `distance` 只表示"变了"，**不区分方向**；而 process probe 的 value 只有
      // 'met' / 'pending' 两种。不在这里拦方向，就会出现
      // 「微信启动也说一句、关闭也说一句」
      //（2026-10-30 用户实测指出：声音是在**启动**时听到的，而不是关闭时）。
      //
      // 只有带 isSatisfied 的达成式 probe（process / port / 带期望值的 http）需要方向判定；
      // 纯变化型（file / ui_region）没有 isSatisfied，行为完全不变。
      if (entry.probe.isSatisfied) {
        if (!entry.probe.isSatisfied(sample)) return; // 现在未达成 ⇒ 不是命中
        if (entry.probe.isSatisfied(baseline)) return; // 之前已达成 ⇒ 不是"新"达成
      }

      await this.fire(watchId, entry, d);
      return;
    }

    // 未命中：基准滚动，防缓慢漂移累积误报
    entry.streak = 0;
    entry.baseline = sample;
  }
}
