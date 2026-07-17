// ============================================================
// MachineRunner — 状态机执行引擎
// ============================================================
//
// 包装 MachineDef，提供：
//   - 生命周期管理（activate / deactivate）
//   - 事件驱动的状态转移（advance）
//   - Guard 检查（guard 不通过 → 拒绝转移）
//   - 副作用执行（onEnter / onExit / onTransition）
//   - 有限的转移历史（最近 20 条）
//   - 结构化快照（getSnapshot — 给 bypass agent）
//   - 直接上下文突变（updateContext — 给 add_todo_step）
// ============================================================

import type {
  MachineDef,
  MachineContext,
  MachineStatus,
  MachineSnapshot,
  AdvanceResult,
} from './types.js';

/** 转移历史最大保留条数 */
const MAX_HISTORY = 20;

/** fire-and-forget 调用——吞掉所有同步/异步异常 */
function safeFire(fn: ((ctx: MachineContext) => void | Promise<void>) | undefined, ctx: MachineContext): void {
  if (!fn) return;
  try {
    const result = fn(ctx);
    // 如果返回 Promise，附加 catch 避免 unhandled rejection
    if (result instanceof Promise) {
      result.catch(() => {});
    }
  } catch {
    // 副作用失败不影响状态机运行
  }
}

export class MachineRunner {
  readonly definition: MachineDef;
  readonly context: MachineContext = {};

  currentState: string;
  status: MachineStatus = 'idle';

  private transitionHistory: Array<{
    from: string;
    to: string;
    event: string;
  }> = [];

  constructor(definition: MachineDef) {
    this.definition = definition;
    this.currentState = definition.initial;
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /** 激活状态机 */
  activate(ctx?: MachineContext): void {
    // 合并初始上下文
    if (ctx) {
      Object.assign(this.context, ctx);
    }
    this.currentState = this.definition.initial;
    this.transitionHistory = [];
    this.status = 'active';

    // 执行初始状态的 onEnter
    const initialDef = this.definition.states[this.currentState];
    safeFire(initialDef?.onEnter, this.context);
  }

  /** 停用状态机 */
  deactivate(): void {
    // 执行当前状态的 onExit
    const currentDef = this.definition.states[this.currentState];
    safeFire(currentDef?.onExit, this.context);

    this.status = 'idle';
  }

  // ── 核心：事件驱动的状态转移 ──────────────────────────────

  /**
   * 通过事件推进状态机。
   *
   * 执行流程：
   *   1. 找匹配的 TransitionDef（from 匹配 currentState，event 匹配）
   *   2. 执行 guard（若有），不通过返回 { ok: false, reason }
   *   3. 执行 onExit(currentState)
   *   4. 执行 onTransition（若有）
   *   5. 更新 currentState
   *   6. 执行 onEnter(newState)
   *   7. 记录 transitionHistory
   *   8. 如果是 terminalState → status = 'completed' → 触发 onComplete
   */
  advance(event: string): AdvanceResult {
    if (this.status !== 'active') {
      return { ok: false, reason: `Machine "${this.definition.id}" is not active (status: ${this.status}).` };
    }

    // 1. 找匹配的转移
    const transition = this.definition.transitions.find((t) => {
      const fromMatch = Array.isArray(t.from)
        ? t.from.includes(this.currentState)
        : t.from === this.currentState;
      return fromMatch && t.event === event;
    });

    if (!transition) {
      return {
        ok: false,
        reason: `Event "${event}" is not valid in state "${this.currentState}" of machine "${this.definition.id}". Available events: [${this.getAvailableEvents().join(', ')}]`,
      };
    }

    // 2. Guard 检查
    if (transition.guard) {
      const guardResult = transition.guard(this.context);
      if (!guardResult.ok) {
        return {
          ok: false,
          reason: guardResult.reason ?? `Guard rejected transition from "${this.currentState}" to "${transition.to}" via "${event}".`,
        };
      }
    }

    // 3. onExit 副作用（fire-and-forget）
    const oldState = this.currentState;
    const oldDef = this.definition.states[oldState];
    safeFire(oldDef?.onExit, this.context);

    // 4. onTransition 副作用（同步执行——可阻塞）
    transition.onTransition?.(this.context);

    // 5. 更新状态
    this.currentState = transition.to;

    // 6. onEnter 副作用（fire-and-forget）
    const newDef = this.definition.states[this.currentState];
    safeFire(newDef?.onEnter, this.context);

    // 7. 记录历史
    this.transitionHistory.push({ from: oldState, to: transition.to, event });
    if (this.transitionHistory.length > MAX_HISTORY) {
      this.transitionHistory = this.transitionHistory.slice(-MAX_HISTORY);
    }

    // 8. 终端状态检查
    const isTerminal = this.definition.terminalStates?.includes(this.currentState) ?? false;
    if (isTerminal) {
      this.status = 'completed';
      // 触发 onComplete（异步，不阻塞）
      if (this.definition.onComplete) {
        Promise.resolve(this.definition.onComplete(this.context)).catch(() => {
          // onComplete 失败不影响状态机状态
        });
      }
    }

    return { ok: true, to: transition.to, isTerminal };
  }

  // ── 查询 ──────────────────────────────────────────────────

  /** 当前状态下可触发的事件列表 */
  getAvailableEvents(): string[] {
    if (this.status !== 'active') return [];

    const events = new Set<string>();
    for (const t of this.definition.transitions) {
      const fromMatch = Array.isArray(t.from)
        ? t.from.includes(this.currentState)
        : t.from === this.currentState;
      if (fromMatch) {
        events.add(t.event);
      }
    }
    return [...events];
  }

  /** 结构化快照（给 bypass agent 读） */
  getSnapshot(): MachineSnapshot {
    const stateDef = this.definition.states[this.currentState];

    return {
      machineId: this.definition.id,
      currentState: this.currentState,
      label: stateDef?.label ?? this.currentState,
      availableEvents: this.getAvailableEvents(),
      context: this.context,
      status: this.status,
      isTerminal: this.definition.terminalStates?.includes(this.currentState) ?? false,
      history: [...this.transitionHistory],
    };
  }

  /** 是否已完成（到达终端状态） */
  isComplete(): boolean {
    return this.status === 'completed';
  }

  // ── 上下文突变（非转移操作） ──────────────────────────────

  /**
   * 直接修改 context，不触发任何状态转移。
   *
   * 用途：add_todo_step 在 planning 阶段向 context.steps 追加步骤。
   * 这不是状态转移——只是数据累积。
   */
  updateContext(patch: Partial<MachineContext>): void {
    Object.assign(this.context, patch);
  }
}
