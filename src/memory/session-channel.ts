// ============================================================
// session-channel.ts —— sessionId 前缀 → 渠道 注册表
//
// 背景：历史上"从 sessionId 推断渠道"在 session.ts 和 loop.ts 各写了一份
// 硬编码 if-else（feishu_/webui_/ui_/tui_）。新增渠道（如插件注册的 hub）
// 需要改两处核心代码，违背插件化原则。
//
// 根治：改为可注册的映射表 —— 渠道注册时声明自己的 session 前缀，
// 平台统一从这里解析，插件渠道零核心改动即可接入。
// ============================================================

/** 前缀 → 渠道 映射（Map 保序：先注册者先匹配，前缀长的靠前注册） */
const channelPrefixMap = new Map<string, string>();

/** 注册一个 sessionId 前缀 → 渠道映射（幂等覆盖） */
export function registerChannelPrefix(prefix: string, channel: string): void {
  if (!prefix || prefix.length === 0) return;
  channelPrefixMap.set(prefix, channel);
}

/** 注销一个前缀映射（渠道卸载时清理） */
export function unregisterChannelPrefix(prefix: string): boolean {
  return channelPrefixMap.delete(prefix);
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

// ── 内置前缀注册（与历史硬编码行为一致）────────────────────────
registerChannelPrefix('feishu_', 'feishu');
registerChannelPrefix('webui_', 'webui');
registerChannelPrefix('ui_', 'webui'); // ui_ 为旧版 /ui 前缀（兼容存量）
registerChannelPrefix('tui_', 'tui');
