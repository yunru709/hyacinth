/**
 * AutomationRule 静态校验（2026-10-30）
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么必须有"纯静态"校验
 * ────────────────────────────────────────────────────────────────────────────
 * 模型要能**设计链路**，而链路会真的去执行工具。没有校验就等于：
 *   "模型写什么就执行什么" ⇒ 一个笔误就能造成自动化破坏。
 *
 * 所以这条纪律：**先 validate，通过才落盘；校验失败一律拒绝**（不是"尽力而为"）。
 * 与 `parseToolLinks` 的宽容策略不同 —— 那里非法条目可以剔除，
 * 这里一旦有错就整份拒绝，因为少执行一步和错执行一步都可能更糟。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么用"知识注入"而不是直接 import
 * ────────────────────────────────────────────────────────────────────────────
 * 校验需要知道：有哪些 probe kind、哪些工具名、哪些 handler、哪些事件名。
 * 它们分别住在 watch / tools / orchestrator / loop 层。
 * automation 层若直接 import 会形成跨层环（谁都能被它拉进来）。
 * ⇒ 由调用方（装配层/工具层）把知识传进来，本模块只做逻辑。
 */

import type { Action, Assertion, AutomationRule, WhenSpec, Where } from './types.js';

/** 校验所需的"外部知识"（由调用方注入） */
export interface ValidationContext {
  /** 已知的 probe kind，如 ['file','http','process','port','ui_region'] */
  knownProbeKinds: readonly string[];
  /** 已知的工具名（toolRegistry 的 ids） */
  knownToolNames: readonly string[];
  /** 已知的 tool-links handler id */
  knownHandlers: readonly string[];
  /** 已知的事件名（loop 钩子 + 扩展事件源） */
  knownEvents: readonly string[];
}

export interface ValidationResult {
  /** 校验通过时的规范化规则；不通过为 undefined */
  rule?: AutomationRule;
  errors: string[];
}

/** gate 嵌套深度上限，防深层嵌套造成的栈/遍历风险 */
const MAX_GATE_DEPTH = 5;

const WHEN_KINDS = ['time', 'probe', 'event'] as const;
const SINK_KINDS = ['invoke', 'append', 'wake', 'gate', 'safety'] as const;
const SAFETY_ACTIONS = ['hold', 'stop', 'goto-safe'] as const;
const ASSERT_OPS = ['<', '<=', '>', '>=', '==', '!='] as const;
const WHERE_POLICIES = ['reuse', 'new'] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * 校验一条链路。
 *
 * @returns errors 非空即表示**不可用**（调用方必须拒绝落盘）
 */
export function validateRule(raw: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];

  if (!isObj(raw)) {
    return { errors: ['rule 必须是一个对象'] };
  }

  // ── 基础字段 ──────────────────────────────────────────────
  const id = raw.id;
  const name = raw.name;
  if (!isNonEmptyStr(id)) errors.push('缺少非空 "id"');
  if (!isNonEmptyStr(name)) errors.push('缺少非空 "name"');
  if (typeof raw.enabled !== 'boolean') errors.push('"enabled" 必须是布尔值');

  // ── when ─────────────────────────────────────────────────
  const when = validateWhen(raw.when, ctx, errors);

  // ── do（动作链）───────────────────────────────────────────
  const doRaw = raw.do;
  if (!Array.isArray(doRaw) || doRaw.length === 0) {
    errors.push('"do" 必须是非空数组（至少一个动作）');
  }
  const actions: Action[] = [];
  if (Array.isArray(doRaw)) {
    doRaw.forEach((item, i) => {
      const a = validateAction(item, ctx, errors, `do[${i}]`, 0);
      if (a) actions.push(a);
    });
  }

  // ── meta（可选）──────────────────────────────────────────
  let meta: AutomationRule['meta'];
  if (raw.meta !== undefined) {
    if (!isObj(raw.meta)) {
      errors.push('"meta" 必须是对象');
    } else {
      const m = raw.meta;
      if (m.tags !== undefined && !Array.isArray(m.tags)) errors.push('"meta.tags" 必须是数组');
      if (m.createdBy !== undefined && m.createdBy !== 'user' && m.createdBy !== 'model') {
        errors.push('"meta.createdBy" 只能是 "user" 或 "model"');
      }
      meta = {
        ...(typeof m.description === 'string' ? { description: m.description } : {}),
        ...(Array.isArray(m.tags) ? { tags: m.tags.filter(isNonEmptyStr) } : {}),
        ...(typeof m.createdAt === 'string' ? { createdAt: m.createdAt } : {}),
        ...(m.createdBy === 'user' || m.createdBy === 'model' ? { createdBy: m.createdBy } : {}),
      };
    }
  }

  if (errors.length > 0 || !when || actions.length === 0) {
    return { errors };
  }

  const rule: AutomationRule = {
    id: id as string,
    name: name as string,
    enabled: raw.enabled as boolean,
    when,
    do: actions,
    ...(meta ? { meta } : {}),
  };
  return { rule, errors: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// when
// ────────────────────────────────────────────────────────────────────────────

function validateWhen(raw: unknown, ctx: ValidationContext, errors: string[]): WhenSpec | undefined {
  if (!isObj(raw)) {
    errors.push('"when" 必须是对象');
    return undefined;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(WHEN_KINDS as readonly string[]).includes(kind)) {
    errors.push(`"when.kind" 必须是 ${WHEN_KINDS.join(' / ')} 之一`);
    return undefined;
  }

  if (kind === 'time') {
    if (!isObj(raw.schedule)) {
      errors.push('"when.schedule" 必须是对象（时间类配置）');
      return undefined;
    }
    return { kind: 'time', schedule: raw.schedule };
  }

  if (kind === 'probe') {
    const probe = raw.probe;
    if (!isObj(probe) || !isNonEmptyStr(probe.kind)) {
      errors.push('"when.probe.kind" 缺失');
      return undefined;
    }
    if (!(ctx.knownProbeKinds as readonly string[]).includes(probe.kind)) {
      errors.push(
        `未知的 probe kind "${probe.kind}"（已知: ${ctx.knownProbeKinds.join(', ')}）`,
      );
      return undefined;
    }
    if (!isObj(probe.spec)) {
      errors.push('"when.probe.spec" 必须是对象');
      return undefined;
    }
    return {
      kind: 'probe',
      probe: { kind: probe.kind, spec: probe.spec },
      ...(typeof raw.intervalMs === 'number' ? { intervalMs: raw.intervalMs } : {}),
      ...(typeof raw.cooldownMs === 'number' ? { cooldownMs: raw.cooldownMs } : {}),
      ...(typeof raw.threshold === 'number' ? { threshold: raw.threshold } : {}),
      ...(typeof raw.settleFrames === 'number' ? { settleFrames: raw.settleFrames } : {}),
    };
  }

  // kind === 'event'
  if (!isNonEmptyStr(raw.event)) {
    errors.push('"when.event" 缺失');
    return undefined;
  }
  // 允许写完整事件名（含冒号）或前缀；前缀须在事件目录里
  const hookPrefix = raw.event.split(':')[0];
  if (!(ctx.knownEvents as readonly string[]).includes(hookPrefix)) {
    errors.push(
      `未知的事件 "${raw.event}"（事件目录: ${ctx.knownEvents.join(', ')}）`,
    );
    return undefined;
  }
  return { kind: 'event', event: raw.event };
}

// ────────────────────────────────────────────────────────────────────────────
// action（递归）
// ────────────────────────────────────────────────────────────────────────────

function validateAction(
  raw: unknown,
  ctx: ValidationContext,
  errors: string[],
  where: string,
  depth: number,
): Action | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: 动作必须是对象`);
    return undefined;
  }
  const sink = raw.sink;
  if (typeof sink !== 'string' || !(SINK_KINDS as readonly string[]).includes(sink)) {
    errors.push(`${where}: 未知的 sink "${String(sink)}"（可选: ${SINK_KINDS.join(', ')}）`);
    return undefined;
  }

  if (sink === 'invoke') {
    if (!isNonEmptyStr(raw.tool)) {
      errors.push(`${where}.invoke: 缺少 "tool"`);
      return undefined;
    }
    if (!(ctx.knownToolNames as readonly string[]).includes(raw.tool)) {
      errors.push(`${where}.invoke: 工具 "${raw.tool}" 未注册`);
      return undefined;
    }
    if (raw.args !== undefined && !isObj(raw.args)) {
      errors.push(`${where}.invoke: "args" 必须是对象`);
      return undefined;
    }
    return {
      sink: 'invoke',
      tool: raw.tool,
      ...(isObj(raw.args) ? { args: raw.args } : {}),
    };
  }

  if (sink === 'append') {
    if (!isNonEmptyStr(raw.handler)) {
      errors.push(`${where}.append: 缺少 "handler"`);
      return undefined;
    }
    if (!(ctx.knownHandlers as readonly string[]).includes(raw.handler)) {
      errors.push(`${where}.append: handler "${raw.handler}" 未注册`);
      return undefined;
    }
    return { sink: 'append', handler: raw.handler };
  }

  if (sink === 'wake') {
    const w = validateWhere(raw.where, errors, `${where}.wake`);
    if (!w) return undefined;
    return {
      sink: 'wake',
      where: w,
      ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
    };
  }

  if (sink === 'gate') {
    if (depth >= MAX_GATE_DEPTH) {
      errors.push(`${where}.gate: 嵌套层级超过 ${MAX_GATE_DEPTH}，可能是循环/滥造`);
      return undefined;
    }
    const assert = validateAssertion(raw.assert, errors, `${where}.gate`);
    if (!assert) return undefined;

    const onPass = validateActionList(raw.onPass, ctx, errors, `${where}.gate.onPass`, depth + 1);
    const onFail = validateActionList(raw.onFail, ctx, errors, `${where}.gate.onFail`, depth + 1);

    // 至少要有分支之一，否则 gate 没有意义
    if (onPass === undefined && onFail === undefined) {
      errors.push(`${where}.gate: 至少需要 "onPass" 或 "onFail" 之一`);
      return undefined;
    }
    return {
      sink: 'gate',
      assert,
      ...(onPass ? { onPass } : {}),
      ...(onFail ? { onFail } : {}),
    };
  }

  // sink === 'safety'
  if (typeof raw.action !== 'string' || !(SAFETY_ACTIONS as readonly string[]).includes(raw.action)) {
    errors.push(`${where}.safety: "action" 必须是 ${SAFETY_ACTIONS.join(' / ')} 之一`);
    return undefined;
  }
  return { sink: 'safety', action: raw.action as (typeof SAFETY_ACTIONS)[number] };
}

function validateActionList(
  raw: unknown,
  ctx: ValidationContext,
  errors: string[],
  where: string,
  depth: number,
): Action[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${where}: 必须是数组`);
    return undefined;
  }
  const out: Action[] = [];
  raw.forEach((item, i) => {
    const a = validateAction(item, ctx, errors, `${where}[${i}]`, depth);
    if (a) out.push(a);
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// where / assertion
// ────────────────────────────────────────────────────────────────────────────

function validateWhere(raw: unknown, errors: string[], where: string): Where | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: "where" 必须是对象`);
    return undefined;
  }
  const policy = raw.policy;
  if (typeof policy !== 'string' || !(WHERE_POLICIES as readonly string[]).includes(policy)) {
    errors.push(`${where}: "policy" 必须是 "reuse" 或 "new"`);
    return undefined;
  }

  let target: Where['target'];
  if (raw.target !== undefined) {
    if (!isObj(raw.target)) {
      errors.push(`${where}: "target" 必须是对象`);
      return undefined;
    }
    const t = raw.target;
    if (t.channel !== undefined && !isNonEmptyStr(t.channel)) {
      errors.push(`${where}: "target.channel" 非法`);
      return undefined;
    }
    if (t.sessionId !== undefined && !isNonEmptyStr(t.sessionId)) {
      errors.push(`${where}: "target.sessionId" 非法`);
      return undefined;
    }
    if (t.mode !== undefined && !isNonEmptyStr(t.mode)) {
      errors.push(`${where}: "target.mode" 非法`);
      return undefined;
    }
    target = {
      ...(isNonEmptyStr(t.channel) ? { channel: t.channel } : {}),
      ...(isNonEmptyStr(t.sessionId) ? { sessionId: t.sessionId } : {}),
      ...(isNonEmptyStr(t.mode) ? { mode: t.mode } : {}),
    };
  }

  // reuse 必须知道"续哪个会话"，否则语义无从落地
  if (policy === 'reuse' && (!target || (!target.sessionId && !target.channel))) {
    errors.push(`${where}: policy="reuse" 时必须提供 target.sessionId 或 target.channel`);
    return undefined;
  }

  if (raw.fallback !== undefined && !Array.isArray(raw.fallback)) {
    errors.push(`${where}: "fallback" 必须是数组`);
    return undefined;
  }

  return {
    policy: policy as Where['policy'],
    ...(target ? { target } : {}),
    ...(Array.isArray(raw.fallback) ? { fallback: raw.fallback.filter(isNonEmptyStr) } : {}),
    ...(typeof raw.ttlMs === 'number' ? { ttlMs: raw.ttlMs } : {}),
  };
}

function validateAssertion(raw: unknown, errors: string[], where: string): Assertion | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: "assert" 必须是对象`);
    return undefined;
  }
  if (!isNonEmptyStr(raw.path)) {
    errors.push(`${where}: "assert.path" 缺失`);
    return undefined;
  }
  // 只允许两个命名空间，但允许**整体**（'result'/'event'）或**子字段**（'result.xxx'/'event.xxx'）。
  // 为什么允许整体：invoke 的工具结果都是**字符串**（如 "42"），没有子字段可用；若只允许 'result.'
  // 前缀，gate 就永远断言不了 invoke 的结果（`result > 阈值` 写不出来）——而"执行后断言上一步结果"
  // 正是 gate 的核心用途。runner 的 pickPath 对 'result' 直接取 scope.result，故整体断言可正常工作。
  if (
    raw.path !== 'result' &&
    raw.path !== 'event' &&
    !raw.path.startsWith('result.') &&
    !raw.path.startsWith('event.')
  ) {
    errors.push(`${where}: "assert.path" 必须是 "result"/"event" 或以 "result."/"event." 开头`);
    return undefined;
  }
  if (typeof raw.op !== 'string' || !(ASSERT_OPS as readonly string[]).includes(raw.op)) {
    errors.push(`${where}: "assert.op" 必须是 ${ASSERT_OPS.join(' / ')} 之一`);
    return undefined;
  }
  if (raw.value === undefined) {
    errors.push(`${where}: "assert.value" 缺失`);
    return undefined;
  }
  return { path: raw.path, op: raw.op as Assertion['op'], value: raw.value };
}
