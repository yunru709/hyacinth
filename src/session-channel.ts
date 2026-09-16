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

/** 列出全部已注册前缀（测试/诊断用） */
export function listChannelPrefixes(): Array<{ prefix: string; channel: string }> {
  return [...channelPrefixMap.entries()].map(([prefix, channel]) => ({ prefix, channel }));
}
