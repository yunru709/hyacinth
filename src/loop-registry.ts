// ============================================================
// loop-registry — 进程级「开着的 UI loop」注册表（2026-10-28「loop 统一」基础件）
// ============================================================
// 目的：webui 标签的 loop 由 UiProtocolSession 在 WS 连接时 createAgent 建、私有持有，
// **不在 SessionService 注册表**里。于是定时任务走 SessionService.getOrCreateLoop 会给
// 开着的会话**再建一个** loop ⇒ 两 loop 抢同一 sessionDir 锁 ⇒ 用户那一轮永不返回 ⇒ 挂死
// （这正是 reuse「拉起已关闭会话」被迫回退的根因）。
//
// 这里登记「当前开着的 UI loop」，调度侧 getLoop 先查它、命中就复用**同一个** loop，
// 不再重复建（开着的会话走标签 loop → ProtocolOutputHandler → WS 推给标签；已关闭的会话
// 查不到 → 才新建）。WS 断开时注销，避免复用到已死 loop。
//
// 键 = `${channel}:${sessionId}`。纯模块、无依赖：任何层都可 import（不做业务判断）。
// ============================================================

interface LoopRef {
  loop: unknown;
  channel: string;
  sessionId: string;
}

const openLoops = new Map<string, LoopRef>();
// 键**只用 sessionId**（会话 id 全局唯一：tui_/webui_/feishu_ 前缀天然区分渠道）。
// ⚠️ 不能用 `${channel}:${sessionId}`：任务自动识别的 channel（如 add_task 得 'tui'）与
// webui 标签注册的 channel（backend.channel 缺省 'webui'）常常不一致 ⇒ 注册表查不中 ⇒
// reuse 又去重复建 loop ⇒ 抢 sessionDir 锁挂死（正是要修的那个坑）。
const keyOf = (_channel: string, sessionId: string): string => sessionId;

/** 登记一个开着的 UI loop（WS 连接、loop 就绪后调用） */
export function registerOpenLoop(channel: string, sessionId: string, loop: unknown): void {
  openLoops.set(keyOf(channel, sessionId), { loop, channel, sessionId });
}

/** 取开着的 UI loop（调度侧复用；查不到返回 null ⇒ 走新建） */
export function getOpenLoop(channel: string, sessionId: string): unknown | null {
  return openLoops.get(keyOf(channel, sessionId))?.loop ?? null;
}

/** 注销（WS 断开 / 会话销毁时；幂等） */
export function unregisterOpenLoop(channel: string, sessionId: string): void {
  openLoops.delete(keyOf(channel, sessionId));
}

/** 枚举当前开着的 loop（诊断/测试用） */
export function listOpenLoops(): LoopRef[] {
  return [...openLoops.values()];
}
