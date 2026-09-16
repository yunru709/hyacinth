// ============================================================
// session-channel.ts —— sessionId 前缀 → 渠道 注册表（根级中立契约）
// ============================================================
//
// 【为什么在根级而不是 memory/】
// 本文件既不是业务逻辑也不是存储实现，只是一张"前缀 → 渠道"映射表 + 纯函数。
// 早期版本放在 memory/（业务核心）下，导致 UI 适配层（channels/…）引用它时，
// 被 verify:layers 规则 5 判为"UI 直连业务核心"违规 —— 因为白名单只减不增，
// 这种引用永远无法合法登记。上移到 src/ 根级后与 events.ts / types.ts 同级，
// 属规则内明确豁免的"根级基础文件"，双方引用均合法。
//
// 【单一真源，杜绝硬编码漂移】
// 内置渠道前缀只在下面的 BUILTIN_CHANNEL_PREFIXES 里写一次；各内置渠道 handler
// 声明自己的 sessionPrefix 时必须**引用本表导出的常量**，不得各写字面量。
// 反面教材：本表曾经的形态是散落在本文件里的 4 行 registerChannelPrefix 字面量，
// 且与渠道实现分家 —— 结果插件渠道 clawbot 在生产侧 generateSessionId('clawbot')
// 造得出 clawbot_xxx，注册表里却没有 clawbot_，会话归属永远推断不出来。
// 新增内置渠道 = 本表加一行 + handler 引用该常量（guard 测试会校验两者一致）。
//
// 【插件渠道如何接入】
// 插件渠道不在本表里，走运行时契约：ChannelHandler.sessionPrefix
// （string | readonly string[]），由 ChannelManager.register 注册、unregister 注销。
// 插件被禁用（autoRegister 提前 return、渠道未注册）时，由 channels/auto-detect.ts
// 的 discoverPlugins 在**发现阶段**注册其声明的前缀，保证存量会话 ID 仍可推断渠道。
// ============================================================

/** 前缀 → 渠道 映射（Map 保序：前缀长的优先匹配在 resolve 里判定） */
const channelPrefixMap = new Map<string, string>();

/** 注册一个 sessionId 前缀 → 渠道映射（幂等覆盖） */
export function registerChannelPrefix(prefix: string, channel: string): void {
  if (!prefix || prefix.length === 0) return;
  channelPrefixMap.set(prefix, channel);
}

/** 批量注册（一个渠道可声明多个前缀，如 webui 的 webui_ + 旧版 ui_） */
export function registerChannelPrefixes(prefixes: string | readonly string[], channel: string): void {
  const list = typeof prefixes === 'string' ? [prefixes] : prefixes;
  for (const p of list) registerChannelPrefix(p, channel);
}

/** 注销前缀映射（渠道卸载时清理） */
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

/** 列出全部已注册前缀（测试/诊断用） */
export function listChannelPrefixes(): Array<{ prefix: string; channel: string }> {
  return [...channelPrefixMap.entries()].map(([prefix, channel]) => ({ prefix, channel }));
}

// ────────────────────────────────────────────────────────────
// 内置渠道前缀（单一真源）
// 各内置 handler 的 sessionPrefix 必须引用这里的常量，不得写重复字面量。
// ────────────────────────────────────────────────────────────

/** TUI 渠道前缀（channels/builtin/tui-channel.ts 引用） */
export const TUI_SESSION_PREFIX = 'tui_';
/** WebUI 渠道前缀（channels/builtin/http-webhook.ts 引用）；ui_ 为旧版 /ui 前缀，兼容存量 */
export const WEBUI_SESSION_PREFIXES = ['webui_', 'ui_'] as const;

/**
 * 内置渠道前缀表：[前缀, 渠道]（新增内置渠道在此加一行）
 *
 * 本表**只放内置渠道**。插件渠道（feishu / clawbot / 第三方）前缀由插件自管：
 * 常量定义在插件自己的模块里，并在 ChannelPlugin.autoRegister 开头无条件调用
 * registerChannelPrefixes —— 该钩子对每个已发现插件都会执行（与 enabled 无关），
 * 所以插件被禁用时前缀依旧可解析（否则存量会话 ID 会推断不出渠道）。
 * 方向约束：核心不反向依赖插件，故插件渠道绝不登记在本表内。
 */
const BUILTIN_CHANNEL_PREFIXES: Array<[string | readonly string[], string]> = [
  [TUI_SESSION_PREFIX, 'tui'],
  [WEBUI_SESSION_PREFIXES, 'webui'],
];

// 模块加载即注册（与历史行为一致）：内置前缀的**可解析性不依赖渠道是否启用/加载**，
// 这样即使某渠道被禁用（如 feishu enabled=false）或用另一模式启动（如 TUI 模式下
// 未加载 webui 渠道），存量会话 ID 依然能推断出渠道。
for (const [prefix, channel] of BUILTIN_CHANNEL_PREFIXES) {
  registerChannelPrefixes(prefix, channel);
}
