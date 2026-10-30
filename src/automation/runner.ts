/**
 * AutomationRule 执行器（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 定位：把"链路数据"翻译成"动作调用"。**零 LLM**，完全确定性。
 * ────────────────────────────────────────────────────────────────────────────
 * 这是"模型设计、运行时执行"这句话的落地点：
 *   模型生成 AutomationRule（data） → 本模块按图执行（code）
 * 同一条规则，每次触发都走完全相同的路径 —— 可复现、可审计。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 与 tool-links 的关系
 * ────────────────────────────────────────────────────────────────────────────
 * tool-links 是「事件 → 单个 handler」的**扁平**映射（append/enrich/invoke）。
 * 本模块是「事件 → 有序动作链（可嵌套 gate、可分支）」的**结构化**执行。
 * 两者共用同一套底层能力（invokeTool / record），但表达力不同：
 *   - 简单联动继续用 tool-links.json（轻）
 *   - 需要多步/条件/分支的用 AutomationRule（重）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 关键语义
 * ────────────────────────────────────────────────────────────────────────────
 * 1. **顺序执行**：do 数组按序，前一步的结果可通过 `$result.*` 被后续步骤引用。
 * 2. **变量替换**：字符串值以 `$` 开头视为表达式，支持 `$event.*` / `$result.*`。
 * 3. **gate 分支**：断言通过走 onPass、不通过走 onFail —— 这是闭环的关键。
 * 4. **safety 立即执行**：不等后续步骤。急停类动作绝不能排在队尾。
 * 5. **失败策略**：默认 abort（后续步骤不再执行）—— 链路中途失败继续跑通常更危险。
 *    可通过 `RunOptions.onError = 'continue'` 改变（用于"尽力而为"的批处理）。
 */

import type { Action, Assertion, AutomationRule, Where } from './types.js';

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

/** 触发事件（与 TriggerEvent 同构，此处不 import 以保持层内自洽） */
export interface RuleEvent {
  source: string;
  name: string;
  at: number;
  payload?: unknown;
}

/** 执行器需要的外部能力（装配层注入，本模块不依赖具体实现） */
export interface RunnerContext {
  /** 机械执行：调一个已注册工具 */
  invokeTool: (tool: string, args: Record<string, unknown>) => Promise<string>;
  /** 智能执行：唤醒一个会话跑一轮模型 */
  wakeSession: (where: Where, prompt: string, event: RuleEvent) => Promise<void>;
  /** 追加信息（可选；对应 tool-links 的 append 类 handler） */
  appendText?: (handler: string, event: RuleEvent) => Promise<string>;
  /**
   * 安全动作（可选）。**实现方必须保证它能立即生效**（不排队、不等异步判定）。
   * 未注入时视为不支持 —— 会让 safety 动作记为失败（而不是静默跳过），
   * 因为"以为急停生效了其实没有"是最危险的情况。
   */
  safety?: (action: 'hold' | 'stop' | 'goto-safe') => Promise<void>;
  /** 记录单步执行结果（收敛点③；不注入则不记录） */
  record?: (step: StepResult) => void;
}

export interface StepResult {
  /** 动作类型 */
  sink: Action['sink'];
  /** invoke 的目标工具 / append 的 handler */
  target?: string;
  ok: boolean;
  durationMs: number;
  /** 执行产出（invoke 的返回值等） */
  output?: string;
  error?: string;
  /** gate 的断言结果（仅 gate 有） */
  asserted?: boolean;
}

export interface RunResult {
  ok: boolean;
  steps: StepResult[];
  /** abort 时的首个错误 */
  error?: string;
}

export interface RunOptions {
  /** 单步失败后的策略，默认 'abort' */
  onError?: 'abort' | 'continue';
}

// ────────────────────────────────────────────────────────────────────────────
// 主入口
// ────────────────────────────────────────────────────────────────────────────

/**
 * 执行一条链路。
 *
 * 注意：本函数**不抛错**（除编程错误外）。所有失败都折进 RunResult，
 * 因为调用方通常是后台事件源，抛错会拖垮采样/调度循环。
 */
export async function runRule(
  rule: AutomationRule,
  event: RuleEvent,
  ctx: RunnerContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const onError = options.onError ?? 'abort';
  const steps: StepResult[] = [];
  // 作用域：event 里 payload 展开到顶层，便于写 $event.kind；
  // result 指向"最近一次成功产出"。
  const scope: RunScope = {
    event: {
      ...(event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : {}),
      source: event.source,
      name: event.name,
      at: event.at,
    },
    result: undefined,
  };

  const failure = await runActions(rule.do, {
    event,
    ctx,
    scope,
    steps,
    depth: 0,
    onError,
  });

  const ok = failure === undefined;
  return {
    ok,
    steps,
    ...(ok ? {} : { error: failure }),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 内部实现
// ────────────────────────────────────────────────────────────────────────────

interface RunScope {
  event: Record<string, unknown>;
  result: unknown;
}

interface ExecCtx {
  event: RuleEvent;
  ctx: RunnerContext;
  scope: RunScope;
  steps: StepResult[];
  depth: number;
  /** 单步失败策略：abort（默认，链路中途失败继续跑通常更危险）/ continue（尽力而为） */
  onError: 'abort' | 'continue';
}

/**
 * 顺序执行一组动作。
 * @returns 首个错误信息（无错返回 undefined）
 */
async function runActions(actions: Action[], exec: ExecCtx): Promise<string | undefined> {
  let firstError: string | undefined;

  for (const action of actions) {
    const step = await runOne(action, exec);
    exec.steps.push(step);
    exec.ctx.record?.(step);

    if (!step.ok) {
      const msg = step.error ?? `${step.sink} 执行失败`;
      if (exec.onError === 'continue') {
        // 尽力而为：记下首个错误，继续执行后续动作（用于批处理类链路）
        if (firstError === undefined) firstError = msg;
        continue;
      }
      // 默认 abort：链路中途失败继续跑通常更危险（尤其是物理执行链）
      return msg;
    }
  }
  return firstError;
}

async function runOne(action: Action, exec: ExecCtx): Promise<StepResult> {
  const startedAt = Date.now();
  const base = (): Pick<StepResult, 'sink' | 'durationMs'> => ({
    sink: action.sink,
    durationMs: Date.now() - startedAt,
  });

  // ── invoke：机械执行 ────────────────────────────────────
  if (action.sink === 'invoke') {
    try {
      const args = resolveDeep(action.args ?? {}, exec.scope) as Record<string, unknown>;
      const output = await exec.ctx.invokeTool(action.tool, args);
      exec.scope.result = output; // 供后续 $result.* 引用
      // ⚠️ 工具可能「不抛异常但返回错误字符串」（workspace fence 拦写工作区外、write 的 read-gate
      //   拒绝、参数缺失等）。不识别就会当 ok:true 静默吞掉（T6 实测踩坑：围栏拦了但 runner 判成功）。
      //   约定：工具错误串以 "Error:"（英文）或 "错误："（中文）开头；正常成功输出不这样开头。
      if (typeof output === 'string' && /^(Error:|错误：)/.test(output)) {
        return { ...base(), target: action.tool, ok: false, error: output, output };
      }
      return { ...base(), target: action.tool, ok: true, output };
    } catch (err) {
      return { ...base(), target: action.tool, ok: false, error: (err as Error).message };
    }
  }

  // ── append：追加信息 ────────────────────────────────────
  if (action.sink === 'append') {
    if (!exec.ctx.appendText) {
      return { ...base(), target: action.handler, ok: false, error: 'appendText 未注入' };
    }
    try {
      const output = await exec.ctx.appendText(action.handler, exec.event);
      return { ...base(), target: action.handler, ok: true, output };
    } catch (err) {
      return { ...base(), target: action.handler, ok: false, error: (err as Error).message };
    }
  }

  // ── wake：智能执行 ──────────────────────────────────────
  if (action.sink === 'wake') {
    try {
      const prompt = action.prompt
        ? String(resolveDeep(action.prompt, exec.scope))
        : defaultWakePrompt(exec.event);
      await exec.ctx.wakeSession(action.where, prompt, exec.event);
      return { ...base(), target: `${action.where.policy}`, ok: true };
    } catch (err) {
      return { ...base(), target: action.where.policy, ok: false, error: (err as Error).message };
    }
  }

  // ── safety：安全动作（立即执行，不排队）────────────────
  if (action.sink === 'safety') {
    if (!exec.ctx.safety) {
      // 不静默跳过 —— "以为急停生效了其实没有"是最危险的情况
      return { ...base(), target: action.action, ok: false, error: 'safety 未注入：急停动作无法执行' };
    }
    try {
      await exec.ctx.safety(action.action);
      return { ...base(), target: action.action, ok: true };
    } catch (err) {
      return { ...base(), target: action.action, ok: false, error: (err as Error).message };
    }
  }

  // ── gate：执行后断言 → 分支 ─────────────────────────────
  const asserted = evalAssertion(action.assert, exec.scope);
  const branch = asserted ? action.onPass : action.onFail;
  const gateBase: StepResult = { ...base(), asserted, ok: true };

  if (!branch || branch.length === 0) {
    // 分支为空是合法配置（表示"这一侧什么都不做"）
    return gateBase;
  }
  if (exec.depth + 1 > 5) {
    return { ...gateBase, ok: false, error: 'gate 嵌套超过 5 层' };
  }
  const err = await runActions(branch, { ...exec, depth: exec.depth + 1 });
  if (err) return { ...gateBase, ok: false, error: err };
  return gateBase;
}

// ────────────────────────────────────────────────────────────────────────────
// 变量替换 / 断言求值
// ────────────────────────────────────────────────────────────────────────────

/**
 * 递归替换 `$` 开头的字符串。
 * 支持 `$event.xxx` / `$result.xxx`（可多级，如 `$event.payload.id`）。
 * 找不到则替换为 undefined（不抛错 —— 缺字段通常意味着这条链路设计有问题，
 * 让下游工具自己报错比在这里炸掉更清晰）。
 */
function resolveDeep(value: unknown, scope: RunScope): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('$')) return value;
    return pickPath(scope, value.slice(1));
  }
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, scope);
    }
    return out;
  }
  return value;
}

function pickPath(scope: RunScope, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * 数值断言用的宽松取数：工具结果常是「带格式字符串」（如 bash 成功返回 "42\n[Exit code: 0, 15ms]"），
 * 直接 Number() 得 NaN 会让 `result > 阈值` 永远 false（实测 T4a 因此误走 onFail）。
 * 这里先 Number()，失败再从字符串提取第一个数字（"42\n[Exit code: 0, 15ms]" → 42）。
 * 仅用于 <,<=,>,>= 数值断言；==/!= 仍走严格相等，不受影响。
 */
function toNumberLike(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const direct = Number(v);
    if (!Number.isNaN(direct)) return direct;
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return NaN;
}

function evalAssertion(a: Assertion, scope: RunScope): boolean {
  const actual = pickPath(scope, a.path);
  const expected = a.value;
  switch (a.op) {
    case '<':
      return toNumberLike(actual) < toNumberLike(expected);
    case '<=':
      return toNumberLike(actual) <= toNumberLike(expected);
    case '>':
      return toNumberLike(actual) > toNumberLike(expected);
    case '>=':
      return toNumberLike(actual) >= toNumberLike(expected);
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    default:
      return false;
  }
}

/** 未指定 prompt 时，从事件信息生成最小提示词 */
function defaultWakePrompt(event: RuleEvent): string {
  const detail = event.payload && typeof event.payload === 'object'
    ? JSON.stringify(event.payload).slice(0, 500)
    : String(event.payload ?? '');
  return [
    '[Automation Trigger]',
    `事件: ${event.source} / ${event.name}`,
    `时间: ${new Date(event.at).toISOString()}`,
    detail ? `载荷: ${detail}` : '',
    '',
    '这是你之前配置的自动化链路触发了。请根据当前情况判断是否需要行动。',
  ]
    .filter(Boolean)
    .join('\n');
}
