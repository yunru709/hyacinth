/**
 * TruncatingContextComposer —— ContextComposerLike 的**第二个真实实现**（门槛 2 验收件，2026-09-02）。
 *
 * 策略：激进截断（aggressive truncation）。与内置 LayeredContextComposer（Zone 精细分层 +
 * manifest 组装 + 断点缓存）相对：**不做分层、不做 manifest、不保中间细节** —— 预算超限时
 * 直接从最旧开始丢弃消息，只保证「最近消息 + 当前输入」落在预算内。
 *
 * ## 门槛 2 的验证目的
 * B 阶段收窄出的 ContextComposerLike 此前只有自研 demo 把它当**消费面**用过（require + 类型
 * 断言），仓库里从未存在第二个**实现**。本文件即第二个实现，经 stages/context.ts（生产消费方）
 * 真实消费验证接口是否够用 —— 判据：写实现时是否被迫改动 ContextComposerLike。
 *
 * ## 接口观察点记录（门槛 2 产出物之一，喂给 P6-2 服务拆分）
 * - [O1] compose 双签名重载（Layered / legacy 扁平）：实现侧靠 `'systemPrompt' in options`
 *   判别，可行；但接口未声明判别依据，第二个实现必须自行发明 —— 轻微缝。
 * - [O2] activeConditions 是可变字段但无「实现必须消费」的语义契约：内置读它（zone4/precise
 *   开关），knowledge 插件写它（add 'zone4_enabled'）；本实现无 zone4 概念，若静默忽略会导致
 *   插件写入的 zone4 语义静默失效 —— 接口缺少「字段读方」契约的实证。
 * - [O3] LayeredContext.zoneBreakdown 类型 `Record<string, number> & { total }` 允许任意键，
 *   但消费方（context 阶段）只读 total：接口过宽 —— 第二个实现无法从类型上知道该产出哪些键。
 * - [O4] 无配对约束：截断可能拆散 tool_use/tool_result 消息对（激进策略的固有 trade-off，
 *   接口层面无表达 —— 若未来要保配对，需在策略内自行扫描，接口无需改）。
 *
 * 结论（截至本文件）：接口无需改动即可容纳「算法不同、职责相同」的实现 —— B 收窄成立；
 * 但 O2/O3 提示最小接口的**语义契约**应随文档/测试固化，而非靠类型。
 */

import type { ComposeOptions, ContextComposerLike, LayeredComposeOptions, LayeredContext } from './interface.js';
import type { Message, MessageContent } from '../types.js';

// ─── 估算（本实现自带的 token 估算，激进策略专用；不与内置 TokenCounter 共享） ───

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 粗略文本 token 估算：CJK 每字 1 token，其余按 4 字符/token（激进策略宁可估高） */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

const IMAGE_TOKEN_COST = 1200; // 视觉块粗估（对齐常见 vision 定价量级）
const ROLE_OVERHEAD = 2; // role 标记 + 结构开销粗估

function contentTokens(c: MessageContent): number {
  switch (c.type) {
    case 'text':
      return estimateTextTokens(c.text);
    case 'thinking':
      return estimateTextTokens(c.thinking);
    case 'tool_use':
      return estimateTextTokens(c.name) + estimateTextTokens(JSON.stringify(c.input ?? {}));
    case 'tool_result':
      return estimateTextTokens(c.content) + 4;
    case 'image':
      return IMAGE_TOKEN_COST;
    case 'video':
      return c.source.type === 'file' ? 200 : IMAGE_TOKEN_COST * 2;
    case 'audio':
      return c.source.type === 'file' ? 200 : IMAGE_TOKEN_COST;
  }
}

/** 单条消息 token 估算（导出供测试断言与实现共用同一口径） */
export function estimateMessageTokens(msg: Message): number {
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
  return blocks.reduce((acc, b) => acc + contentTokens(b), ROLE_OVERHEAD);
}

/** 提取消息文本（无文本类型返回空串） */
function messageText(msg: Message): string {
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text': return b.text;
        case 'thinking': return b.thinking;
        case 'tool_result': return b.content;
        default: return '';
      }
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

/** 对齐内置 shouldSkipHistoryMessage 的组装过滤语义：system 消息与纯 thinking 不进输出 */
function isSkippableHistory(msg: Message): boolean {
  if (msg.role === 'system') return true;
  const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
  if (blocks.length > 0 && blocks.every((b) => b.type === 'thinking')) return true;
  return false;
}

/**
 * TruncatingContextComposer —— ContextComposerLike 的激进截断实现。
 *
 * 语义（与内置分层版对照，均为「算法不同、职责相同」）：
 * - 内置：Zone1~5 按 manifest 精细组装，逐 zone 摊销预算，保 system/summary/tools/kb/recent；
 * - 本实现：过滤 system/纯 thinking 后，从最旧起丢弃消息直到总估算 ≤ 90% 预算，保留尾部窗口。
 */
export class TruncatingContextComposer implements ContextComposerLike {
  /** O2 观察点：字段存在以满足 knowledge 插件写入；本策略无 zone4 概念，不读它 */
  activeConditions = new Set<string>();

  /** 激进截断策略的预算占用比（剩余 10% 留给 system 尾注/结构开销） */
  private static readonly BUDGET_RATIO = 0.9;

  compose(options: LayeredComposeOptions): Promise<LayeredContext>;
  compose(options: ComposeOptions): Promise<Message[]>;
  async compose(options: LayeredComposeOptions | ComposeOptions): Promise<LayeredContext | Message[]> {
    // O1 观察点：双签名判别 —— legacy 扁平选项必有 systemPrompt，layered 选项必有 cwd
    if (!('systemPrompt' in options)) {
      return this.composeLayered(options as LayeredComposeOptions);
    }
    const legacy = options as ComposeOptions;
    const systemMsg: Message = { role: 'system', content: { type: 'text', text: legacy.systemPrompt } };
    const result = await this.composeLayered({
      sessionDir: '',
      maxContextTokens: legacy.maxContextTokens,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      tools: legacy.tools,
      history: legacy.history,
      userInput: legacy.userInput,
      fullHistory: legacy.fullHistory,
    });
    return [systemMsg, ...result.messages];
  }

  private async composeLayered(options: LayeredComposeOptions): Promise<LayeredContext> {
    const budget = Math.floor(options.maxContextTokens * TruncatingContextComposer.BUDGET_RATIO);

    // 1. 组装过滤 + 历史变换（意图簇过滤等，语义与内置一致）
    const filtered = options.history.filter((m) => !isSkippableHistory(m));
    let history = options.historyTransform ? (options.historyTransform(filtered) ?? filtered) : filtered;

    // 2. 用户输入兜底：末尾若无同文本 user 消息则追加
    const tail: Message[] = [];
    const last = history[history.length - 1];
    if (options.userInput.length > 0 && !(last?.role === 'user' && messageText(last) === options.userInput)) {
      tail.push({ role: 'user', content: { type: 'text', text: options.userInput } });
    }

    // 3. 激进截断：从最旧起丢，直到总估算 ≤ 预算
    let truncated = 0;
    const totalEst = () =>
      history.reduce((acc, m) => acc + estimateMessageTokens(m), 0) +
      tail.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    while (history.length > 0 && totalEst() > budget) {
      history = history.slice(1);
      truncated += 1;
    }

    const messages = [...history, ...tail];
    const total = messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
    // O3 观察点：zoneBreakdown 键自由 —— 消费方只读 total，其余键是本实现自报
    return { messages, zoneBreakdown: { recent: total, truncated, total } };
  }
}
