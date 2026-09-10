import { createLogger } from '../logging/logger.js';
import type { Disposable } from './types.js';
import { toDisposable } from './types.js';

/**
 * 接缝总线（Seam Bus）—— 主循环横切逻辑的挂载点（重构方案 §2.3）。
 *
 * 一个「接缝（Seam）」= 模块之间的那道缝。缝上有三类挂载者：
 *
 *   观察者 on()         ── core 之前跑，可原地改 / 返回替换值，不能阻止 core
 *   拦截器 intercept()  ── 包裹 core，可短路（不调 next）、可包裹（next 前后做事）
 *   core                ── 内核模块本体，由 run() 的调用方传入
 *
 * 执行顺序：`拦截器₁( 拦截器₂( … 观察者们 → core ) )`
 *
 * 设计要点：
 * 1. **泛型 over HookMap**：总线本身不认识任何业务类型（Message / ToolCall …），
 *    具体钩子表由消费方（如 orchestrator/loop-hooks.ts）声明。
 *    这样 kernel 层零业务依赖，不产生 kernel → orchestrator 的反向依赖。
 * 2. **异常隔离**：单个挂载者抛错必须被吞掉并记录，绝不冒泡打断主循环。
 *    这条纪律来自 bypass 体系的经验——旁路 Agent 是"对话与认知之外"的角色，
 *    它的失败不应让主对话崩掉（方案 §2.2 关键决策 6）。
 * 3. **串行 await**：按注册顺序依次执行，保证"先注册先观察"的可预期顺序。
 *    刻意不做并发——横切逻辑之间常有顺序依赖（权限链先于 storm 抑制）。
 */

export type HookHandler<P, R = void> = (payload: P) => R | Promise<R>;

/**
 * 观察者/改造器：可以返回同类型的新 payload（改写），也可以不返回（纯观察）。
 * `emit()` 与 `run()` 都会用返回值替换 payload。
 */
export type AnyHookHandler<P> = HookHandler<P, P | void>;

/**
 * 拦截器（洋葱中间件）：`(payload, next) => payload`。
 * - 不调 `next()` ⇒ **短路**（如缓存命中直接返回，不进 LLM 阶段）
 * - `next()` 前后做事 ⇒ **包裹**（计时、超时兜底、重试）
 * - `next(新payload)` ⇒ **改写**后传给下一层
 */
export type Interceptor<P> = (payload: P, next: (p?: P) => Promise<P>) => Promise<P>;

/** 接缝的 core —— 内核模块本体；省略时等价于"纯通知"语义 */
export type SeamCore<P> = (payload: P) => P | Promise<P>;

export interface HookBusOptions {
  /** 总线名称，用于日志定位 */
  name?: string;
  /**
   * 挂载者异常处理器。默认记录 error 日志后继续。
   * 返回 'abort' 会中断后续挂载者并向上抛出（用于安全红线类的强约束）。
   */
  onError?: (err: unknown, hook: string) => void | 'abort';
  /**
   * 契约断言：dev 模式下校验每个挂载者的返回值形状。
   * 由上层（Pipeline 的 reads/writes 断言）注入，本总线只负责调用。
   */
  assert?: (hook: string, payload: unknown) => void;
}

interface HookEntry<P> {
  /** 注册序号，保证 FIFO 顺序 */
  seq: number;
  handler: AnyHookHandler<P> | Interceptor<P>;
  owner?: string;
}

interface Seam<P> {
  observers: Array<HookEntry<P>>;
  interceptors: Array<HookEntry<P>>;
}

export class HookBus<M extends Record<string, unknown>> {
  private seams = new Map<keyof M, Seam<never>>();
  private seq = 0;
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly busName: string;
  private readonly onError?: HookBusOptions['onError'];
  private readonly assert?: HookBusOptions['assert'];

  constructor(options: HookBusOptions = {}) {
    this.busName = options.name ?? 'hook-bus';
    this.logger = createLogger('hook-bus').child('mod', { bus: this.busName });
    this.onError = options.onError;
    this.assert = options.assert;
  }

  // ─── 注册 ────────────────────────────────────────────────────────

  /**
   * 注册观察者/改造器（core 之前执行，可返回替换 payload）。
   * 返回 disposer，只移除**这一个**订阅 —— 卸载粒度精确到单个订阅。
   */
  on<K extends keyof M>(name: K, handler: AnyHookHandler<M[K]>, owner?: string): Disposable {
    return this.push(name, 'observers', handler as unknown as AnyHookHandler<never>, owner);
  }

  /** 注册拦截器（包裹 core，可短路）。返回 disposer。 */
  intercept<K extends keyof M>(name: K, handler: Interceptor<M[K]>, owner?: string): Disposable {
    return this.push(name, 'interceptors', handler as unknown as AnyHookHandler<never>, owner);
  }

  // ─── 查询 ────────────────────────────────────────────────────────

  /** 该接缝是否有任何挂载者 —— 主循环可据此跳过昂贵的 payload 构造 */
  has<K extends keyof M>(name: K): boolean {
    const s = this.seams.get(name);
    return !!s && (s.observers.length > 0 || s.interceptors.length > 0);
  }

  /** 挂载者总数（观察者 + 拦截器），测试/诊断用 */
  count<K extends keyof M>(name: K): number {
    const s = this.seams.get(name);
    return s ? s.observers.length + s.interceptors.length : 0;
  }

  observerCount<K extends keyof M>(name: K): number {
    return this.seams.get(name)?.observers.length ?? 0;
  }

  interceptorCount<K extends keyof M>(name: K): number {
    return this.seams.get(name)?.interceptors.length ?? 0;
  }

  /** 已注册过的接缝名列表（诊断用） */
  hookNames(): Array<keyof M> {
    return [...this.seams.keys()];
  }

  // ─── 触发 ────────────────────────────────────────────────────────

  /**
   * 纯通知语义：core 为恒等函数，不关心返回值。
   * 用于「某个事件发生了」这类 AOP 广播（onTurnEnd、onStreamEvent …）。
   */
  async emit<K extends keyof M>(name: K, payload: M[K]): Promise<void> {
    await this.run(name, payload);
  }

  /**
   * 执行一个接缝：拦截器 → 观察者 → core，返回值沿洋葱反向穿出。
   *
   * @param core 内核模块本体。省略则该接缝退化为纯通知。
   */
  async run<K extends keyof M>(name: K, payload: M[K], core?: SeamCore<M[K]>): Promise<M[K]> {
    const seam = this.seams.get(name);

    // 快路径：无任何挂载者时直接跑 core，省掉洋葱开销
    if (!seam || (seam.observers.length === 0 && seam.interceptors.length === 0)) {
      return core ? await core(payload) : payload;
    }

    const runInner = async (p: M[K]): Promise<M[K]> => {
      let current = p;
      for (const entry of [...seam.observers]) {
        try {
          const next = await (entry.handler as AnyHookHandler<M[K]>)(current);
          if (next !== undefined) current = next;
        } catch (err) {
          this.handleError(err, String(name), entry.owner);
        }
      }
      this.assert?.(String(name), current);
      return core ? await core(current) : current;
    };

    const chain = (i: number) => async (p: M[K]): Promise<M[K]> => {
      if (i >= seam.interceptors.length) return runInner(p);
      const entry = seam.interceptors[i];
      const next = (np?: M[K]) => chain(i + 1)(np ?? p);
      try {
        return await (entry.handler as unknown as Interceptor<M[K]>)(p, next);
      } catch (err) {
        this.handleError(err, String(name), entry.owner);
        // 拦截器自身抛错 ⇒ 视为未拦截，继续走内层，保证主循环不被卡死
        return next();
      }
    };

    return chain(0)(payload);
  }

  /** 清空所有订阅（kernel 关闭 / 会话切换时用） */
  clear(): void {
    this.seams.clear();
  }

  // ─── 内部 ────────────────────────────────────────────────────────

  private push<K extends keyof M>(
    name: K,
    kind: 'observers' | 'interceptors',
    handler: AnyHookHandler<never>,
    owner?: string,
  ): Disposable {
    const seam = this.seams.get(name) ?? { observers: [], interceptors: [] };
    this.seams.set(name, seam);
    const entry: HookEntry<never> = { seq: this.seq++, handler, owner };
    seam[kind].push(entry);

    return toDisposable(() => {
      const current = this.seams.get(name);
      if (!current) return;
      const idx = current[kind].findIndex((e) => e.seq === entry.seq);
      if (idx >= 0) current[kind].splice(idx, 1);
      if (current.observers.length === 0 && current.interceptors.length === 0) {
        this.seams.delete(name);
      }
    });
  }

  private handleError(err: unknown, hook: string, owner?: string): void {
    if (this.onError) {
      const decision = this.onError(err, hook);
      if (decision === 'abort') throw err;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`hook "${hook}" failed — isolated, loop continues`, err instanceof Error ? err : new Error(message), {
      hook,
      ...(owner ? { owner } : {}),
    });
  }
}
