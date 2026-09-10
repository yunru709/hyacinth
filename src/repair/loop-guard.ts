/**
 * LoopGuard — 统一防重复输出检测器
 *
 * 两层检测：
 *   ToolGuard — 工具调用重复检测（原 StormBreaker）
 *   TextGuard — 文本输出重复检测（新增）
 *
 * 每次用户输入时调用 reset()，同一轮内累积检测。
 */

import type { ToolCall } from '../types.js';
import { isMutatingTool } from '../tools/side-effect.js';

// ── Constants ──────────────────────────────────────────────────────────

const TOOL_WINDOW = 6;
const TOOL_THRESHOLD = 3;
const TEXT_WINDOW = 6;
const TEXT_THRESHOLD = 3;
const TEXT_MIN_LENGTH = 30;       // 短于 30 字符不检测
const TEXT_SIMILARITY = 0.90;     // Jaccard 相似度阈值（LLM 循环时输出高度一致）

const MCP_SIDE_EFFECT_KEYWORDS = new Set([
  'navigate', 'create', 'delete', 'open', 'write', 'execute',
  'run', 'start', 'launch', 'install', 'remove', 'update',
  'send', 'post', 'put', 'patch',
]);

// ── Config ─────────────────────────────────────────────────────────────

export interface LoopGuardConfig {
  /** 工具检测 */
  tool: {
    enabled: boolean;
    windowSize: number;
    threshold: number;
    /** 豁免工具名列表 */
    exemptTools: string[];
  };
  /** 文本检测 */
  text: {
    enabled: boolean;
    windowSize: number;
    threshold: number;
    minLength: number;
    similarity: number;
  };
}

export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
  tool: {
    enabled: true,
    windowSize: TOOL_WINDOW,
    threshold: TOOL_THRESHOLD,
    exemptTools: [],
  },
  text: {
    enabled: true,
    windowSize: TEXT_WINDOW,
    threshold: TEXT_THRESHOLD,
    minLength: TEXT_MIN_LENGTH,
    similarity: TEXT_SIMILARITY,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

export function isMutating(name: string): boolean {
  if (isMutatingTool(name)) return true;
  if (name.startsWith('mcp__')) {
    const toolName = name.split('__')[2];
    if (toolName) {
      const lower = toolName.toLowerCase();
      for (const kw of MCP_SIDE_EFFECT_KEYWORDS) {
        // 用词边界匹配，避免 "open" 误杀 "openFileInfo" 等只读工具
        const re = new RegExp(`(^|_)${kw}($|_)`);
        if (re.test(lower)) return true;
      }
    }
  }
  return false;
}

function argsSignature(input: Record<string, unknown>): string {
  return JSON.stringify(input, Object.keys(input).sort());
}

/**
 * 单词级 Jaccard 相似度。
 * 两个文本分词后计算交集 / 并集。
 */
function wordJaccard(a: string, b: string): number {
  const tokenize = (s: string) => {
    const tokens = s.toLowerCase().split(/[\s,.;:!?(){}\[\]"'-]+/).filter(t => t.length > 1);
    return new Set(tokens);
  };
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  const intersection = new Set([...sa].filter(x => sb.has(x)));
  const union = new Set([...sa, ...sb]);
  return intersection.size / union.size;
}

// ── TextGuard ──────────────────────────────────────────────────────────

export class TextGuard {
  private window: string[] = [];
  private streak = 0;
  private config: LoopGuardConfig['text'];

  constructor(config?: Partial<LoopGuardConfig['text']>) {
    this.config = { ...DEFAULT_LOOP_GUARD_CONFIG.text, ...config };
  }

  reset(): void {
    this.window = [];
    this.streak = 0;
  }

  /**
   * 检查一条 assistant 文本输出是否与最近输出重复。
   * 返回 true 表示检测到文本输出循环（连续超过 threshold 次高相似度）。
   */
  check(text: string): boolean {
    if (!this.config.enabled) return false;
    if (!text || text.length < this.config.minLength) return false;

    // 与窗口内已有文本对比
    let maxSim = 0;
    for (const prev of this.window) {
      // 完全一致 → 1.0
      const sim = text === prev ? 1.0 : wordJaccard(text, prev);
      maxSim = Math.max(maxSim, sim);
    }

    if (maxSim >= this.config.similarity) {
      this.streak++;
    } else {
      this.streak = 0;
    }

    // 加入窗口
    this.window.push(text);
    if (this.window.length > this.config.windowSize) {
      this.window.shift();
    }

    return this.streak >= this.config.threshold;
  }

  /** 获取反思提示词 */
  static reflectionPrompt(): string {
    return `[LoopGuard] 检测到最近的回复高度相似。你可能陷入了重复输出循环。请尝试不同的思路或询问用户。`;
  }
}

// ── ToolGuard (原 StormBreaker) ────────────────────────────────────────

export class ToolGuard {
  private window: Array<{ name: string; argsSignature: string }> = [];
  private config: LoopGuardConfig['tool'];

  constructor(config?: Partial<LoopGuardConfig['tool']>) {
    this.config = { ...DEFAULT_LOOP_GUARD_CONFIG.tool, ...config };
  }

  reset(): void {
    this.window = [];
  }

  /**
   * 检查工具调用是否应被抑制。
   * 返回被抑制的 ToolCall ID 集合。
   */
  check(calls: ToolCall[]): Set<string> {
    const suppressed = new Set<string>();

    for (const call of calls) {
      if (this.config.exemptTools.includes(call.name)) {
        this.window.push({ name: call.name, argsSignature: argsSignature(call.input) });
        continue;
      }

      if (isMutating(call.name)) {
        this.window = [];
        this.window.push({ name: call.name, argsSignature: argsSignature(call.input) });
        continue;
      }

      const sig = argsSignature(call.input);
      const existing = this.window.filter(w => w.name === call.name && w.argsSignature === sig);

      if (existing.length >= this.config.threshold - 1) {
        suppressed.add(call.id);
      } else {
        this.window.push({ name: call.name, argsSignature: sig });
        if (this.window.length > this.config.windowSize) {
          this.window.shift();
        }
      }
    }

    return suppressed;
  }

  static reflectionPrompt(call: ToolCall): string {
    // 使用 [LoopGuard] 而非 [System]，避免被 injection-filter 误杀
    return `[LoopGuard] 工具 \`${call.name}\` 被重复调用且参数相同。请考虑其他方式或询问用户。`;
  }

}

// ── LoopGuard ──────────────────────────────────────────────────────────

export type LoopGuardEvent = 'tool_storm' | 'text_loop';

export interface LoopGuardCheckResult {
  /** 触发的检测类型 */
  triggered: LoopGuardEvent[];
  /** 被抑制的工具调用 ID（tool_storm 时） */
  suppressedToolIds: Set<string>;
  /** 是否有文本循环（text_loop 时） */
  textLoopDetected: boolean;
  /** 文本循环的反思消息 */
  textReflection?: string;
  /** 被抑制的工具调用的反思消息（按 tool_use_id 索引） */
  toolReflections: Map<string, string>;
}

/**
 * LoopGuard — 统一防重复输出检测器。
 *
 * 每次用户输入时调用 reset() 清零所有计数。
 * guardCount 记录连续触发次数（工具抑制或文本循环），
 * 外部在每轮 runTurn 后检查 guardCount，超过阈值后强制 stop。
 */
export class LoopGuard {
  readonly toolGuard: ToolGuard;
  readonly textGuard: TextGuard;

  /** 连续触发次数（工具抑制 + 文本循环，取并集） */
  guardCount = 0;

  private maxTriggers: number;

  /** 是否已达到触发上限，外部应在每轮后检查并强制 stop */
  get escalated(): boolean {
    return this.guardCount >= this.maxTriggers;
  }

  constructor(config?: Partial<LoopGuardConfig & { maxTriggers?: number }>) {
    this.toolGuard = new ToolGuard(config?.tool);
    this.textGuard = new TextGuard(config?.text);
    this.maxTriggers = config?.maxTriggers ?? 5;
  }

  reset(): void {
    this.toolGuard.reset();
    this.textGuard.reset();
    this.guardCount = 0;
  }

  checkToolCalls(calls: ToolCall[]): { suppressed: Set<string>; reflections: Map<string, string> } {
    const suppressed = this.toolGuard.check(calls);
    const reflections = new Map<string, string>();
    if (suppressed.size > 0) {
      this.guardCount++;
      for (const id of suppressed) {
        const call = calls.find(c => c.id === id);
        if (call) reflections.set(id, ToolGuard.reflectionPrompt(call));
      }
    }
    return { suppressed, reflections };
  }

  checkTextOutput(text: string): { loop: boolean; reflection?: string } {
    const loop = this.textGuard.check(text);
    if (loop) {
      this.guardCount++;
    }
    return loop
      ? { loop: true, reflection: TextGuard.reflectionPrompt() }
      : { loop: false };
  }
}
