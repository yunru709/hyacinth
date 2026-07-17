// ============================================================
// bypass/base — BypassAgentBase
// ============================================================
//
// 提供所有旁路Agent的通用能力：
//   - 模型通道调用
//   - 工具循环（并行优先，有依赖串行）
//   - 异常隔离（永不抛给调用方）
//   - 状态持久化
//
// 具体Agent只需提供：
//   - 系统提示词
//   - 工具定义和执行函数
//   - preTurn/postTurn 的提示词构建逻辑
//   - 内部状态结构与持久化路径
// ============================================================

import type { Message, ToolDefinition, StreamEvent, MessageContent } from '../types.js';
import type {
  BypassAgent,
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
} from './types.js';

/** 只依赖结构化接口，不耦合具体 provider 实现 */
export interface ProviderLike {
  createStream(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

export interface ModelRouterLike {
  getProvider(role: string): ProviderLike | null;
}

/** 最大工具循环轮数 */
const MAX_TOOL_ITERS = 5;

// ── Agent 配置（由子类提供） ──────────────────────────────────

export interface BypassAgentConfig {
  name: string;
  modes: string[];
  modelChannel: string;
  /** 工具定义列表 */
  tools: ToolDefinition[];
  /** 工具分发器 */
  executeTool(name: string, input: Record<string, unknown>): Promise<string>;
}

// ── BypassAgentBase ───────────────────────────────────────────

export abstract class BypassAgentBase implements BypassAgent {
  readonly name: string;
  readonly modes: string[];
  readonly modelChannel: string;
  protected tools: ToolDefinition[];
  protected modelRouter: ModelRouterLike | null = null;
  protected readonly _config: BypassAgentConfig;
  /** BypassManager 引用（由 BypassManager.register 注入） */
  protected _manager: import('./manager.js').BypassManager | null = null;

  constructor(config: BypassAgentConfig) {
    this._config = config;
    this.name = config.name;
    this.modes = config.modes;
    this.modelChannel = config.modelChannel;
    this.tools = config.tools;
  }

  /** 设置模型路由（由 BypassManager 或 factory 注入） */
  setModelRouter(router: ModelRouterLike | null): void {
    this.modelRouter = router;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract preTurn(ctx: PreTurnContext): Promise<PreTurnResult>;
  abstract postTurn(ctx: PostTurnContext): Promise<void>;

  // ── 受保护的 LLM 调用辅助 ──────────────────────────────────

  /** 获取当前通道的 Provider */
  protected getProvider(): ProviderLike | null {
    return this.modelRouter?.getProvider(this.modelChannel) ?? null;
  }

  /**
   * 单次 LLM 调用（无工具循环）。
   * 返回 LLM 生成的纯文本。
   */
  protected async callLLM(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    try {
      const provider = this.getProvider();
      if (!provider) return '';

      const messages: Message[] = [
        { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'text', text: userPrompt }] },
      ];

      let text = '';
      for await (const ev of provider.createStream(messages)) {
        if (ev.type === 'TEXT') text += ev.content;
      }
      return text.trim();
    } catch {
      return ''; // 旁路失败不影响主流程
    }
  }

  /**
   * 带工具循环的 LLM 调用。
   * 底层循环：调 LLM → 执行工具（并行/串行）→ 结果喂回 LLM → 直到无工具调用或达到上限。
   */
  protected async callLLMWithTools(
    systemPrompt: string,
    userPrompt: string,
    maxIters: number = MAX_TOOL_ITERS,
  ): Promise<string> {
    try {
      const provider = this.getProvider();
      if (!provider) return '';

      const messages: Message[] = [
        { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'text', text: userPrompt }] },
      ];

      const allText: string[] = [];

      for (let i = 0; i < maxIters; i++) {
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        const textParts: string[] = [];

        for await (const ev of provider.createStream(messages, this.tools)) {
          if (ev.type === 'TEXT') textParts.push(ev.content);
          else if (ev.type === 'TOOL_USE') toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
          else if (ev.type === 'STOP') break;
        }

        // 记录本轮文本
        if (textParts.length) allText.push(...textParts);

        // 无工具调用 → 完成
        if (toolCalls.length === 0) break;

        // 添加 assistant 消息（含工具调用）
        const assistantContent: MessageContent[] = [];
        if (textParts.length) assistantContent.push({ type: 'text', text: textParts.join('') });
        for (const tc of toolCalls) {
          assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        messages.push({ role: 'assistant', content: assistantContent });

        // 并行执行工具（无依赖的并行，有依赖的串行后面再优化）
        const results: MessageContent[] = await Promise.all(
          toolCalls.map(async (tc): Promise<MessageContent> => {
            const result = await this._config.executeTool(tc.name, tc.input);
            return {
              type: 'tool_result',
              tool_use_id: tc.id,
              content: result,
            };
          }),
        );
        messages.push({ role: 'user', content: results });
      }

      return allText.join('').trim();
    } catch {
      return '';
    }
  }

}
