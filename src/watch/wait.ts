/**
 * 同步等待核心（wait 模式，2026-10-29）
 *
 * 纯函数式的循环：给定一个 ProbeInstance，阻塞到「变化」或「超时」。
 * clock / sleep 可注入 —— 单测里用假时钟，毫秒级跑完，且不依赖真实系统。
 *
 * 判定规则（与 docs/watch.md 一致）：
 *   1. 首帧只作基准，不参与判定
 *   2. 每 intervalMs 采一帧，distance(基准, 当前) > threshold 记为一次命中
 *   3. 连续 settleFrames 帧命中才真正返回（压掉单帧闪烁）
 *   4. **未命中的帧会成为新基准** —— 否则缓慢漂移会累积成误报
 *   5. 采样失败不算变化；但会累计失败次数，在结果里体现为 degraded
 */

import type { ProbeInstance, ProbeSample, WatchKind, WatchResult } from './types.js';
import { defaultDistance } from './types.js';

export interface WaitOptions {
  kind: WatchKind;
  probe: ProbeInstance;
  timeoutMs: number;
  intervalMs?: number;
  threshold?: number;
  settleFrames?: number;
  /** 注入点（单测用） */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 500;
const MIN_INTERVAL_MS = 100;

export async function waitForChange(opts: WaitOptions): Promise<WatchResult> {
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const threshold = opts.threshold ?? 0;
  const settleFrames = Math.max(1, opts.settleFrames ?? 1);
  const distanceOf = opts.probe.distance ?? defaultDistance;

  const started = clock();
  const deadline = started + Math.max(0, opts.timeoutMs);

  const finish = (patch: Partial<WatchResult>): WatchResult => ({
    ok: true,
    changed: false,
    kind: opts.kind,
    distance: 0,
    elapsedMs: clock() - started,
    samples: samples,
    ...patch,
  });

  let samples = 0;
  let failures = 0;
  let baseline: ProbeSample | null = null;
  let streak = 0;
  let maxDistance = 0;
  let lastDistance = 0;

  const first = await opts.probe.sample(opts.signal);
  samples += 1;
  if (first.ok) {
    // 达成式 probe（process/port/带期望值的 http）：条件**一开始就成立**时立即返回。
    // 不这么做的话，首帧基准就是 met、之后一直 met、距离恒为 0 ⇒ 只能等到超时。
    // 2026-10-29 验收实测：wait(process explorer, expect=running) 返回 changed=false。
    if (opts.probe.isSatisfied?.(first)) {
      return finish({ changed: true, distance: 0 });
    }
    baseline = first;
  } else {
    failures += 1;
  }

  while (clock() < deadline) {
    if (opts.signal?.aborted) {
      return finish({ ok: false, error: 'aborted', distance: lastDistance, maxDistance });
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - clock())));
    if (clock() >= deadline) break;

    const current = await opts.probe.sample(opts.signal);
    samples += 1;

    if (!current.ok) {
      failures += 1;
      // 失败不是变化：保留旧基准，继续等
      continue;
    }

    if (!baseline) {
      // 之前一直失败，现在有了第一个有效样本：作为基准
      baseline = current;
      continue;
    }

    const d = distanceOf(baseline, current);
    lastDistance = d;
    if (d > maxDistance) maxDistance = d;

    if (d > threshold) {
      streak += 1;
      if (streak >= settleFrames) {
        return finish({ changed: true, distance: d, maxDistance });
      }
    } else {
      streak = 0;
      baseline = current; // 基准滚动，防漂移累积
    }
  }

  return finish({
    changed: false,
    distance: lastDistance,
    maxDistance,
    ...(failures > 0 && !baseline ? { ok: false, error: `all ${failures} samples failed` } : {}),
  });
}
