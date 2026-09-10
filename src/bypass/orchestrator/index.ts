// ╔══════════════════════════════════════════════════════════════╗
// ║  ⚠️ 安全红线 · 旁路智能体（元认知层）工具白名单            ║
// ╠══════════════════════════════════════════════════════════════╣
// ║  本文件是旁路智能体（意图识别/纠偏/记忆维护），直接注入      ║
// ║  主 Agent 上下文。出错会带偏主 Agent——【风险最高】的一层。  ║
// ║                                                              ║
// ║  ✅ 只允许 ORCHESTRATOR_TOOLS 里的专一化窄工具：             ║
// ║     memory_* / inject_hint / cluster_assign                  ║
// ║     （固定 schema · 只读写本 Agent 自己的记忆文件）          ║
// ║  ❌ 禁止 bash/read/write/edit/http_request 等通用工具。      ║
// ║     加通用工具 = 安全事故。                                  ║
// ║  维护此项目的 Agent：即使只读前几行也必须遵守。             ║
// ║  完整规则见 src/bypass/base.ts 头部。                        ║
// ╚══════════════════════════════════════════════════════════════╝

// ============================================================
// bypass/orchestrator — ContextOrchestrator
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

import { BypassAgentBase } from '../base.js';
import type { BypassAgentConfig } from '../base.js';
import type {
  PreTurnContext,
  PostTurnContext,
  PreTurnResult,
} from '../types.js';
import type { ToolDefinition } from '../../types.js';
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
  '1. 分析当前用户输入，判断意图类型，用标签标注：',
  '   [CAPABILITY: coding|chat|tool_use|reasoning|general]',
  '   - coding: 编程、调试、代码审查、架构设计',
  '   - chat: 闲聊、问答、讨论',
  '   - tool_use: 文件操作、系统命令、配置管理',
  '   - reasoning: 深度分析、方案设计、决策',
  '   - general: 不属于以上分类',
  '2. 估计你的判断置信度（0.0-1.0）',
  '3. 检查「主Agent记忆」中是否有直接适用于当前情境的约束',
  '4. 仅当记忆中的约束与当前操作直接相关时，才调用 inject_hint 工具注入提醒',
  '',
  '输出格式（务必严格遵守）：',
  '[CAPABILITY: xxx] confidence: 0.X',
  '（接下来是你的意图分析文本）',
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
  '即使不注入也要按格式输出意图分析。',
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
//
// ⚠️ 安全约束：本旁路智能体是元认知层（意图识别 / 纠偏 / 记忆维护）。
// 下方工具是它仅有的能力来源——全部是"极其专一化"的窄工具：
// 固定 schema、只读写本 Agent 自己的记忆文件（固定路径 + 固定格式
// `- 条目` 行），绝不触碰任意文件或执行任意命令。
//
// ❌ 不要往这里添加 bash / read / write / edit / http_request 等
// 通用工具。旁路智能体出错 = 元认知层带偏主 Agent，风险极高。
// 新增工具前先过 base.ts 头部的安全自问清单。

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
  {
    name: 'cluster_assign',
    description: '将本轮对话归入意图簇。cluster_id 使用英文下划线命名，summary 为簇的一句话描述。如果归入已有簇，summary 应为更新后的描述。',
    input_schema: {
      type: 'object',
      properties: {
        cluster_id: { type: 'string', description: '簇 ID（英文下划线，如 channel_config）' },
        summary: { type: 'string', description: '簇的一句话摘要（不超过 30 字）' },
      },
      required: ['cluster_id', 'summary'],
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

// ── 恢复审查（P2-2，Reasonix 恢复审批门思路）─────────────────────────
// 本轮执行失败（验证/证据门触发、plan_execute 预测落空）时，
// 判断主Agent的回复是否在正确应对失败：回避/假装完成 → inject_hint 纠正。
// 与 REVIEW_SYSTEM 的区别：只在 ctx.failure 存在时启用，专注"恢复是否正确"。

const RECOVERY_SYSTEM = [
  '你是主Agent的"恢复监督者"。本轮执行失败，你的任务：判断主Agent的回复是否在【正确应对失败】。',
  '',
  '判断标准：',
  '- 正确应对：回复在分析失败原因、修正方案、运行验证（测试/编译）、请求必要信息',
  '- 回避失败：转移话题、含糊带过、声称"完成"但未解决失败信息指出的问题',
  '',
  '当判定"回避失败"时，调用 inject_hint 工具注入纠正提示（一行，明确指出失败信息与应该做的事）。',
  '回复正在正确应对失败或不确定时，输出 OK 即可。',
].join('\n');

// ── 簇归类 ───────────────────────────────────────────────────

const CLUSTER_SYSTEM = [
  '你是主Agent的"会话归档员"。你的任务是将本轮对话归类到意图簇中。',
  '',
  '已有意图簇（可能为空）：',
  '（将在调用时由代码注入）',
  '',
  '判断标准：',
  '- 如果本轮对话的主题与已有簇一致 → 调用 cluster_assign 归入该簇，更新其 summary',
  '- 如果本轮开启了新话题 → 调用 cluster_assign 创建新簇',
  '- cluster_id 使用英文下划线命名（如 "channel_config", "env_fix", "agent_design"）',
  '- summary 为簇的一句话描述（不超过 30 字），新簇写新描述，已有簇写更新后的描述',
  '',
  '重要的默认行为：',
  '- 不确定时宁可创建新簇，也不要强行归入不相关的旧簇',
  '- 如果已有簇的 summary 已经准确，不需要修改',
].join('\n');

// ── 历史回填归类（方案 A：orchestrator 开启晚时，对未分类历史补做归类）──

const BACKFILL_SYSTEM = [
  '你是主Agent的"历史归档员"。你的任务是把一段【历史对话】归入意图簇。',
  '',
  '这段对话来自早期历史，当时没有进行过意图分类。',
  '',
  '输出要求（严格一行，无其他文字）：',
  'cluster_id=<英文下划线ID> capability=<coding|chat|tool_use|reasoning|general> summary=<一句话描述，不超过30字>',
  '',
  '判断标准：',
  '- 主题与已有簇一致 → 复用该簇的 cluster_id，capability 保持该簇的，summary 可更新',
  '- 全新主题 → 创建新 cluster_id（英文下划线，如 "env_fix", "agent_design"），capability 按对话性质判断',
  '- 对话太零碎/无法归类 → cluster_id=legacy_general capability=general summary=早期历史杂项',
  '',
  'capability 含义：coding=编程/代码, chat=普通闲聊, tool_use=操作工具/文件, reasoning=分析推理, general=通用',
  '注意：只输出 cluster_id=... capability=... summary=... 这一行。',
].join('\n');

// ── 介入策略 ───────────────────────────────────────────────────

/** 意图簇索引条目 */
interface ClusterIndex {
  id: string;
  capability: string;
  summary: string;
  /** conversation_full.jsonl 中的起止行号 */
  line_start: number;
  line_end: number;
}

interface BypassContext {
  intent: string;
  capability: string;
  confidence: number;
  iterationCount: number;
  consecutiveDeviations: number;
  lastInjectionIteration: number;
  /** 恢复审查（P2-2）：连续"回避失败"计数 + 上次注入迭代 */
  recoveryFailures: number;
  lastRecoveryInjection: number;
  /** 当前 session 的意图簇列表（按时间顺序） */
  clusters: ClusterIndex[];
  /** 回填进度：已回填到 conversation_full.jsonl 的行号（0 = 从未回填）。防止重复回填历史。 */
  backfilledUpto: number;
}

/** 从 LLM 输出中解析结构化意图标签 */
function parseIntentCapability(output: string): { capability: string; confidence: number; text: string } {
  const capMatch = output.match(/\[CAPABILITY:\s*(coding|chat|tool_use|reasoning|general)\]/i);
  const confMatch = output.match(/confidence:\s*(0?\.\d+|1\.?0?)/i);
  const capability = capMatch ? capMatch[1].toLowerCase() : 'general';
  const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;
  // 移除标签后的纯文本作为意图描述
  const text = output.replace(/\[CAPABILITY:.*?\]\s*/i, '').replace(/confidence:\s*[\d.]+\s*/i, '').trim();
  return { capability, confidence: Math.max(0, Math.min(1, confidence)), text };
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
  /** 多 session 隔离：每个 sessionId 独立的 BypassContext */
  private _sessions = new Map<string, BypassContext>();
  /** 默认 context（sessionId 未提供时使用） */
  private _defaultCtx: BypassContext = {
    intent: '',
    capability: 'general',
    confidence: 0,
    iterationCount: 0,
    consecutiveDeviations: 0,
    lastInjectionIteration: -999,
    recoveryFailures: 0,
    lastRecoveryInjection: -999,
    clusters: [],
    backfilledUpto: 0,
  };
  /** Map 上限（防止内存泄漏） */
  private static readonly MAX_SESSIONS = 100;
  /** sessionId 安全白名单 */
  private static readonly SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
  private static readonly CLUSTER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  /** 最新一次簇归类结果（loop.ts 消费后写入 events.jsonl + markCluster） */
  lastClusterAssign: { cluster_id: string; capability: string; summary: string; line_start: number; line_end: number; session_id: string } | null = null;
  /** cluster_assign 工具调用时的上下文（classifyCluster 在 LLM 调用前设置，工具内部消费后清空） */
  private _pendingClusterCtx: {
    sessionId: string;
    capability: string;
    lineEnd: number;
    loadedClusters: Array<{ cluster_id: string; capability: string; summary: string; line_start: number; line_end: number }>;
  } | null = null;

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
        if (name === 'cluster_assign') return selfRef.ref!._handleClusterAssign(input);
        return memoryExec(name, input);
      },
    };
    super(config);
    this.memoryPath = memoryPath;
    selfRef.ref = this;
  }

  async start(): Promise<void> {
    this._sessions.clear();
    this._defaultCtx = { intent: '', capability: 'general', confidence: 0, iterationCount: 0, consecutiveDeviations: 0, lastInjectionIteration: -999, recoveryFailures: 0, lastRecoveryInjection: -999, clusters: [], backfilledUpto: 0 };
    log('START');
  }
  async stop(): Promise<void> {
    this._sessions.clear();
    log('STOP');
  }

  /** 按 sessionId 获取隔离的 BypassContext（安全校验 + 上限保护） */
  private sessionCtx(sessionId?: string): BypassContext {
    if (!sessionId || !ContextOrchestrator.SESSION_ID_RE.test(sessionId)) {
      return this._defaultCtx;
    }
    let ctx = this._sessions.get(sessionId);
    if (!ctx) {
      // 上限保护：超过 MAX_SESSIONS 时清理最旧的条目
      if (this._sessions.size >= ContextOrchestrator.MAX_SESSIONS) {
        const firstKey = this._sessions.keys().next().value;
        if (firstKey) this._sessions.delete(firstKey);
      }
      ctx = {
        intent: '',
        capability: 'general',
        confidence: 0,
        iterationCount: 0,
        consecutiveDeviations: 0,
        lastInjectionIteration: -999,
        recoveryFailures: 0,
        lastRecoveryInjection: -999,
        clusters: [],
        backfilledUpto: 0,
      };
      this._sessions.set(sessionId, ctx);
    }
    return ctx;
  }

  // ── preTurn：意图识别 → inject_hint 工具注入 ──────────────────

  async preTurn(ctx: PreTurnContext): Promise<PreTurnResult> {
    const provider = this.getProvider();
    if (!provider) return { injections: [] };

    const sc = this.sessionCtx(ctx.sessionId);
    // 重置本轮迭代状态
    sc.iterationCount = 0;
    sc.consecutiveDeviations = 0;

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

    // 解析结构化意图
    const parsed = parseIntentCapability(output || '');
    sc.intent = parsed.text || output || '';
    sc.capability = parsed.capability;
    sc.confidence = parsed.confidence;
    log(`preTurn → capability="${sc.capability}" conf=${sc.confidence} intent="${sc.intent}"`);

    // 注入已通过 inject_hint 工具写入
    return { injections: [], intent: { capability: sc.capability, confidence: sc.confidence } };
  }

  // ── postTurn ──────────────────────────────────────────────────

  async postTurn(ctx: PostTurnContext): Promise<void> {
    const sc = this.sessionCtx(ctx.sessionId);
    sc.iterationCount++;

    if (ctx.failure) {
      // P2-2 恢复审查：本轮失败 → 判断主Agent是否在正确应对（优先级最高）
      await this.reviewRecovery(ctx, sc);
    } else if (ctx.isLastIteration) {
      await this.reviewAndRemember(ctx, sc);
    } else {
      await this.reviewOnly(ctx, sc);
    }
  }

  /**
   * 恢复审查（P2-2，Reasonix 恢复审批门）：本轮执行失败时，判断主Agent的回复
   * 是否在正确应对失败。连续"回避失败"达到阈值后经 inject_hint 注入纠正（Zone 5）。
   * 沉默是默认：正确应对或不确定 → 不注入。
   */
  private async reviewRecovery(ctx: PostTurnContext, sc: BypassContext): Promise<void> {
    const provider = this.getProvider();
    if (!provider || !ctx.assistantOutput) return;

    const userPrompt = [
      '【失败信息】',
      ctx.failure,
      '',
      '【主Agent本轮回复】',
      ctx.assistantOutput.slice(0, 500),
      '',
      '【本轮工具调用】',
      ctx.toolCallsThisTurn.join(', ') || '(无)',
    ].join('\n');

    const verdict = await this.callLLMWithTools(RECOVERY_SYSTEM, userPrompt, 2);

    logDetail(`recovery review #${sc.iterationCount}`, verdict || '(empty)');

    if (!verdict || verdict === 'OK') {
      sc.recoveryFailures = 0;
      return;
    }

    sc.recoveryFailures++;
    // 冷却：连续 2 次回避失败才介入，注入后冷却 2 轮（与 shouldInject 同思路）
    const RECOVERY_THRESHOLD = 2;
    const RECOVERY_COOLDOWN = 2;
    if (sc.recoveryFailures >= RECOVERY_THRESHOLD &&
        sc.iterationCount - sc.lastRecoveryInjection >= RECOVERY_COOLDOWN) {
      const correction = verdict.replace(/^DEVIATION:\s*/i, '').replace(/^ok:\s*/i, '').trim().slice(0, 200);
      if (correction) {
        this._handleInjectHint({ text: `[恢复审查] ${correction}` });
        sc.lastRecoveryInjection = sc.iterationCount;
        sc.recoveryFailures = 0;
        logDetail(`RECOVERY INJECT at #${sc.iterationCount}`, correction);
      }
    }
  }

  /** 审查本轮回复（每次迭代），偏离时调 inject_hint 工具 */
  private async reviewOnly(ctx: PostTurnContext, sc: BypassContext): Promise<void> {
    const provider = this.getProvider();
    if (!provider || !ctx.assistantOutput || !sc.intent) return;

    const userPrompt = [
      `【意图】${sc.intent}`,
      '',
      '【主Agent本轮回复】',
      ctx.assistantOutput.slice(0, 500),
      '',
      '【工具调用】',
      ctx.toolCallsThisTurn.join(', ') || '(无)',
    ].join('\n');

    const verdict = await this.callLLMWithTools(REVIEW_SYSTEM, userPrompt, 2);

    logDetail(`review #${sc.iterationCount} ASSISTANT_OUTPUT`, ctx.assistantOutput);
    logDetail(`review #${sc.iterationCount} VERDICT`, verdict || '(empty)');

    if (!verdict || verdict === 'OK') {
      sc.consecutiveDeviations = 0;
      return;
    }

    sc.consecutiveDeviations++;
    if (shouldInject(sc) && !verdict.includes('inject_hint')) {
      const correction = verdict.replace(/^DEVIATION:\s*/, '');
      this._handleInjectHint({ text: `[纠正] ${correction}` });
      sc.lastInjectionIteration = sc.iterationCount;
      sc.consecutiveDeviations = 0;
      logDetail(`INJECT (fallback) at #${sc.iterationCount}`, correction);
    }
  }

  /** 最后一轮：审查 + 记忆处理 + 簇归类 */
  private async reviewAndRemember(ctx: PostTurnContext, sc: BypassContext): Promise<void> {
    log(`FINAL iteration #${sc.iterationCount} → memory processing`);
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
      sc.intent || '(未设定)',
      '',
      '本轮任务已完成。请判断是否有值得长期记住的信息。',
      '有则用工具维护记忆（先 search 去重），无则直接结束。',
    ].join('\n');

    await this.callLLMWithTools(POSTTURN_SYSTEM, userPrompt, 3);

    // ── 簇归类（每次最后一轮都执行）──
    if (ctx.fullArchiveLineCount && ctx.fullArchiveLineCount > 0) {
      await this.classifyCluster(ctx, sc);
    }
  }

  /** 簇归类：LLM 判断本轮属于已有簇还是新簇。
   *  cluster_assign 工具（_handleClusterAssign）直接在调用时写盘，
   *  此处仅负责：加载已有簇列表 → 构建 prompt → 调用 LLM（工具在内部完成写入）。
   *  正则回退路径：LLM 未调工具但在文本中输出了 cluster_id → 此处补写盘。 */
  private async classifyCluster(ctx: PostTurnContext, sc: BypassContext): Promise<void> {
    const provider = this.getProvider();
    if (!provider) return;

    const sessionId = ctx.sessionId ?? '';
    const lineEnd = ctx.fullArchiveLineCount ?? 0;

    // 从文件读取已有簇索引
    const loadedClusters = await this.loadClusterIndex(sessionId);
    const existingClusters = loadedClusters.length > 0
      ? loadedClusters.map(c => `- ${c.cluster_id}: ${c.summary} (行 ${c.line_start}-${c.line_end})`).join('\n')
      : '(暂无已有簇)';

    const clusterPrompt = CLUSTER_SYSTEM.replace(
      '（将在调用时由代码注入）',
      existingClusters,
    );

    const userPrompt = [
      '【当前意图】',
      `[CAPABILITY: ${sc.capability}] (conf: ${sc.confidence.toFixed(2)})`,
      '',
      '【本轮用户输入】',
      ctx.userInput.slice(0, 500),
      '',
      '【本轮主Agent回复摘要】',
      ctx.assistantOutput.slice(0, 300),
      '',
      '请判断本轮对话属于哪个意图簇，调用 cluster_assign 工具。',
    ].join('\n');

    // 设置工具上下文：LLM 调 cluster_assign 时，_handleClusterAssign 会消费它并写盘
    this._pendingClusterCtx = { sessionId, capability: sc.capability, lineEnd, loadedClusters };
    this.lastClusterAssign = null;

    const output = await this.callLLMWithTools(clusterPrompt, userPrompt, 2);
    logDetail('CLUSTER classification output', output || '(empty)');

    // 工具已在 LLM 调用期间完成写盘 → lastClusterAssign 已被设置
    if (this.lastClusterAssign) {
      this._pendingClusterCtx = null;
      this._updateMemoryClusters(sc, this.lastClusterAssign);
      return;
    }

    this._pendingClusterCtx = null;

    // 回退：LLM 未调工具但在文本中输出了 cluster_id
    const clusterId = output.match(/cluster_id=(\S+)/)?.[1];
    if (!clusterId) return;
    if (!ContextOrchestrator.CLUSTER_ID_RE.test(clusterId)) {
      log('CLUSTER rejected invalid cluster_id: ' + clusterId);
      return;
    }

    const fallbackSummary = output.replace(/cluster_id=\S+\s*/g, '').replace(/^ok:\s*/g, '').trim() || clusterId;
    const lineInfo = this._writeClusterFiles(clusterId, fallbackSummary, sessionId, sc.capability, lineEnd, loadedClusters);
    this.lastClusterAssign = {
      cluster_id: clusterId,
      capability: sc.capability,
      summary: fallbackSummary,
      line_start: lineInfo.line_start,
      line_end: lineEnd,
      session_id: sessionId,
    };
    this._updateMemoryClusters(sc, this.lastClusterAssign);
  }

  /** 写簇数据文件（cluster-index.json + 初始摘要），返回行号范围 */
  private _writeClusterFiles(
    clusterId: string, summary: string, sessionId: string,
    capability: string, lineEnd: number,
    loadedClusters: Array<{ cluster_id: string; capability: string; summary: string; line_start: number; line_end: number }>,
  ): { line_start: number; line_end: number } {
    const existing = loadedClusters.find(c => c.cluster_id === clusterId);
    const lineStart = existing ? existing.line_start : Math.max(1, lineEnd - 5);

    // 1. 更新 cluster-index.json
    const updated = loadedClusters.filter(c => c.cluster_id !== clusterId);
    updated.push({ cluster_id: clusterId, capability, summary, line_start: lineStart, line_end: lineEnd });
    this._writeFile(sessionId, 'cluster-index.json', JSON.stringify(updated, null, 2));

    // 2. 写初始簇摘要
    const summaryPath = path.join('summaries', `cluster_${clusterId}.md`);
    this._writeFile(sessionId, summaryPath, summary);

    return { line_start: lineStart, line_end: lineEnd };
  }

  /** 写 session 目录下的文件（自动拼接 ~/.agent/sessions/{sessionId}/{relPath}） */
  private _writeFile(sessionId: string, relPath: string, content: string): void {
    const filePath = path.join(os.homedir(), '.agent', 'sessions', sessionId, relPath);
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      log(`CLUSTER write failed: ${relPath} — ${(err as Error).message}`);
    }
  }

  /** 更新内存中的簇索引（与文件保持同步，供同 session 内后续 classifyCluster 快速查询） */
  private _updateMemoryClusters(
    sc: BypassContext,
    ca: NonNullable<ContextOrchestrator['lastClusterAssign']>,
  ): void {
    const existing = sc.clusters.find(c => c.id === ca.cluster_id);
    if (existing) {
      existing.line_end = ca.line_end;
      existing.summary = ca.summary;
    } else {
      sc.clusters.push({
        id: ca.cluster_id,
        capability: ca.capability,
        summary: ca.summary,
        line_start: ca.line_start,
        line_end: ca.line_end,
      });
    }
  }

  /**
   * 从 sessionDir/cluster-index.json 读取已有簇索引。
   * 替代原来纯内存的 sc.clusters，重启后不丢失。
   */
  private async loadClusterIndex(sessionId: string): Promise<Array<{
    cluster_id: string; capability: string; summary: string;
    line_start: number; line_end: number;
  }>> {
    if (!sessionId) return [];
    const filePath = path.join(os.homedir(), '.agent', 'sessions', sessionId, 'cluster-index.json');
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as Array<{
        cluster_id: string; capability: string; summary: string;
        line_start: number; line_end: number;
      }>;
    } catch {
      return [];
    }
  }

  /** 轻量查询：某 session 已回填到的行号（loop 用 fullLineCount 预判是否需要真正回填，避免每轮读全量文件） */
  getBackfillUpto(sessionId: string): number {
    if (!sessionId || !ContextOrchestrator.SESSION_ID_RE.test(sessionId)) return 0;
    const sc = this._sessions.get(sessionId);
    return sc?.backfilledUpto ?? 0;
  }

  /**
   * 历史回填归类（方案 A）：orchestrator 开启晚时，对开启前的未分类历史补做意图簇归类。
   *
   * 幂等设计：基于 BypassContext.backfilledUpto 增量扫描，只处理新增的无标记块，
   * 每轮调用都是安全的（大多数时候返回 []）。
   *
   * 归类结果直接写盘（cluster-index.json + summaries/cluster_{id}.md），行号为精确的块范围，
   * 不使用 lastClusterAssign 通道（避免与本轮归类冲突）。返回结果数组供 loop 消费 markCluster。
   *
   * 摘要兜底（方案 E）：BACKFILL_SYSTEM 要求无法归类的块归 legacy_general 簇，
   * 保证 LLM 正常时所有历史都有归属；LLM 失败时静默跳过，不影响主流程。
   */
  async backfillUnclassified(sessionId: string): Promise<Array<{
    cluster_id: string; capability: string; summary: string;
    line_start: number; line_end: number; session_id: string;
  }>> {
    const results: Array<{
      cluster_id: string; capability: string; summary: string;
      line_start: number; line_end: number; session_id: string;
    }> = [];
    try {
      if (!sessionId || !ContextOrchestrator.SESSION_ID_RE.test(sessionId)) return results;
      const sc = this.sessionCtx(sessionId);
      const fullPath = path.join(os.homedir(), '.agent', 'sessions', sessionId, 'conversation_full.jsonl');
      if (!fs.existsSync(fullPath)) return results;
      const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(l => l.trim());
      if (lines.length === 0) return results;

      const upto = sc.backfilledUpto ?? 0;
      if (upto >= lines.length) return results;

      // 找 [upto, lines.length) 区间内无 _cluster_id 的连续块
      const blocks: Array<{ start: number; end: number }> = [];
      let blockStart = -1;
      for (let i = upto; i < lines.length; i++) {
        let hasCluster = false;
        try { hasCluster = !!(JSON.parse(lines[i]) as { _cluster_id?: string })._cluster_id; } catch { /* 解析失败按未标记 */ }
        if (!hasCluster && blockStart < 0) blockStart = i;
        if (hasCluster && blockStart >= 0) {
          blocks.push({ start: blockStart, end: i - 1 });
          blockStart = -1;
        }
      }
      if (blockStart >= 0) blocks.push({ start: blockStart, end: lines.length - 1 });

      // 分批归类：每批最多 30 条历史消息（控制单次 LLM 上下文与成本）
      const BATCH = 30;
      for (const block of blocks) {
        if (block.end - block.start + 1 < 3) continue; // 块太短不单独归类（<3 条），留给最近 N 轮保底

        for (let s = block.start; s <= block.end; s += BATCH) {
          const e = Math.min(s + BATCH - 1, block.end);
          // 每批重新加载最新索引：既用于 LLM 提示（能看到刚创建的簇），
          // 也避免同簇多批次写盘时互相覆盖行号。
          const loadedClusters = await this.loadClusterIndex(sessionId);
          const existingClusters = loadedClusters.length > 0
            ? loadedClusters.map(c => `- ${c.cluster_id}: ${c.summary} (行 ${c.line_start}-${c.line_end})`).join('\n')
            : '(暂无已有簇)';

          const chunk = lines.slice(s, e + 1).map((l, i) => {
            try {
              const m = JSON.parse(l) as { role?: string; content?: unknown };
              const role = m.role ?? '?';
              const text = m.content !== undefined ? extractText({ role: m.role ?? 'unknown', content: m.content }) : '';
              return `[行 ${s + i + 1}] ${role}: ${text.slice(0, 120)}`;
            } catch { return ''; }
          }).filter(Boolean).join('\n');

          const userPrompt = [
            '【已有意图簇】',
            existingClusters,
            '',
            '【待归类历史对话】（行号从 1 开始）',
            chunk,
          ].join('\n');

          const output = await this.callLLM(BACKFILL_SYSTEM, userPrompt);
          const clusterId = output.match(/cluster_id=(\S+)/)?.[1];
          if (!clusterId || !ContextOrchestrator.CLUSTER_ID_RE.test(clusterId)) {
            log(`BACKFILL skipped (invalid cluster_id) block 行 ${s + 1}-${e + 1}`);
            continue;
          }
          // 解析 capability（白名单校验，失败回退 general）
          const capMatch = output.match(/capability=(\S+)/i)?.[1]?.toLowerCase();
          const capability = capMatch && /^(coding|chat|tool_use|reasoning|general)$/.test(capMatch)
            ? capMatch
            : 'general';
          const summary = output
            .replace(/cluster_id=\S+\s*/i, '')
            .replace(/capability=\S+\s*/i, '')
            .replace(/summary=\s*/i, '')
            .trim()
            .slice(0, 30) || clusterId;

          // 直接写盘（精确行号），不依赖 _writeClusterFiles 的行号估算。
          // 同簇合并：保留最小 line_start、最大 line_end（同簇多批次不覆盖）。
          const latest = await this.loadClusterIndex(sessionId);
          const existing = latest.find(c => c.cluster_id === clusterId);
          let line_start: number;
          let line_end: number;
          if (existing) {
            existing.line_start = Math.min(existing.line_start, s + 1);
            existing.line_end = Math.max(existing.line_end, e + 1);
            existing.summary = summary;
            existing.capability = capability;
            line_start = existing.line_start;
            line_end = existing.line_end;
            this._writeFile(sessionId, 'cluster-index.json', JSON.stringify(latest, null, 2));
          } else {
            const updated = latest.filter(c => c.cluster_id !== clusterId);
            updated.push({
              cluster_id: clusterId,
              capability,
              summary,
              line_start: s + 1,
              line_end: e + 1,
            });
            line_start = s + 1;
            line_end = e + 1;
            this._writeFile(sessionId, 'cluster-index.json', JSON.stringify(updated, null, 2));
          }
          this._writeFile(sessionId, path.join('summaries', `cluster_${clusterId}.md`), summary);

          results.push({
            cluster_id: clusterId,
            capability,
            summary,
            line_start,
            line_end,
            session_id: sessionId,
          });
          this._updateMemoryClusters(sc, {
            cluster_id: clusterId,
            capability,
            summary,
            line_start,
            line_end,
            session_id: sessionId,
          });
          log(`BACKFILL: 行 ${s + 1}-${e + 1} → ${clusterId} (${capability}, ${summary})`);
        }
      }

      sc.backfilledUpto = lines.length;
      return results;
    } catch (err) {
      log(`BACKFILL failed: ${(err as Error).message}`);
      return results;
    }
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

  // ── cluster_assign 工具实现 ────────────────────────────────

  private _handleClusterAssign(input: Record<string, unknown>): string {
    const clusterId = (input.cluster_id as string)?.trim();
    const summary = (input.summary as string)?.trim();
    if (!clusterId || !summary) return 'Error: cluster_id 和 summary 必填';

    // 白名单校验
    if (!ContextOrchestrator.CLUSTER_ID_RE.test(clusterId)) {
      return `Error: cluster_id 格式非法（只允许字母、数字、下划线、连字符，1-64 位）`;
    }

    const ctx = this._pendingClusterCtx;
    if (!ctx) return 'Error: cluster_assign 不在归类上下文中调用';

    // 防止同一轮 LLM 迭代中重复调用
    if (this.lastClusterAssign) {
      return `Error: 本轮已归入簇 "${this.lastClusterAssign.cluster_id}"，请勿重复调用`;
    }

    // 写盘：cluster-index.json + summaries/cluster_{id}.md
    const lineInfo = this._writeClusterFiles(
      clusterId, summary, ctx.sessionId, ctx.capability, ctx.lineEnd, ctx.loadedClusters,
    );

    // 设置 lastClusterAssign 供 loop 消费（写 events.jsonl + markCluster）
    this.lastClusterAssign = {
      cluster_id: clusterId,
      capability: ctx.capability,
      summary,
      line_start: lineInfo.line_start,
      line_end: ctx.lineEnd,
      session_id: ctx.sessionId,
    };

    // 消费后清空，防止同轮重复处理
    this._pendingClusterCtx = null;

    log(`CLUSTER assigned: ${clusterId} (${summary})`);
    return `ok: cluster_id=${clusterId}, summary=${summary}`;
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

