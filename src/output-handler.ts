// ============================================================
// output-handler.ts —— 内核共享的回合输出收集器
// ============================================================
//
// createCollectHandler 原先位于 feishu-session.ts（渠道私有）。
// 会话主控权收归内核后，渠道的入站消息统一由内核编排
// （resolve → loop.run → reply），内核需要一种「收集整轮输出、
// 最后一次性发送」的默认输出处理器。本文件把它提到根级，
// 供 SessionService 与各渠道（clawbot 等）共同使用：
//   - 根级基础文件，verify:layers 规则 5 对 UI 侧豁免（UI_DIRECT_EXCLUDED）
//   - 不依赖任何渠道实现，跨项目可移植
// ============================================================

import type { OutputHandler } from './orchestrator/loop.js';

/** 收集型输出处理器：聚合本轮文本输出，供最后一次性发送 */
export interface CollectHandler extends OutputHandler {
  /** 取累计的完整回复文本 */
  getResponse(): string;
  /** 清空累计文本 */
  reset(): void;
}

/**
 * 创建收集型输出处理器。
 * 行为（与原 feishu createCollectHandler 一致）：
 *   - 只累积 onText 正文，工具调用/状态消息不进回复
 *   - 每个新 turn 清空之前累积的文本，只保留最后一轮输出
 */
export function createCollectHandler(): CollectHandler {
  const texts: string[] = [];
  return {
    onText(content: string) { texts.push(content); },
    onToolUse() {},
    onToolResult() {},
    onStatus() {},
    onTurnStart() { texts.length = 0; },
    onFlush() {},
    onInterrupt() {},
    getResponse() { return texts.join(''); },
    reset() { texts.length = 0; },
  };
}
