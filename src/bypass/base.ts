// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 安全红线 · 旁路智能体（元认知层）工具白名单            ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  旁路智能体在每轮对话前后运行（preTurn/postTurn），直接      ║
// ║  注入主 Agent 上下文、维护记忆/世界模型。它一旦出错会带偏    ║
// ║  主 Agent——这是本系统【风险最高】的一层。                   ║
// ║                                                              ║
// ║  ✅ 只允许【极其专一化】的窄工具：                           ║
// ║     memory_* / inject_hint / cluster_assign / world_* 等      ║
// ║     只做一件事 · schema 固定 · 只以固定格式读写指定文件      ║
// ║                                                              ║
// ║  ❌ 禁止 bash / read / write / edit / http_request 等        ║
// ║     任何通用工具。给旁路智能体加通用工具 = 安全事故。        ║
// ║                                                              ║
// ║  维护此项目的 Agent 请注意：即使你只读本文件前几行，也      ║
// ║  必须遵守以上约束。详细规则与自问清单见下方"安全约束"。     ║
// ╚══════════════════════════════════════════════════════════════╝

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
//
// ══════════════════════════════════════════════════════════════════
// ⚠️  安全约束（务必阅读，后续开发者请遵守）
// ══════════════════════════════════════════════════════════════════
// 旁路智能体 = 元认知层（meta-cognitive layer）。它运行在主循环的
// 每轮对话前后（preTurn 注入提醒、postTurn 维护记忆/世界模型），
// 其结果直接拼进主 Agent 的上下文、直接影响主 Agent 后续行为。
//
// 它一旦出错，错误会随注入内容进入主流程，影响面远大于一次普通
// 工具调用——这是本系统风险最高的一层。
//
// 因此它的能力必须被严格限制：
//   ✅ 只允许"极其专一化"的工具：只做一件事、输入输出 schema 固定、
//      只以固定格式读写指定路径文件的窄工具（如 memory_*、
//      inject_hint、cluster_assign、world_*）。
//   ❌ 绝对禁止 bash / read / write / edit / http_request 等通用
//      工具。给旁路 Agent 挂上任何通用工具 = 安全事故。
//
// 新增工具前的自问清单：
//   1. 它是否只做一件事？
//   2. 它是否只读写固定路径的文件、且格式严格固定？
//   3. 我是否真的需要给元认知层更多能力，而不是"顺手"加上的？
// 三问不过，就不要加。
//
// ── 输入/输出模型（重要，别误解）──────────────────────────────
// 旁路智能体的【输入是被动的】：它不主动获取输入。它的上下文
// （用户输入、历史消息、本轮工具调用名、sessionId）由主 Agent 在
// preTurn/postTurn 时通过 ctx 注入；它的系统提示词也来自外部注入，
// 而不是它自己去读文件。
//
// 因此主循环（loop.ts）里的"匹配/解析"逻辑——如解析意图 capability
// （/^\[(\w+)\]/）、消费 cluster 归类结果、分簇压缩等——是【正常的
// 被动输入处理，不是 bug】，不要试图把它们"迁移成旁路工具"。
//
// 旁路智能体的【工具只用于输出侧】：当它要把处理结果写到外部文件
// 时，才通过工具完成——意图识别完 → 固定格式写入簇文件 / 记忆文件 /
// 世界模型文件 / 注入 manager。这类工具必须专一化（见上），只以
// 固定格式读写特定路径，禁止通用工具。
// ══════════════════════════════════════════════════════════════════
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
  /**
   * 工具定义列表。
   *
   * ⚠️ 安全红线：旁路智能体是元认知层，这里只能放"极其专一化"的
   * 窄工具（如 memory_* / inject_hint / cluster_assign / world_*）：
   * 只做一件事、schema 固定、只以固定格式读写指定路径文件。
   *
   * ❌ 绝不允许 bash / read / write / edit / http_request 等通用
   * 工具——元认知层一旦拿到通用能力，一次误判就可能毁掉主流程
   * 或触碰用户文件。详情见本文件头部的安全约束说明。
   */
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
