// ============================================================
// world-engine / types — 世界数据结构
// ============================================================
//
// world.json 的 schema。世界从对话中"长出来"：初始为空，
// 后置 WorldAgent 根据对话逐渐创建地点/物品/NPC。
//
// 写入者所有权（关键约束，由工具层强制）：
//   ambient          → WorldTicker 独占
//   locations        → WorldAgent 创建/精修
//   npcs 静态字段     → WorldAgent 创建后只读（desc/persona/home/roaming/mobility）
//   npcs.location    → WorldTicker 放置
//   state.*          → WorldAgent 独占（当前位置 / 场景变更 / 最近事件 / 社会关系等）
// ============================================================

/** 环境 —— WorldTicker 独占写 */
export interface Ambient {
  /** 世界内时间（ISO 字符串） */
  time: string;
  /** 时段（清晨/上午/下午/晚上…），由 time 推导。世界时间经 timeScale 折算、与现实时钟脱钩，模型无法凭数字判断昼夜，故显式给出 */
  period: string;
  weather: string;
  season: string;
  temperature: number;
}

/** 物品的空间相对位置：object 在 anchor 的 relation 处（如 花瓶 在 柜子 上） */
export interface ObjectPlacement {
  object: string;
  /** 关系：上/里/下/旁边/附近 等 */
  relation: string;
  /** 参照物（另一件物品或家具，如"柜子""床"） */
  anchor: string;
}

/** 地点 —— WorldAgent 增长/精修 */
export interface WorldLocation {
  desc: string;
  /** 地点内的物品 */
  objects: string[];
  /** 物品的相对摆放（花瓶在柜子上、柜子在床旁），由 WorldAgent 维护 */
  layout?: ObjectPlacement[];
  /** 临近可见地点 id（读取时只带一层摘要，不再展开——防无限递归） */
  visible: string[];
  /** 可移动到的地点 id */
  connects: string[];
  /** 主人（角色名，如"柔柔"）。为空表示公共场所。主人在此地是主人不是客人 */
  owner?: string;
}

/**
 * NPC —— desc/persona/home/roaming/mobility 由 WorldAgent 创建后只读；
 * location 由 WorldTicker 概率放置；state 由 WorldAgent 更新。
 */
export interface WorldNpc {
  desc: string;
  /** 别名/其他称呼（昵称、头衔、全名等），如 徐青 的 aliases=[小青, 蛋糕店老板]。由 WorldAgent 维护 */
  aliases?: string[];
  /** 种族/物种（如"兔子""天马"）——属性，非身份；同族不同个体各建各的记录。由 WorldAgent 维护 */
  race?: string;
  /** 认知留痕：这个 NPC 的身份是如何被逐渐了解的（初见→得知名字/性格/住处…）。由 WorldAgent 维护 */
  note?: string;
  /** 人设，喂给 NPC 回应生成 */
  persona: string;
  /** 常驻地点 id（可多个） */
  home: string[];
  /** 0..1，离开 home 去邻近地点的概率 */
  roaming: number;
  /** anchored=基本不动 / free=会到处逛 */
  mobility: 'anchored' | 'free';
  /** 当前实际位置（Ticker 写） */
  location: string;
  /** 当前状态描述（Agent 写） */
  state: string;
}

/**
 * 社会关系（有向边）。可连接任意角色：主角 / 陪伴角色 / NPC。
 * 语义："to 是 from 的 <type>"。对称关系（朋友/恋人）记一条即可；
 * 有方向的（宠物：安吉尔是柔柔的宠物 → from=柔柔 to=安吉尔 type=宠物）方向有意义。
 * 由 observe agent 依对话判断更新——不随时间自动变化。
 */
export interface Relationship {
  from: string;
  to: string;
  /** 关系类型：陌生人 / 朋友 / 好友 / 恋人 / 家人 / 宠物 / 主人 / 同事 ... */
  type: string;
  /** 可选补充说明（如"刚认识，还有些拘谨"） */
  note?: string;
}

/**
 * 角色身份的动态补充（旁路随对话逐渐"认识"一个角色时积累的信息）。
 * 以角色【规范名】为键（个体），与配置身份叠加。由 observe agent 依对话演变。
 *
 * 关键：race（种族）是"属性"，不是"身份键"——同种族的不同个体各有各的记录，
 * 绝不因同族而合并。别名（aliases）只统一"同一个体的多个称呼"，从不跨个体。
 */
export interface CharacterInfo {
  /** 种族/物种（如"天马""独角兽"）。属性，非身份键 */
  race?: string;
  /** 旁路学到的其他称呼（名字/昵称/外号/全名）；与配置 aliases 取并集，都指同一个体 */
  aliases?: string[];
  /** 认知留痕：这个角色的身份是如何被逐渐了解的（初见只知种族 → 第N轮得知名字 → 后来知道昵称…） */
  note?: string;
}

/**
 * 声明式自定义动态类型：让 LLM 用受限的规则（而非代码）定义新的动态对象种类，
 * 框架按规则演化。用于内置 snow/plant/timer 覆盖不了的东西（融化的冰淇淋、燃烧的蜡烛…）。
 */
export interface KindSpec {
  kind: string;
  desc?: string;
  /** amount 每"世界小时"的基础变化率（正=增长/积累，负=衰减/消耗） */
  ratePerHour: number;
  /** 温度影响：有效速率 += tempFactor × 当前温度（如冰淇淋 tempFactor<0，越热化越快） */
  tempFactor?: number;
  /** amount 上限，默认 100 */
  max?: number;
  /** amount ≤ 此值则移除该对象（如融化殆尽消失）；不填=不自动移除 */
  removeAtOrBelow?: number;
  /** 初始 amount；不填时：衰减型默认满值，增长型默认 0 */
  start?: number;
  /** 阶段标签，按 amount 阈值从高到低匹配 */
  phases?: Array<{ atOrAbove: number; label: string }>;
}

/**
 * 框架维护的动态对象：由 Ticker 按世界时间+环境自动演化（雪/植物/计时器等）。
 * LLM 负责"造出来"（world_spawn_sim），框架负责演化。见 sim.ts。
 */
export interface SimObject {
  id: string;
  /** 行为类型：snow / plant / timer / …（决定演化规则） */
  kind: string;
  /** 所在地点 id */
  location: string;
  desc?: string;
  /** 通用动态量 0-100：雪量 / 植物成熟度 / 计时进度 */
  amount: number;
  /** 当前阶段标签：积雪/融化中；生长中/成熟；进行中/完成 */
  phase?: string;
  /** kind 相关参数（如 plant 的 multiHarvest/growthRate、timer 的 durationHours） */
  params?: Record<string, unknown>;
}

// 【未来·用户↔NPC 交互】此处曾有 NpcPin（把 NPC 钉在某地）接口，
// 因唯一触发者 world_npc_react 已随"隔离 NPC 交互"移除而成为死代码，故清理。
// 将来重做"用户↔NPC 独立交互"时，若需要"临时钉住 NPC/待注入 NPC 回应"，
// 可在 WorldState 里重新引入（参考 git 历史里的 NpcPin / pendingNpcResponse）。

/** 动态状态 —— WorldAgent 独占写 */
export interface WorldState {
  /** 用户/主角当前所在地点 id */
  location: string;
  /** 陪伴角色（如柔柔）当前所在地点 id。narrate 服务于主 LLM，故以此作为"她的场景"；多数时候与 location 相同（在一起） */
  companionLocation: string;
  /** 对基础环境的临时变更（如 "灯关了"） */
  sceneOverrides: Record<string, string>;
  /** 最近发生的事（有上限，见 WorldStore.MAX_EVENTS） */
  recentEvents: string[];
  /** 主角/陪伴角色的动态身份补充（旁路随对话学到的种族/别名/认知留痕），以规范名为键，与配置身份叠加 */
  characters: Record<string, CharacterInfo>;
  // 【未来·用户↔NPC 交互】NPC 钉住(npcPins)、待注入回应(pendingNpcResponse) 等字段将来在此扩展
}

export interface WorldMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** 一个完整的世界 */
export interface World {
  meta: WorldMeta;
  ambient: Ambient;
  locations: Record<string, WorldLocation>;
  npcs: Record<string, WorldNpc>;
  /** 社会关系图（有向边），由 observe agent 依对话演变 */
  relationships: Relationship[];
  /** 框架维护的动态对象（雪/植物/计时器等） */
  simObjects: Record<string, SimObject>;
  /** LLM 声明的自定义动态类型（内置类型之外） */
  customKinds: Record<string, KindSpec>;
  state: WorldState;
}

/** readEnvironment() 的返回：当前地点的环境快照（供旁白化） */
export interface EnvironmentSnapshot {
  /** 场景地点 = 陪伴角色所在地（narrate 服务于她） */
  location: string;
  /** 用户/主角当前所在地点（与 location 相同则两人同场） */
  userLocation: string;
  /** 用户/主角是否也在此场景（与陪伴角色同地） */
  userPresent: boolean;
  desc: string;
  /** 地点主人（角色名）；为空表示公共场所 */
  owner?: string;
  objects: string[];
  /** 物品相对摆放（花瓶在柜子上…） */
  layout: ObjectPlacement[];
  /** 对基础环境的临时变更 */
  sceneOverrides: Record<string, string>;
  ambient: Ambient;
  /** 临近可见地点（单层摘要） */
  visible: Array<{ id: string; desc: string }>;
  /** 当前在场的 NPC（含其主标识 id） */
  npcs: Array<WorldNpc & { id: string }>;
  /** 与当前场景相关的社会关系（涉及主角/陪伴/在场 NPC） */
  relationships: Relationship[];
  /** 主角/陪伴角色的动态身份补充（种族/别名/留痕），供旁白按规范名叠加渲染 */
  characters: Record<string, CharacterInfo>;
  /** 当前地点的动态对象（雪/植物/计时器等） */
  simObjects: SimObject[];
  /** 最近事件（截断） */
  recentEvents: string[];
}

/**
 * 由小时（0-23）推导"时段"标签。世界时间经 timeScale 折算、与现实时钟脱钩，
 * 模型无法凭 "09:50" 这样的数字判断是上午还是晚上，故显式给出语义标签。
 */
export function periodOf(hour: number): string {
  if (hour < 5) return '凌晨';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '晚上';
  return '深夜';
}

/** 创建一个空世界（world 从对话中生长，初始无地点/NPC） */
export function createEmptyWorld(id: string, name: string, now: Date): World {
  const iso = now.toISOString();
  return {
    meta: { id, name, createdAt: iso },
    ambient: { time: iso, period: periodOf(now.getHours()), weather: '晴', season: '春', temperature: 20 },
    locations: {},
    npcs: {},
    relationships: [],
    simObjects: {},
    customKinds: {},
    state: {
      location: '',
      companionLocation: '',
      sceneOverrides: {},
      recentEvents: [],
      characters: {},
    },
  };
}
