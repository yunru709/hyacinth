// ============================================================
// session-channel.ts —— sessionId 前缀 → 渠道 注册表（纯注册表 · 零渠道知识）
// ============================================================
//
// 【为什么在根级而不是 memory/】
// 本文件既不是业务逻辑也不是存储实现，只是一张"前缀 → 渠道"映射表 + 纯函数。
// 早期版本放在 memory/（业务核心）下，导致 UI 适配层（channels/…）引用它时，
// verify:layers 规则 5 判为"UI 直连业务核心"违规 —— 白名单只减不增，这类引用
// 永远无法合法登记。上移到 src/ 根级后与 events.ts / types.ts 同级，属规则内
// 明确豁免的"根级基础文件"，双方引用均合法。
//
// 【注册式：核心不认识任何渠道】
// 本文件**只提供注册/解析能力，不预置任何渠道前缀**（不含 tui_/webui_/feishu_
// 之类字面量）。前缀一律由渠道**自己在注册时声明**并自动就位：
//   - 内置渠道：handler 在自己模块内定义前缀常量、挂到 sessionPrefix 字段；
//     该渠道被注册进 ChannelManager 时（tui.ts / server.ts 各自的注册点）自动登记。
//   - 插件渠道：同上；另在 ChannelPlugin.autoRegister 开头额外登记一次
//     （该钩子对每个已发现插件都会执行、与 enabled 无关，保证插件被禁用时
//     存量会话仍可反推渠道）。
// 验收标准：**新增渠道 = 渠道模块内声明前缀，零核心改动**。
// 反面教材：前缀曾是散落在核心的字面量表、与渠道实现分家 —— 结果插件渠道 clawbot
// 生产侧 generateSessionId('clawbot') 造得出 clawbot_xxx，注册表里却从来没有
// clawbot_，会话归属永远推断不出、渠道隔离失效。
//
// 【代价（有意为之）】
// 某渠道在本进程未被注册（如 TUI 模式下未加载 WebUI 渠道），其前缀在本进程
// 解析不到。影响面仅限"为缺 meta.json 的存量会话反推渠道"这一兜底路径
// （memory/session.ts 的 legacy 补写 + loop.materializeSessionIfNeeded）；
// 新建会话的 channel 由 createLazy(channel) 直接落盘，不依赖前缀解析。
// ============================================================

/** 前缀 → 渠道 映射（Map 保序：前缀长的优先匹配在 resolve 里判定） */
const channelPrefixMap = new Map<string, string>();

/** 注册一个 sessionId 前缀 → 渠道映射（幂等覆盖） */
export function registerChannelPrefix(prefix: string, channel: string): void {
  if (!prefix || prefix.length === 0) return;
  channelPrefixMap.set(prefix, channel);
}

/** 批量注册（一个渠道可声明多个前缀，如 WebUI 的 webui_ + 旧版 ui_） */
export function registerChannelPrefixes(prefixes: string | readonly string[], channel: string): void {
  const list = typeof prefixes === 'string' ? [prefixes] : prefixes;
  for (const p of list) registerChannelPrefix(p, channel);
}

/** 注销前缀映射（渠道 unregister 时清理） */
export function unregisterChannelPrefix(prefix: string): boolean {
  return channelPrefixMap.delete(prefix);
}

/** 批量注销 */
export function unregisterChannelPrefixes(prefixes: string | readonly string[]): void {
  const list = typeof prefixes === 'string' ? [prefixes] : prefixes;
  for (const p of list) channelPrefixMap.delete(p);
}

/** 从 sessionId 推断渠道（最长前缀优先，避免 ui_/webui_ 这类嵌套前缀误匹配） */
export function resolveChannelFromSessionId(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  let best: { prefix: string; channel: string } | undefined;
  for (const [prefix, channel] of channelPrefixMap) {
    if (sessionId.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) {
        best = { prefix, channel };
      }
    }
  }
  return best?.channel;
}

/**
 * 该 sessionId 是否**属于**该渠道。
 *
 * 用途：「各渠道只持有自己前缀的会话」这条不变式的判定入口 —— 渠道恢复持久化的
 * 会话映射时用它做归属校验，避免沿用旧版裸 ID / 别渠道 ID（实测：clawbot 曾持有
 * 裸 ID `20260916-223857-0e9c`）。判据与 memory/session.ts 的 getLatestByChannel
 * 兜底一致：前缀反解 === channel，或 ID 以 `<channel>_` 开头。
 */
export function sessionBelongsToChannel(sessionId: string, channel: string): boolean {
  if (!sessionId || !channel) return false;
  return resolveChannelFromSessionId(sessionId) === channel || sessionId.startsWith(`${channel}_`);
}

/** 列出全部已注册前缀（测试/诊断用） */
export function listChannelPrefixes(): Array<{ prefix: string; channel: string }> {
  return [...channelPrefixMap.entries()].map(([prefix, channel]) => ({ prefix, channel }));
}

/**
 * 归属受限的会话 getter（本地主 loop 快照用）：
 * 只在 loop 当前会话**归属本渠道**时实时返回；切到别渠道会话（switch_session
 * 临时共同持有）时回落「最后一次归属本渠道的会话」—— 保证重启快照永远记录
 * 渠道自己的会话，临时跨渠道持有在重启时被放弃。
 */
export function createOwnedSessionGetter(
  getCurrentSessionId: () => string,
  channel: string,
): () => string {
  let owned: string = getCurrentSessionId();
  return () => {
    const current = getCurrentSessionId();
    if (sessionBelongsToChannel(current, channel)) {
      owned = current;
      return current;
    }
    return owned;
  };
}

// ============================================================
// 重启会话快照（渠道 → 当前 sessionId）
// ============================================================
//
// 【解决什么】多渠道共享一个进程时（TUI + 插件渠道），重启要让各渠道**回到各自
// 重启前的会话**。此前只有本地主 loop 注册、且只有 TUI 启动路径消费快照，
// 插件渠道只能退化为「取本渠道最近会话」——对单会话渠道恰好等价，对多会话渠道
// 则会丢掉用户切过去的那个会话。
//
// 【职责划分：采集与恢复分居两处，不重复实现】
//   · 采集/序列化 → supervisor/protocol.ts 的 snapshotChannelSessions()
//     该文件按约定是「零内部依赖的契约叶」（不可 import 本模块），故与本模块以
//     **globalThis.__channelSessionRegistry** 为共享面（与 __channelLoopRegistry
//     同构）：本模块往注册表写 getter，协议层遍历并序列化进 .restart-session。
//   · 注册/取用 → 本模块（渠道在 start() 注册 getter；启动时按名字取回自己的会话）
//
// getter 必须是**函数**而非静态值：用户 switch_session 之后，重启快照要反映当前
// 会话，而不是注册那一刻的旧值。
//
// 【有意不参与的渠道】飞书：它有更完整的自有机制（persistFeishuState 维护
// chatId → 多会话映射，并能豁免 __shared__ 等伪会话）。单值快照表达不了多会话，
// 强行接入反而退化，故保持现状（见 feishu-channel.ts start() 处的说明）。
// ============================================================

/**
 * 会话 getter 注册表（globalThis 共享面，与协议层采集侧共读同一张表）。
 * 惰性初始化，与 runtime-wiring.ts 的 __channelLoopRegistry 同构：谁先用到谁先建。
 * 导出理由：接线层需持有该表引用（作为 ChannelRegistries 的一部分交给调度器）。
 */
export function getChannelSessionRegistry(): Map<string, () => string> {
  const g = globalThis as { __channelSessionRegistry?: Map<string, () => string> };
  if (!g.__channelSessionRegistry) g.__channelSessionRegistry = new Map<string, () => string>();
  return g.__channelSessionRegistry;
}

/** 本次启动装载的重启快照（渠道 → sessionId） */
let restartSnapshot: Record<string, string> = {};

/** 注册/覆盖某渠道的会话 getter（幂等；getter 返回该渠道**当前**会话，空串 = 暂无） */
export function registerChannelSession(channel: string, getter: () => string): void {
  if (!channel) return;
  getChannelSessionRegistry().set(channel, getter);
}

/** 注销某渠道的会话 getter（渠道 stop/unregister 时清理） */
export function unregisterChannelSession(channel: string): boolean {
  return getChannelSessionRegistry().delete(channel);
}

/**
 * 装载重启快照（启动早期由 cli 解析 .restart-session 后调用一次）。
 * 兼容三种历史形态：JSON 快照 / `channel:sessionId`（旧格式）/ `true`（无渠道信息）。
 */
export function loadRestartSnapshot(raw: string | null | undefined): void {
  restartSnapshot = {};
  if (!raw) return;
  const text = raw.trim();
  if (!text || text === 'true') return;

  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v) restartSnapshot[k] = v;
        }
      }
    } catch { /* 非法 JSON → 视为无快照 */ }
    return;
  }

  // 旧格式 "channel:sessionId"
  const sep = text.indexOf(':');
  if (sep > 0) {
    const ch = text.slice(0, sep);
    const sid = text.slice(sep + 1);
    if (ch && sid) restartSnapshot[ch] = sid;
  }
}

/** 取某渠道在**本次启动**快照中记录的会话；无命中返回 undefined → 调用方回退到「最近会话」 */
export function getRestartSession(channel: string): string | undefined {
  return channel ? restartSnapshot[channel] : undefined;
}

/** 列出本次快照的全部渠道（诊断用） */
export function listRestartSnapshot(): Array<{ channel: string; sessionId: string }> {
  return Object.entries(restartSnapshot).map(([channel, sessionId]) => ({ channel, sessionId }));
}

/** 测试隔离：清空已装载的快照 */
export function clearRestartSnapshot(): void {
  restartSnapshot = {};
}

/** 测试隔离：清空会话 getter 注册表 */
export function clearChannelSessionGetters(): void {
  getChannelSessionRegistry().clear();
}

// ============================================================
// 渠道会话恢复（**全项目唯一实现**）
// ============================================================

/** 渠道会话存储的最小结构化接口（SessionManager 天然满足，故不引入具体类型依赖） */
export interface ChannelSessionStore {
  list(): Promise<Array<{ id: string }>>;
  resume(sessionId: string): Promise<{ id: string; type?: string }>;
  getLatestByChannel(channel: string): Promise<{ id: string; type?: string } | null>;
  createLazy(channel?: string): { id: string; type?: string };
}

/** 恢复结果；source 供调用方决定附带动作（如新建时 cleanup / 告警） */
export interface ResolvedChannelSession {
  id: string;
  type?: string;
  source: 'snapshot' | 'recent' | 'new';
}

/**
 * 按渠道恢复会话 —— **唯一实现**：重启快照（校验归属 + 存在性）→ 本渠道最近 → 新建。
 *
 * 此前 boot.ts（TUI/CLI 入口）与 SessionService.restoreSession（插件渠道）各写了一份，
 * 任一边漏改即产生行为分歧（例如归属校验只加在了一边）。两者现在都调用本函数。
 *
 * fail-closed 语义：渠道已声明却无本渠道存量会话时**新建**，绝不回退「全局最近」——
 * 那条兜底会把任何无渠道归属的会话（测试泄漏目录、temp 项目会话、别渠道会话）认领
 * 给本渠道。实测事故：TUI / WebUI / 微信三方共用同一份对话历史。
 */
export async function resolveChannelSession(
  store: ChannelSessionStore,
  channel: string,
): Promise<ResolvedChannelSession | null> {
  if (!channel) return null;

  // ① 快照：须同时满足「归属本渠道」与「目录仍存在」——归属校验挡手改/陈旧的
  //    .restart-session，存在性校验挡已被 cleanup 删除的会话。
  const snapshotId = getRestartSession(channel);
  if (
    snapshotId !== undefined
    && sessionBelongsToChannel(snapshotId, channel)
    && (await store.list()).some((s) => s.id === snapshotId)
  ) {
    const session = await store.resume(snapshotId);
    return { id: session.id, type: session.type, source: 'snapshot' };
  }

  // ② 本渠道最近已有会话
  const recent = await store.getLatestByChannel(channel);
  if (recent) return { id: recent.id, type: recent.type, source: 'recent' };

  // ③ fail-closed 新建
  const fresh = store.createLazy(channel);
  return { id: fresh.id, type: fresh.type, source: 'new' };
}
