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
}
