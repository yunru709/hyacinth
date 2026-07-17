// ============================================================
// bypass/agents/orchestrator — ContextOrchestrator
// ============================================================
//
// 普通模式下的旁路Agent。维护主Agent的记忆文件。
//
//   preTurn:  意图识别 → 调 inject_hint 工具注入提醒到 Zone 5
//   postTurn: 观察对话 → 偏离纠偏(inject_hint) + 记忆维护(memory_*)
//
// 设计原则：
//   - 显式工具调用注入，不依赖隐式返回值解析
//   - 沉默是默认：无价值信息时不注入、不写入
//   - 异常隔离：任何错误不影响主流程
// ============================================================

import { BypassAgentBase } from '../../base.js';
import type { BypassAgentConfig } from '../../base.js';
import type {
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
} from '../../types.js';
import type { ToolDefinition } from '../../../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 调试日志 ───────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.agent', 'NormalBypassAgent');
const LOG_FILE = path.join(LOG_DIR, 'orchestrator.log');

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch { /* ignore */ }
}
function logDetail(label: string, content: string): void {
  const ts = new Date().toISOString();
  const separator = '─'.repeat(60);
  const line = `[${ts}] ${label}:\n${separator}\n${content}\n${separator}\n`;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch { /* ignore */ }
}

// ── 系统提示词 ─────────────────────────────────────────────────

const PRETURN_SYSTEM = [
  '你是主Agent的"元认知层"。主Agent记忆里存放的只有关键的底层约束：',
  '用户习惯、行为规范、环境约定。不是普通事实或项目上下文。',
  '',
  '你的任务：',
  '1. 分析当前用户输入，判断意图（用文字输出你的分析）',
  '2. 检查「主Agent记忆」中是否有直接适用于当前情境的约束',
  '3. 仅当记忆中的约束与当前操作直接相关时，才调用 inject_hint 工具注入提醒',
  '',
  '什么需要注入：',
  '- 用户明确要求过"不要做X" → 当前操作可能触发X → inject_hint',
  '- 用户有固定的工具/命令习惯 → 偏离了习惯 → inject_hint',
  '',
  '什么不需要注入：',
  '- 记忆里有的但对当前操作无影响的条目',
  '- 泛泛的上下文补充',
  '',
  '大多数时候不需要注入。有疑问就不调 inject_hint。',
  '注意：你的文字输出会被保留为"意图"，即使不注入也要输出意图分析。',
].join('\n');

const POSTTURN_SYSTEM = [
  '你是主Agent的"记忆维护者"。只记录真正底层的、跨会话的约束信息。',
  '',
  '值得记（严格）：',
  '- 用户明确表达的行为偏好（"以后都..."、"不要..."）',
  '- 用户的工作习惯/命令行惯例',
  '- 环境约束（"我们的项目必须兼容 Windows"）',
  '',
  '不记：',
  '- 一次性的任务信息',
  '- 代码细节、项目结构',
  '- 普通的事实陈述',
  '- 闲聊中的随口一提',
  '',
  '门槛很高。大多数会话不产生新记忆。有疑问就不记。',
  '',
  '工具：memory_search / memory_add / memory_update / memory_remove',
  '写入前先 search 去重。无值得记的内容时直接结束。',
].join('\n');

// ── 工具定义 ───────────────────────────────────────────────────

const ORCHESTRATOR_TOOLS: ToolDefinition[] = [
  {
    name: 'inject_hint',
    description: '向主Agent的上下文中注入一条提醒/约束提示（写入 Zone 5 Live 区）。仅在记忆中的约束与当前操作直接相关时调用。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要注入的提示文本，一行简短文字' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_add',
    description: '新增一条记忆。写入前先搜索是否已有类似条目——更新优于新建。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆内容，一行文字' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_update',
    description: '修改已有记忆。需提供旧文本（完全匹配）和新文本。',
    input_schema: {
      type: 'object',
      properties: {
        old_text: { type: 'string', description: '要替换的旧文本（需完全匹配）' },
        new_text: { type: 'string', description: '新文本' },
      },
      required: ['old_text', 'new_text'],
    },
  },
  {
    name: 'memory_remove',
    description: '删除一条记忆。需提供要删除的文本（完全匹配）。',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要删除的文本（需完全匹配）' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_search',
    description: '搜索已有记忆，返回匹配条目。用于去重判断。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
  },
];

// ── 记忆文件操作 ───────────────────────────────────────────────

const MEMORY_HEADER = '# 记忆\n';

function readMemory(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    return lines
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeMemory(filePath: string, entries: string[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const content = MEMORY_HEADER + entries.map(e => `- ${e}`).join('\n') + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');
}

function searchMemory(entries: string[], query: string): string[] {
  const q = query.toLowerCase();
  return entries.filter(e => e.toLowerCase().includes(q));
}

function createMemoryExecutor(memoryPath: string) {
  return async (name: string, input: Record<string, unknown>): Promise<string> => {
    const entries = readMemory(memoryPath);

    switch (name) {
      case 'memory_add': {
        const text = (input.text as string)?.trim();
        if (!text) return 'Error: text 不能为空';
        if (entries.includes(text)) return `已存在相同条目，跳过。`;
        entries.push(text);
        writeMemory(memoryPath, entries);
        return `ok: 已添加记忆 (共 ${entries.length} 条)`;
      }
      case 'memory_update': {
        const oldText = (input.old_text as string)?.trim();
        const newText = (input.new_text as string)?.trim();
        if (!oldText || !newText) return 'Error: old_text 和 new_text 必填';
        const idx = entries.indexOf(oldText);
        if (idx === -1) return `Error: 未找到匹配条目。用 memory_search 确认内容后再试。`;
        entries[idx] = newText;
        writeMemory(memoryPath, entries);
        return `ok: 已更新记忆`;
      }
      case 'memory_remove': {
        const text = (input.text as string)?.trim();
        if (!text) return 'Error: text 不能为空';
        const idx = entries.indexOf(text);
        if (idx === -1) return `Error: 未找到匹配条目。用 memory_search 确认内容后再试。`;
        entries.splice(idx, 1);
        writeMemory(memoryPath, entries);
        return `ok: 已删除记忆 (共 ${entries.length} 条)`;
      }
      case 'memory_search': {
        const query = (input.query as string)?.trim();
        if (!query) return 'Error: query 不能为空';
        const results = searchMemory(entries, query);
        if (results.length === 0) return '(无匹配记忆)';
        return results.map((e, i) => `${i + 1}. ${e}`).join('\n');
      }
      default:
        return `Error: 未知工具 "${name}"`;
    }
  };
}

// ── 审查 ───────────────────────────────────────────────────────

const REVIEW_SYSTEM = [
  '你是主Agent的"监督者"。审查主Agent本轮回复是否偏离用户意图。',
  '',
  '前提：若当前意图为空（preTurn未设定意图），直接输出 OK，不做偏离判断。',
  '',
  '判断标准：',
  '- 方向正确：回复正朝着用户的目标前进',
  '- 偏离：回复忽略了核心需求、跑题、做了用户没说的事',
  '- 用户意图不清晰（但有设定意图时）：主Agent是否主动确认澄清？没有 → 偏离',
  '- 仅审查文本回复，工具调用（如 read/write/bash）本身不算偏离',
  '',
  '当判定偏离时，调用 inject_hint 工具注入纠正提示。不确定时输出 OK 即可。',
].join('\n');

// ── 介入策略 ───────────────────────────────────────────────────

interface BypassContext {
  intent: string;
  iterationCount: number;
  consecutiveDeviations: number;
  lastInjectionIteration: number;
}

function shouldInject(ctx: BypassContext): boolean {
  const THRESHOLD = 2;    // 连续偏离 2 次才介入
  const COOLDOWN = 3;    // 注入后冷却 3 轮
  return (
    ctx.consecutiveDeviations >= THRESHOLD &&
    ctx.iterationCount - ctx.lastInjectionIteration >= COOLDOWN
  );
}

// ── Orchestrator ────────────────────────────────────────────────

export class ContextOrchestrator extends BypassAgentBase {
  private memoryPath: string;
  private _ctx: BypassContext = {
    intent: '',
    iterationCount: 0,
    consecutiveDeviations: 0,
    lastInjectionIteration: -999,
  };

  constructor(memoryPath: string) {
    const memoryExec = createMemoryExecutor(memoryPath);
    const selfRef: { ref: ContextOrchestrator | null } = { ref: null };
    const config: BypassAgentConfig = {
      name: 'orchestrator',
      modes: ['normal'],
      modelChannel: 'orchestrator',
      tools: ORCHESTRATOR_TOOLS,
      executeTool: async (name: string, input: Record<string, unknown>) => {
        if (name === 'inject_hint') return selfRef.ref!._handleInjectHint(input);
        return memoryExec(name, input);
      },
    };
    super(config);
    this.memoryPath = memoryPath;
    selfRef.ref = this;
  }

  async start(): Promise<void> {
    this._ctx = { intent: '', iterationCount: 0, consecutiveDeviations: 0, lastInjectionIteration: -999 };
    log('START');
  }
  async stop(): Promise<void> {
    log('STOP');
  }

  // ── preTurn：意图识别 → inject_hint 工具注入 ──────────────────

  async preTurn(ctx: PreTurnContext): Promise<PreTurnResult> {
    const provider = this.getProvider();
    if (!provider) return { injections: [] };

    // 重置本轮迭代状态
    this._ctx.iterationCount = 0;
    this._ctx.consecutiveDeviations = 0;

    // 读当前记忆
    const memories = readMemory(this.memoryPath);
    const memoryText = memories.length > 0
      ? memories.map((e, i) => `${i + 1}. ${e}`).join('\n')
      : '(暂无记忆)';

    const recentMsgs = ctx.recentHistory.slice(-8);
    const conversationCtx = recentMsgs.length > 0
      ? recentMsgs.map(m => {
          const role = m.role === 'user' ? '用户' : '主Agent';
          const text = extractText(m);
          return `[${role}] ${text.slice(0, 200)}`;
        }).join('\n')
      : '(新会话)';

    const userPrompt = [
      '【主Agent记忆】',
      memoryText,
      '',
      '【当前用户输入】',
      ctx.userInput.slice(0, 500),
      '',
      '【最近对话】',
      conversationCtx,
    ].join('\n');

    const output = await this.callLLMWithTools(PRETURN_SYSTEM, userPrompt, 3);

    logDetail('preTurn USER_INPUT', ctx.userInput);
    logDetail('preTurn LLM_OUTPUT', output || '(empty)');

    // 从文字输出中提取意图（供 postTurn 纠偏用）
    this._ctx.intent = output.split('\n')[0]?.trim() || output || '';
    log(`preTurn → intent="${this._ctx.intent}"`);

    // 注入已通过 inject_hint 工具写入，不返回隐式 injections
    return { injections: [] };
  }

  // ── postTurn ──────────────────────────────────────────────────

  async postTurn(ctx: PostTurnContext): Promise<void> {
    this._ctx.iterationCount++;

    if (ctx.isLastIteration) {
      await this.reviewAndRemember(ctx);
    } else {
      await this.reviewOnly(ctx);
    }
  }

  /** 审查本轮回复（每次迭代），偏离时调 inject_hint 工具 */
  private async reviewOnly(ctx: PostTurnContext): Promise<void> {
    const provider = this.getProvider();
    if (!provider || !ctx.assistantOutput || !this._ctx.intent) return;

    const userPrompt = [
      `【意图】${this._ctx.intent}`,
      '',
      '【主Agent本轮回复】',
      ctx.assistantOutput.slice(0, 500),
      '',
      '【工具调用】',
      ctx.toolCallsThisTurn.join(', ') || '(无)',
    ].join('\n');

    const verdict = await this.callLLMWithTools(REVIEW_SYSTEM, userPrompt, 2);

    logDetail(`review #${this._ctx.iterationCount} ASSISTANT_OUTPUT`, ctx.assistantOutput);
    logDetail(`review #${this._ctx.iterationCount} VERDICT`, verdict || '(empty)');

    if (!verdict || verdict === 'OK') {
      this._ctx.consecutiveDeviations = 0;
      return;
    }

    // LLM 判定偏离 → 它应该已经调了 inject_hint（由 REVIEW_SYSTEM 提示）
    // 但如果 LLM 输出 DEVIATION 文字却忘了调工具，这里做兜底
    this._ctx.consecutiveDeviations++;
    if (shouldInject(this._ctx) && !verdict.includes('inject_hint')) {
      // LLM 没调工具，手动注入
      const correction = verdict.replace(/^DEVIATION:\s*/, '');
      this._handleInjectHint({ text: `[纠正] ${correction}` });
      this._ctx.lastInjectionIteration = this._ctx.iterationCount;
      this._ctx.consecutiveDeviations = 0;
      logDetail(`INJECT (fallback) at #${this._ctx.iterationCount}`, correction);
    }
  }

  /** 最后一轮：审查 + 记忆处理 */
  private async reviewAndRemember(ctx: PostTurnContext): Promise<void> {
    log(`FINAL iteration #${this._ctx.iterationCount} → memory processing`);
    const provider = this.getProvider();
    if (!provider) return;

    const memories = readMemory(this.memoryPath);
    const memoryText = memories.length > 0
      ? memories.map((e, i) => `${i + 1}. ${e}`).join('\n')
      : '(暂无记忆)';

    const userPrompt = [
      '【当前记忆】',
      memoryText,
      '',
      '【用户输入】',
      ctx.userInput.slice(0, 500),
      '',
      '【意图】',
      this._ctx.intent || '(未设定)',
      '',
      '本轮任务已完成。请判断是否有值得长期记住的信息。',
      '有则用工具维护记忆（先 search 去重），无则直接结束。',
    ].join('\n');

    await this.callLLMWithTools(POSTTURN_SYSTEM, userPrompt, 3);
  }

  // ── inject_hint 工具实现 ──────────────────────────────────────

  private _handleInjectHint(input: Record<string, unknown>): string {
    if (!this._manager) return 'Error: inject_hint 不可用（manager 未注入）';
    const text = (input.text as string)?.trim();
    if (!text) return 'Error: text 不能为空';
    this._manager.inject('orchestrator', {
      section: 'orchestrator_hint',
      content: text,
      role: 'user',
      mode: 'replace',
    });
    logDetail('INJECT hint via tool', text);
    return 'ok: 已注入提示到 Zone 5';
  }
}

// ── 辅助 ───────────────────────────────────────────────────────

function extractText(msg: { role: string; content: unknown }): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join(' ');
  }
  if (content && typeof content === 'object' && 'text' in content) {
    return (content as any).text;
  }
  return '';
}
