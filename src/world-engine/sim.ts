// ============================================================
// world-engine / sim — 框架维护的动态对象行为
// ============================================================
//
// 有一类对象不由 LLM 逐帧管理，而由框架（Ticker）按世界时间+环境自动演化：
//   雪   —— 受温度影响融化，化尽即消失（暖天化得快，严寒缓慢升华）
//   植物 —— 随时间生长到成熟；采摘后：一茬生消失，多茬生重新生长
//   计时 —— 如"正在运行的面包机"，进度到 100% 变为"完成"
//
// 扩展只需在 BEHAVIORS 里加一个 kind → 一套规则。LLM 负责"造出来"，框架负责"养着"。
// ============================================================

import type { Ambient, SimObject, KindSpec } from './types.js';

function num(v: unknown, def: number): number {
  return typeof v === 'number' && !isNaN(v) ? v : def;
}

export interface SimBehavior {
  /** 生成时的初始化（设定初始 amount/phase） */
  init(sim: SimObject): void;
  /** 按 worldHours（本次流逝的世界小时数）演化；返回 false 表示该对象应被移除 */
  tick(sim: SimObject, ambient: Ambient, worldHours: number): boolean;
}

const snow: SimBehavior = {
  init(s) {
    if (typeof s.amount !== 'number') s.amount = 100;
    s.phase = '积雪';
  },
  tick(s, ambient, h) {
    const temp = num(ambient.temperature, 0);
    if (temp > 0) {
      // 越暖化得越快
      s.amount -= temp * h * num((s.params as any)?.meltFactor, 0.8);
      s.phase = '融化中';
    } else {
      // 严寒时缓慢升华
      s.amount -= h * num((s.params as any)?.sublimeFactor, 0.05);
      s.phase = '积雪';
    }
    if (s.amount <= 0) {
      s.amount = 0;
      return false; // 化尽/蒸发 → 移除
    }
    return true;
  },
};

const plant: SimBehavior = {
  init(s) {
    if (typeof s.amount !== 'number') s.amount = 0;
    s.phase = s.amount >= 100 ? '成熟' : '生长中';
  },
  tick(s, _ambient, h) {
    const rate = num((s.params as any)?.growthRate, 100 / 24); // 默认 24 世界小时成熟
    if (s.amount < 100) s.amount = Math.min(100, s.amount + rate * h);
    s.phase = s.amount >= 100 ? '成熟' : s.amount <= 0 ? '幼苗' : '生长中';
    return true; // 植物不会自己消失，靠采摘处理
  },
};

const timer: SimBehavior = {
  init(s) {
    if (typeof s.amount !== 'number') s.amount = 0;
    s.phase = '进行中';
  },
  tick(s, _ambient, h) {
    const durH = num((s.params as any)?.durationHours, 0.1);
    if (s.amount < 100) s.amount = Math.min(100, s.amount + (100 / durH) * h);
    s.phase = s.amount >= 100 ? '完成' : '进行中';
    return true; // 完成后保留，等 LLM 处理（如"取出面包"）
  },
};

const BEHAVIORS: Record<string, SimBehavior> = { snow, plant, timer };

/** 内置动态对象类型 */
export function listSimKinds(): string[] {
  return Object.keys(BEHAVIORS);
}

// ── 声明式自定义类型的通用解释器 ──────────────────────────

/** 按 amount 匹配阶段标签（阈值从高到低） */
function phaseFor(spec: KindSpec, amount: number): string | undefined {
  if (!spec.phases?.length) return undefined;
  const sorted = [...spec.phases].sort((a, b) => b.atOrAbove - a.atOrAbove);
  return sorted.find(p => amount >= p.atOrAbove)?.label;
}

function initCustom(sim: SimObject, spec: KindSpec): void {
  const max = num(spec.max, 100);
  sim.amount = num(spec.start, spec.ratePerHour < 0 ? max : 0);
  sim.phase = phaseFor(spec, sim.amount);
}

function tickCustom(sim: SimObject, ambient: Ambient, h: number, spec: KindSpec): boolean {
  const max = num(spec.max, 100);
  const rate = spec.ratePerHour + num(spec.tempFactor, 0) * num(ambient.temperature, 0);
  sim.amount = Math.min(max, Math.max(0, sim.amount + rate * h));
  sim.phase = phaseFor(spec, sim.amount) ?? sim.phase;
  if (spec.removeAtOrBelow != null && sim.amount <= spec.removeAtOrBelow) return false;
  return true;
}

/** 生成时初始化。内置 kind 用内置规则；自定义 kind 用声明式规则；都没有则给默认量。 */
export function initSim(sim: SimObject, customKinds: Record<string, KindSpec> = {}): void {
  const b = BEHAVIORS[sim.kind];
  if (b) { b.init(sim); return; }
  const spec = customKinds[sim.kind];
  if (spec) { initCustom(sim, spec); return; }
  if (typeof sim.amount !== 'number') sim.amount = 100;
}

/** 演化一个动态对象；返回 false 表示应移除。未知 kind 不处理也不删。 */
export function evolveSim(
  sim: SimObject,
  ambient: Ambient,
  worldHours: number,
  customKinds: Record<string, KindSpec> = {},
): boolean {
  const b = BEHAVIORS[sim.kind];
  if (b) return b.tick(sim, ambient, worldHours);
  const spec = customKinds[sim.kind];
  if (spec) return tickCustom(sim, ambient, worldHours, spec);
  return true;
}
