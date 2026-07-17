// ============================================================
// ClawbotSession — ClawBot 渠道 session 管理 + CollectHandler
// ============================================================
//
// ClawBot 是单会话，比飞书简单很多：
//   - 无需 SessionPool / LRU cache（只有一个会话）
//   - 无需 sessionMode（不存在 per_chat / per_user 等策略）
//   - CollectHandler 逻辑与飞书一致：过滤工具调用和状态，只保留文本输出
// ============================================================

import type { OutputHandler } from '../../../orchestrator/loop.js';

// ── 类型 ──────────────────────────────────────────────────────

export interface CollectHandler extends OutputHandler {
  getResponse(): string;
  reset(): void;
}

export interface SessionRunner {
  run(input: string): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────

export function createCollectHandler(): CollectHandler {
  const texts: string[] = [];
  return {
    onText(content: string) { texts.push(content); },
    // ClawBot 端只展示最终文本回复，工具调用和状态消息不发送给用户
    onToolUse(_name: string, _inputSummary: string) {},
    onStatus(_message: string) {},
    // 每个新 turn 清空之前累积的文本，只保留最后一轮的输出
    onTurnStart() { texts.length = 0; },
    onFlush() {},
    onInterrupt() {},
    getResponse() { return texts.join(''); },
    reset() { texts.length = 0; },
  };
}
