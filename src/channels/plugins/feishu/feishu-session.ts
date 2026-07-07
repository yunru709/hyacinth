// ============================================================
// Feishu Session Pool — 飞书渠道 session 持久化管理
// ============================================================
//
// 维护 sessionId → AgentLoop 映射，确保同一对话源的消息
// 路由到同一 AgentLoop，保持上下文连续性。
//
// sessionMode 决定 sessionId 的生成方式：
//   - shared   → 使用主 loop（不创建新 session）
//   - per_chat → 按 chatId 生成 sessionId
//   - per_user → 按 senderOpenId 生成 sessionId
// ============================================================

import type { OutputHandler } from '../../../orchestrator/loop.js';
import type { FeishuChannelConfig } from './feishu-config.js';

// ── 类型 ──

export interface CollectHandler extends OutputHandler {
  getResponse(): string;
  reset(): void;
}

export interface SessionRunner {
  run(input: string): Promise<void>;
}

export interface SessionEntry {
  loop: SessionRunner;
  collectHandler: CollectHandler;
}

export type SessionMode = 'shared' | 'per_chat' | 'per_user';

// ── SessionPool ──

export class ChannelSessionPool {
  private sessions = new Map<string, SessionEntry>();

  /**
   * 获取或创建 session。
   *
   * @param config 飞书渠道配置（含 sessionMode）
   * @param chatId 聊天 ID
   * @param senderOpenId 发送者 open_id
   * @param createFn 创建新 session 的回调，返回 { loop, collectHandler }
   */
  async getOrCreate(
    config: FeishuChannelConfig,
    chatId: string,
    senderOpenId: string,
    createFn: () => Promise<SessionEntry>,
  ): Promise<SessionEntry> {
    const sessionId = this.resolveSessionId(config, chatId, senderOpenId);

    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const entry = await createFn();
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /**
   * 根据 sessionMode 解析 sessionId。
   */
  resolveSessionId(
    config: FeishuChannelConfig,
    chatId: string,
    senderOpenId: string,
  ): string {
    const mode: SessionMode = config.sessionMode ?? 'per_user';

    switch (mode) {
      case 'shared':
        return '__shared__';
      case 'per_chat':
        return `feishu_chat_${chatId}`;
      case 'per_user':
      default:
        return `feishu_${senderOpenId}`;
    }
  }

  /**
   * 清理指定 session。
   */
  evict(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * 清理所有 session。
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * 获取当前活跃 session 数量。
   */
  get size(): number {
    return this.sessions.size;
  }
}

// ── Factory ──

export function createCollectHandler(): CollectHandler {
  const texts: string[] = [];
  return {
    onText(content: string) { texts.push(content); },
    // 飞书端只展示最终文本回复，工具调用和状态消息不发送给用户
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