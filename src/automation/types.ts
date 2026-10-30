/**
 * 自动化链路数据模型（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 核心定位：**模型是链路的设计者，运行时零 LLM 按图执行**
 * ────────────────────────────────────────────────────────────────────────────
 * 一条 AutomationRule = 一个 When（触发） + 一串 Action（动作链）。
 * 模型一次性生成它 → 之后每次触发都按这份数据确定性地执行，不再调用模型。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么是三个正维度：When × Where × What
 * ────────────────────────────────────────────────────────────────────────────
 * 旧的 `ScheduledTask` 把三者塞在一个对象里（scheduleType + sessionPolicy + action），
 * 看起来像一件事，实际是九种组合。这里把它们拆开：
 *
 *   When  —— 什么时候触发（时间 / 状态 / 事件）         ← 决定"何时"
 *   What  —— 做什么（invoke / wake / append / gate）     ← 决定"做什么"
 *   Where —— 唤醒模型时落在哪个会话（只在 wake 里出现）  ← 决定"在哪想"
 *
 * 这样：任何 When 都能配任何 What；Where 只有"要动脑子"的那类 Action 才需要。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 关键取舍：机械 vs 智能绝不合并
 * ────────────────────────────────────────────────────────────────────────────
 *   invoke（机械）：零 LLM，毫秒级，完全可复现 ⇒ 成本 0
 *   wake  （智能）：一轮完整 LLM 回合，秒级，结果不确定 ⇒ 成本 1 次调用
 *
 * 两者差 3 个数量级。合成一个 Sink 会让"便宜的事"被迫走"贵"的路
 * （2026-10-30 的 say 无声就是机械链路误用了为回合设计的入队语义）。
 *
 * 判据很简单：**触发的那一刻，我是否已经知道要说什么/做什么**。
 *   知道 ⇒ invoke；不知道 ⇒ wake。
 */

// ────────────────────────────────────────────────────────────────────────────
// When：触发源
// ────────────────────────────────────────────────────────────────────────────

/** 时间类触发的配置（沿用现有 ScheduleConfig 的宽松形态，避免跨层依赖） */
export interface TimeWhen {
  kind: 'time';
  /**
   * 调度配置，与 `src/schedule/types.ts` 的 ScheduleConfig 同构。
   * 这里用宽松类型而不是 import：automation 层不该依赖 schedule 业务核心，
   * 合法性由 scheduler 侧在登记时校验。
   *
   * ⚠️ 注意 random 是**有状态**的（periodStartAt / pendingSlots 要跨重启续用），
   *    统一 Source 接口时必须允许内部状态 + serialize/restore。
   */
  schedule: Record<string, unknown>;
}

/** 状态条件触发：由 WatchService 的 probe 采样驱动 */
export interface ProbeWhen {
  kind: 'probe';
  probe: {
    /** probe 类型：file / http / process / port / ui_region（可扩展，如 arm-position） */
    kind: string;
    /** 该 kind 自己的参数 */
    spec: Record<string, unknown>;
  };
  /** 采样间隔（毫秒），默认 2000 */
  intervalMs?: number;
  /** 命中后的冷却（毫秒），默认 30000 —— 防唤醒风暴 */
  cooldownMs?: number;
  /** 变化判定阈值（如 ui_region 的汉明距离） */
  threshold?: number;
  /** 连续 N 帧命中才算数，防单帧闪烁 */
  settleFrames?: number;
}

/** 事件触发：由 loop 钩子或外部事件源产生 */
export interface EventWhen {
  kind: 'event';
  /** 事件名，如 `afterToolExecute:write` / `onTurnEnd` / `afterScheduleTask` */
  event: string;
}

export type WhenSpec = TimeWhen | ProbeWhen | EventWhen;

// ────────────────────────────────────────────────────────────────────────────
// Where：唤醒模型时的会话落点（只有 wake 需要）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 会话策略 —— 这两者**语义完全不同，绝不合并**：
 *
 *   reuse：加载目标会话的**完整历史**。
 *          "在那个会话里接着上次说" —— 模型能综合之前的信息再判断。
 *
 *   new  ：临时会话，**干净上下文**，只有触发事件本身。
 *          "就事论事，别被历史干扰" —— 跑完即弃，不进会话列表。
 *
 * 用错会毁掉效果：需要连续上下文的任务用 new ⇒ 模型失忆；
 *                需要客观判断的任务用 reuse ⇒ 模型被旧结论带偏。
 */
export interface Where {
  policy: 'reuse' | 'new';
  /** 目标会话/渠道/模式。reuse 时用来判断"续哪个"；new 时是结果投递目标 */
  target?: {
    /** 渠道名：webui / tui / feishu … */
    channel?: string;
    /** 会话 id（多会话渠道靠它定位） */
    sessionId?: string;
    /** 模式（normal / companion / coding …），用于模式隔离 */
    mode?: string;
  };
  /** 目标渠道离线时的降级链，如 ['webui', 'tui'] */
  fallback?: string[];
  /** new 策略下临时会话的存活时间（毫秒），默认 5 分钟 */
  ttlMs?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// What：动作链
// ────────────────────────────────────────────────────────────────────────────

/** 机械执行：直接调一个工具，零 LLM */
export interface InvokeAction {
  sink: 'invoke';
  /** 工具名（须已注册） */
  tool: string;
  args?: Record<string, unknown>;
}

/** 往工具结果里追加信息（对应现有 append / enrich 类处理器） */
export interface AppendAction {
  sink: 'append';
  /** 处理器 id，如 `core.diagnostics-append` */
  handler: string;
}

/** 智能执行：唤醒一个会话，让它跑一轮模型 */
export interface WakeAction {
  sink: 'wake';
  where: Where;
  /** 给模型的提示词。省略则由事件信息自动生成 */
  prompt?: string;
}

/**
 * 执行后断言（闭环）：
 *   执行完前一步 → 检查断言 → 通过走 onPass / 不通过走 onFail。
 *
 * 这是「异常交回模型」的落点：onFail 里可以放 safety + wake。
 * 也是机械臂/长流程场景能表达的前提。
 */
export interface GateAction {
  sink: 'gate';
  assert: Assertion;
  onPass?: Action[];
  onFail?: Action[];
}

/**
 * 安全动作（物理/关键场景专用）。
 *
 * ⚠️ 设计约束：SafetySink **绕过 Binding 解析**，优先级最高。
 *    理由：急停不能等任何异步判定/排队。安全阈值判定必须在 probe 层（毫秒级），
 *    绝不能"等模型判断完再决定停不停"。
 */
export interface SafetyAction {
  sink: 'safety';
  action: 'hold' | 'stop' | 'goto-safe';
}

/**
 * 循环动作（动作链内部循环）：
 *   入口(前面的动作) → 每轮按序执行 do → 每轮后判定终止 → 退出(后续动作)。
 *
 * 语义 = **do-while**：至少执行一轮再判定终止（"经过一段循环后再退出"）。
 *
 * 终止条件（validate 强制至少给一个，否则等同死循环直接拒绝）：
 *   times  固定轮数（跑满即退）
 *   while  每轮后断言：成立→继续下一轮，不成立→退出
 *   until  每轮后断言：成立→退出
 * 三者可组合，任一满足即退出；maxIterations 是兜底硬上限（默认 1000，上限 10000）。
 *
 * 循环体可递归含 invoke/append/wake/gate/loop（深度上限 5，与 gate 共用）。
 * 每轮共享 scope：$result.* 指向该轮最后一步输出，可被 while/until 断言。
 */
export interface LoopAction {
  sink: 'loop';
  /** 循环体（每轮按序执行；至少一个动作） */
  do: Action[];
  /** 固定轮数 */
  times?: number;
  /** 每轮后断言：成立→继续下一轮，不成立→退出 */
  while?: Assertion;
  /** 每轮后断言：成立→退出 */
  until?: Assertion;
  /** 安全兜底上限（默认 1000，最大 10000）—— 条件永真时靠它停 */
  maxIterations?: number;
}

export type Action = InvokeAction | AppendAction | WakeAction | GateAction | SafetyAction | LoopAction;

/** 断言：对"上一步结果"或"事件载荷"做简单比较 */
export interface Assertion {
  /**
   * 取值路径。支持两个前缀：
   *   `result.*` —— 上一步的执行结果
   *   `event.*`  —— 触发事件的载荷
   * 例：`result.posErr` / `event.kind`
   */
  path: string;
  op: '<' | '<=' | '>' | '>=' | '==' | '!=';
  value: unknown;
}

// ────────────────────────────────────────────────────────────────────────────
// 链路定义
// ────────────────────────────────────────────────────────────────────────────

export interface AutomationRule {
  /** 唯一标识 */
  id: string;
  /** 人类可读名称 */
  name: string;
  /**
   * 是否启用。
   * ⚠️ 模型新建的链路**默认应为 false**，需显式启用（防模型一次误生成就造成破坏）。
   */
  enabled: boolean;

  when: WhenSpec;
  /** 动作链：按数组顺序执行；gate/loop 内部可嵌套 */
  do: Action[];

  /**
   * 最多执行次数：成功执行达到该次数后**自动停用**（enabled=false 并落盘）。
   * 不填 = 不限次（默认）。执行计数见 runCount。
   */
  maxRuns?: number;
  /** 已执行次数（引擎维护、随规则持久化；停用后保留历史值便于审计） */
  runCount?: number;

  meta?: {
    description?: string;
    tags?: string[];
    /** ISO 8601 */
    createdAt?: string;
    /** 创建者：'user' | 'model' —— 用于审计与权限分级 */
    createdBy?: 'user' | 'model';
  };
}
