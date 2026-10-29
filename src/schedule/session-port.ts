// 定时任务会话端口（2026-10-28 重构）
//
// 定时任务触发时需要「按 sessionId 取/建 loop、建一次性会话、销毁会话、广播让前端开会话」
// 这些 **gateway 能力**。但 schedule 层不该直接依赖 SessionService / SessionManager
// （分层：schedule 是底层，gateway 是上层）。
//
// 故收敛成一个**窄接口** SchedulerSessionPort，由 gateway（server.ts）实现并注入
// installSchedulerHandler。schedule 侧只认这个接口 ⇒ 分层干净、可 mock 单测。

/** 端口交给 handler 的最小 loop 面（仅需唤醒跑一轮任务通知） */
export interface SchedulerTaskLoop {
  /** 唤醒该会话的 agent 跑一轮（携带模式对应的任务提示词） */
  notifyTaskFired(taskName: string): Promise<void>;
}

export interface SchedulerSessionPort {
  /**
   * 取得（必要时**创建**）某渠道某会话的 loop。
   * 会话已被关闭（无活跃 loop）时即"拉起"它 —— 底层走 SessionService.getOrCreateLoop。
   */
  getOrCreateLoop(channel: string, sessionId: string): Promise<SchedulerTaskLoop>;

  /**
   * 新建一个**一次性临时会话**（sessionPolicy='new' 用），返回其 sessionId。
   * 该会话应标记为 ephemeral（不出现在会话列表）。
   */
  createEphemeralSession(channel: string): Promise<{ sessionId: string }>;

  /**
   * 销毁一个会话：删会话目录 + 摘除其 loop/资源。
   * 一次性会话完成后 5 分钟调用；也用于清理失败的临时会话。
   */
  destroySession(channel: string, sessionId: string): Promise<void>;

  /**
   * 广播「请打开某会话标签」给前端（浏览器开着时自动开对应 tab）。
   * 无前端连接时为 no-op（不影响后台跑）。
   */
  broadcastOpenSession(channel: string, sessionId: string): void;

  /**
   * 一次性会话跑任务并交付（sessionPolicy='new' 用）：
   * 建临时会话(标记 ephemeral) → 跑任务 → 把输出 append 回 deliverSessionId 会话 → 5min 后销毁临时会话。
   */
  runOneShot(opts: { channel: string; taskName: string; deliverSessionId?: string }): Promise<void>;

  /**
   * 用**调用方给定的提示词**唤醒该会话跑一轮（2026-10-29 新增，供 watch 等非定时事件源使用）。
   *
   * 为什么不复用 notifyTaskFired：那条路径会把任务名塞进
   * `[Scheduled Task Triggered] Your scheduled task "..." has just been triggered`
   * 模板里 —— 对「监控项变化」这类事件是错的语义，会把 agent 误导成"我在执行定时任务"。
   * 这里让事件源自带提示词，端口只负责"把这一轮跑起来"。
   *
   * 可选实现：未实现时调用方必须降级（不得假设其存在）。
   */
  runPrompt?(channel: string, sessionId: string, prompt: string): Promise<void>;

  /**
   * 在**一次性临时会话**里跑一段给定提示词（2026-10-30，供 automation 的
   * `wake` + `Where.policy='new'` 使用）。
   *
   * 与 runOneShot 的区别：
   *   · runOneShot 接 `taskName`，内部走 runTask —— 会套 `[Scheduled Task Triggered]` 模板
   *   · 本方法接**任意 prompt**，语义是"开个干净会话，用这句话跑一轮"
   *
   * 典型用途：「日志出现异常，开个干净回合分析，别被历史结论带偏」。
   *
   * 可选实现：未实现时调用方必须降级或**明确报错**（不得静默假装跑过）。
   */
  runPromptInNewSession?(opts: {
    channel: string;
    prompt: string;
    /** 结果回投到哪个会话；省略则结果留在临时会话里（随后销毁） */
    deliverSessionId?: string;
    /** 临时会话存活时间（毫秒），默认 5 分钟 */
    ttlMs?: number;
  }): Promise<void>;
}

// ── 进程级端口注册 ──────────────────────────────────────────────
// 简化注入：gateway 在 server.ts 建好适配器后 setSchedulerSessionPort；
// schedule 侧 handler 通过 getSchedulerSessionPort 读取。
// 避免把端口穿透 factory / CreateAgentOptions / agent-assembly 多层（那会很脏，
// 且 agent-assembly 是**按会话**多次创建，穿透会重复注入）。单一进程单例最干净。
let activePort: SchedulerSessionPort | undefined;

export function setSchedulerSessionPort(port: SchedulerSessionPort | undefined): void {
  activePort = port;
}

export function getSchedulerSessionPort(): SchedulerSessionPort | undefined {
  return activePort;
}

