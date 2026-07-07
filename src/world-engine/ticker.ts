// ============================================================
// world-engine / ticker — WorldTicker
// ============================================================
//
// 世界的"自动管理程序"：用模块内部定时器推进环境基础内容。
// 不依赖任务调度器，start() 起定时器、stop() 清定时器，保证模块自包含。
//
// 职责（Ticker 独占写的字段）：
//   1. 推进世界时间（ambient.time），按 timeScale 相对现实时间流逝
//   2. 依时间推导季节
//   3. 低概率变天气
//   4. 按 home + roaming 概率放置 NPC（跳过被 pin 的），不乱窜
//   5. 清理已过期的时间型 pin
// ============================================================

import type { World } from './types.js';
import { periodOf } from './types.js';
import type { WorldStore } from './store.js';
import { evolveSim } from './sim.js';

export interface WorldTickerOptions {
  /** 心跳间隔（毫秒），默认 5s */
  heartbeatMs?: number;
  /** 世界时间流速倍率：世界时间 = 现实流逝 × timeScale。默认 1（与现实时间 1:1 同步），>1 则世界更快 */
  timeScale?: number;
  /** 一种天气平均持续的【世界小时】数，默认 4（随 timeScale 自动缩放：1:1 时约 4 现实小时） */
  weatherAvgHours?: number;
  /** 降水前"阴天"需持续的【世界小时】数，默认 1.5（下雨前先阴一阵，符合现实） */
  overcastHoursBeforeRain?: number;
}

// 天气只在相邻状态间过渡，避免"晴→暴雨"式突变；数组内重复项 = 更倾向保持/趋向该状态
const WEATHER_TRANSITIONS: Record<string, string[]> = {
  '晴':   ['晴', '晴', '晴', '多云'],
  '多云': ['多云', '多云', '晴', '阴', '雾'],
  '阴':   ['阴', '阴', '多云', '小雨'],
  '小雨': ['小雨', '小雨', '阴'],
  '雪':   ['雪', '雪', '阴'],
  '雾':   ['雾', '多云', '晴'],
};

/** 各季节基准气温 */
const SEASON_BASE_TEMP: Record<string, number> = { '春': 18, '夏': 30, '秋': 16, '冬': 4 };

/**
 * 让天气符合季节：冬天的降水是雪、其余季节是雨；防止"夏天下雪""冬天下雨"这类不合理天气。
 */
function seasonalizeWeather(weather: string, season: string): string {
  if (season === '冬') {
    if (weather === '小雨') return '雪'; // 冬天降水 → 雪
  } else if (weather === '雪') {
    return '小雨'; // 非冬季不下雪 → 转为雨
  }
  return weather;
}

/** 把世界时间格式化为本地可读串（YYYY-MM-DD HH:mm），供旁白/展示 */
function fmtLocalTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 由月份推导季节（北半球） */
function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

/** 昼夜温差：正午偏暖，凌晨偏冷 */
function dayNightOffset(hour: number): number {
  if (hour >= 12 && hour < 16) return 3;
  if (hour >= 10 && hour < 18) return 1;
  if (hour >= 6 && hour < 10) return -2;
  if (hour >= 18 && hour < 22) return -1;
  return -4; // 深夜/凌晨
}

export class WorldTicker {
  private readonly store: WorldStore;
  private readonly heartbeatMs: number;
  private readonly timeScale: number;
  private readonly weatherAvgHours: number;
  private readonly overcastHoursBeforeRain: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 当前天气已持续的【世界小时】数（用于"阴天酝酿够久才下雨"，按世界时间而非心跳数计） */
  private weatherDwellHours = 0;

  constructor(store: WorldStore, opts: WorldTickerOptions = {}) {
    this.store = store;
    this.heartbeatMs = opts.heartbeatMs ?? 5000;
    this.timeScale = opts.timeScale ?? 1;
    this.weatherAvgHours = opts.weatherAvgHours ?? 4;
    this.overcastHoursBeforeRain = opts.overcastHoursBeforeRain ?? 1.5;
  }

  /** 本次心跳流逝的世界小时数（= 现实流逝 × timeScale） */
  private worldHoursPerTick(): number {
    return (this.heartbeatMs * this.timeScale) / 3_600_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    // 定时器不应阻止进程退出
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 单次推进（也可供测试直接调用） */
  tick(now: Date = new Date()): void {
    const w = this.store.getWorld();
    if (!w) return;

    const worldHours = this.worldHoursPerTick();
    const prevWeather = w.ambient.weather;
    this.store.batch(world => {
      this.advanceTime(world, now);
      this.maybeChangeWeather(world, worldHours);
      this.evolveSimObjects(world, worldHours); // 在 ambient 更新后，让雪等对象按最新温度演化
      // 【未来·用户↔NPC 交互】此处曾调 cleanExpiredPins（清理过期的 NPC 钉住），随 pin 机制清理而移除
      this.placeNpcs(world);
    });
    // 记录天气驻留时长（世界小时）：不变则累加流逝，变了则清零
    const now2 = this.store.getWorld();
    if (now2) this.weatherDwellHours = now2.ambient.weather === prevWeather ? this.weatherDwellHours + worldHours : 0;
  }

  // ── 动态对象演化（雪化/植物生长/计时） ───────────────────
  private evolveSimObjects(w: World, worldHours: number): void {
    for (const [id, sim] of Object.entries(w.simObjects)) {
      if (!evolveSim(sim, w.ambient, worldHours, w.customKinds)) delete w.simObjects[id];
    }
  }

  // ── 时间 + 季节 ─────────────────────────────────────────
  private advanceTime(w: World, now: Date): void {
    const createdMs = Date.parse(w.meta.createdAt);
    if (isNaN(createdMs)) return;
    // 世界时间 = 创建时刻 + 现实流逝 × 倍率。
    // timeScale=1 时即与现实时间精确 1:1（无累积漂移；进程离线后重启也不会落后，每次按现实实时计算）。
    const worldDate = new Date(createdMs + (now.getTime() - createdMs) * this.timeScale);
    // 用本地时间分量，让"时段/季节"贴合用户真实所在时区
    w.ambient.time = fmtLocalTime(worldDate);
    w.ambient.period = periodOf(worldDate.getHours());
    w.ambient.season = seasonOf(worldDate.getMonth() + 1);
    // 换季后修正不合季节的天气（如入春后仍是"雪"→改"小雨"）
    w.ambient.weather = seasonalizeWeather(w.ambient.weather, w.ambient.season);
    this.driftTemperature(w, worldDate.getHours());
  }

  /** 温度平滑趋近"季节基准+昼夜偏移"的目标，每次最多变 1 度，不突变 */
  private driftTemperature(w: World, hour: number): void {
    const base = SEASON_BASE_TEMP[w.ambient.season] ?? 20;
    let target = base + dayNightOffset(hour);
    const wx = w.ambient.weather;
    if (wx === '小雨' || wx === '阴' || wx === '雪') target -= 2; // 阴雨雪天更冷
    if (w.ambient.temperature < target) w.ambient.temperature += 1;
    else if (w.ambient.temperature > target) w.ambient.temperature -= 1;
  }

  private maybeChangeWeather(w: World, worldHours: number): void {
    // 变天概率按【世界时间】算：平均每 weatherAvgHours 世界小时变一次天气。
    // 于是 1:1 时天气几小时才变一次（贴合现实）；timeScale 越大变得越快，自动缩放。
    const changeProb = worldHours / this.weatherAvgHours;
    if (Math.random() >= changeProb) return;
    // 只跳到相邻天气，保证渐变（晴→多云→阴→小雨），不会晴天秒变暴雨
    const options = WEATHER_TRANSITIONS[w.ambient.weather] ?? ['晴', '多云'];
    let next = seasonalizeWeather(options[Math.floor(Math.random() * options.length)], w.ambient.season);
    // 逻辑链条：降水（雨/雪）必须在"阴"酝酿够久（按世界小时）之后才发生；否则继续保持阴天铺垫
    if ((next === '小雨' || next === '雪') && this.weatherDwellHours < this.overcastHoursBeforeRain) {
      next = '阴';
    }
    w.ambient.weather = next;
  }

  // ── NPC 放置（概率驱动，锚定 home，不乱窜） ───────────────
  private placeNpcs(w: World): void {
    // 【未来·用户↔NPC 交互】曾在此跳过"被剧情 pin 的 NPC"，随 pin 机制清理而移除
    for (const [, npc] of Object.entries(w.npcs)) {
      // 正在当前场景（陪伴角色所在地）里的 NPC 不挪走，避免对话中途 NPC 凭空消失
      const scene = w.state.companionLocation || w.state.location;
      if (scene && npc.location === scene) continue;
      if (npc.mobility === 'anchored' && npc.home.includes(npc.location)) {
        // 锚定型且已在 home：小概率出门
        if (Math.random() < npc.roaming) {
          const target = this.pickRoamTarget(w, npc.location);
          if (target) npc.location = target;
        }
        continue;
      }
      // free 型或不在 home：按 roaming 决定出门 or 回家
      if (Math.random() < npc.roaming) {
        const target = this.pickRoamTarget(w, npc.location);
        if (target) npc.location = target;
      } else {
        // 回到 home 中的一个
        const home = npc.home[Math.floor(Math.random() * npc.home.length)];
        if (home && w.locations[home]) npc.location = home;
      }
    }
  }

  /** 从当前地点的相邻可达地点里挑一个（只走一步，不会瞬移到地图另一端） */
  private pickRoamTarget(w: World, from: string): string | null {
    const loc = w.locations[from];
    if (!loc || loc.connects.length === 0) return null;
    const candidates = loc.connects.filter(id => w.locations[id]);
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
