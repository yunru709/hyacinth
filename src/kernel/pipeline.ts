import { createLogger } from '../logging/logger.js';
import { HookBus } from './hook-bus.js';
import type { HookBusOptions } from './hook-bus.js';
import type { Disposable } from './types.js';

/**
 * 管道（Pipeline）—— 配置驱动、模块可替换的执行链（重构方案 §2.3 + 作者补充需求）。
 *
 * ## 核心主张
 *
 * 内核由**具名槽位（Slot）**串成一条链；每个槽位填一个**模块（StageModule）**。
 * 槽位与模块的绑定关系写在**配置文件**里，所以：
 * - 「整个替换上下文组装器」= 把 `context` 槽位的 `impl` 换成另一个模块 id；
 * - 调序、禁用、插拔都只改配置，不动内核代码。
 *
 * ## 槽位契约（Slot Contract）—— 让"替换"可验证
 *
 * 模块统一签名 `(state, ctx) => state`（弱类型，换取运行时可插拔），
 * 类型系统因此管不住"这个模块到底动了哪些字段"。补偿手段是**声明式契约**：
 *
 * - 槽位声明 `requires`：要求填充者必须读/写哪些字段
 * - 模块声明 `reads / writes`：自己实际读/写哪些字段
 * - 装配时校验 `requires ⊆ 模块声明`，不通过则记为 issue 而非静默运行
 *
 * 契约的**真相源在代码**（模块自带 `reads/writes`，改代码不会忘了改配置），
 * 配置只负责**装配**（谁、什么顺序、是否启用、传什么参数）——
 * 这是 OSGi / VSCode extension 的主流分工，避免配置与代码双份漂移。
 */

// ─── 契约 ──────────────────────────────────────────────────────────

/** 字段级契约：模块/槽位读写哪些 TurnState 字段 */
export interface FieldContract {
  /** 读取的字段路径（支持 'a.b' 与 'a.*' 通配） */
  reads?: string[];
  /** 写入的字段路径（同上） */
  writes?: string[];
}

/** 契约校验问题 */
export interface ContractIssue {
  slot: string;
  module: string;
  kind: 'missing-module' | 'missing-writes' | 'missing-reads' | 'bad-spec';
  /** 缺失/冲突的字段 */
  fields?: string[];
  message: string;
}

// ─── 模块 ──────────────────────────────────────────────────────────

/**
 * 阶段执行上下文：模块能拿到的内核能力（刻意保持窄，避免模块反向依赖内核实现）。
 *
 * 泛型 `Svc` 是**服务映射表**（服务键 → 类型），由装配方（orchestrator 层）提供：
 * - 默认 `Record<string, unknown>`：退化为现状，get/require 按任意 string 键 + 显式泛型
 * - 传入具体映射（如 `StageServiceMap`）：get/require 的键与返回值均编译期受保护，
 *   拼错键或取错类型立即报错（审查报告 #1+#2 的编译期收口）
 */
export interface StageContext<Svc extends object = Record<string, unknown>> {
  /** 当前迭代序号（从 1 起） */
  iteration: number;
  /** 中断信号 */
  signal?: AbortSignal;
  /** 读取内核服务（Provider / 存储 / config-center …；缺失返回 undefined） */
  get<K extends keyof Svc & string>(key: K): Svc[K] | undefined;
  /** 读取内核服务（缺失抛错） */
  require<K extends keyof Svc & string>(key: K): Svc[K];
  /** 本槽位的配置片段 */
  config<T = Record<string, unknown>>(): T;
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, err?: Error, ctx?: Record<string, unknown>): void;
  };
}

/**
 * 管道模块 —— 唯一接口形态。
 *
 * 注意 `run` 的签名刻意是恒等的 `(S) => Promise<S>`：
 * 换来的是任意模块可替换、顺序可配置、可热插拔；
 * 丢掉的是编译期的 I/O 类型约束，用 `reads/writes` 契约 + 装配期校验补回。
 */
export interface StageModule<S = unknown, Svc extends object = Record<string, unknown>> extends FieldContract {
  /** 全局唯一模块 id（配置里 `impl` 引用的就是这个） */
  id: string;
  /** 人类可读名（诊断用） */
  name?: string;
  /** 版本号（热替换时用于判断是否需要重建） */
  version?: string;
  run(state: S, ctx: StageContext<Svc>): Promise<S>;
}

// ─── 配置驱动的装配规格 ────────────────────────────────────────────

/** 槽位规格（配置文件里的一个条目） */
export interface SlotSpec {
  /** 槽位 id：管道内的固定位置名，如 'context' */
  id: string;
  /** 填充该槽位的模块 id；改这一行就换掉了整个模块 */
  impl: string;
  /** 关闭后该槽位被跳过（state 原样穿过） */
  enabled?: boolean;
  /** 槽位要求的契约：填充者必须满足 */
  requires?: FieldContract;
  /** 传给模块的参数，通过 ctx.config() 读取 */
  config?: Record<string, unknown>;
}

/** 管道规格（配置文件中的 `kernel.pipeline`） */
export interface PipelineSpec {
  /** 执行顺序即数组顺序 */
  slots: SlotSpec[];
}

export interface PipelineOptions<M extends Record<string, unknown>> {
  /** 模块注册表：id → 模块实现 */
  modules: Iterable<StageModule<any, any>>;
  spec: PipelineSpec;
  /** 接缝总线：每个槽位在总线上的名字就是槽位 id，可被插件 intercept */
  hooks?: HookBus<M>;
  /** 严格模式：契约校验不通过时装配直接抛错（默认 true） */
  strict?: boolean;
}

export interface AssembledStage<S, Svc extends object = Record<string, unknown>> {
  slot: string;
  module: StageModule<S, Svc>;
  config: Record<string, unknown>;
}

export interface AssembleResult<S, Svc extends object = Record<string, unknown>> {
  stages: Array<AssembledStage<S, Svc>>;
  issues: ContractIssue[];
  /** 被禁用的槽位 id */
  skipped: string[];
}

export class Pipeline<S = unknown, M extends Record<string, unknown> = Record<string, unknown>, Svc extends object = Record<string, unknown>> {
  private readonly spec: PipelineSpec;
  /** 模块注册表：id → 模块实现。构造时由内置模块填满，运行时可经 registerStageModule 扩展/替换 */
  private readonly registry = new Map<string, StageModule<S, Svc>>();
  private readonly hooks?: HookBus<M>;
  private readonly strict: boolean;
  private readonly logger = createLogger('pipeline');
  private assembled: AssembleResult<S, Svc> | null = null;

  constructor(options: PipelineOptions<M>) {
    this.spec = options.spec;
    this.hooks = options.hooks;
    this.strict = options.strict !== false;
    for (const m of options.modules) {
      if (this.registry.has(m.id)) {
        throw new Error(`[pipeline] duplicate module id "${m.id}"`);
      }
      this.registry.set(m.id, m);
    }
  }

  // ─── 运行时注册（B：模块可替换） ────────────────────────────────

  /**
   * 运行时注册阶段模块 —— 可替换内置、可卸载回滚（与 PluginHost.register 同原语）。
   *
   * - **注册即契约校验**（G1）：对 spec 中引用该模块 id 的启用槽位就地跑 checkContract，
   *   strict 下违规立即抛错且不写入注册表 —— 坏插件在挂载点暴露，而非第 N 次对话崩溃；
   * - 若 id 已存在（如插件注册同名模块替换内置 `builtin:*`）：保存旧模块，
   *   dispose 时恢复 —— 「卸载回落内置」；
   * - 若 id 不存在：新增注册，dispose 时删除。
   *
   * 注册/恢复后自动失效装配缓存，下次 `snapshot()`/`run()` 重新装配生效
   * （装配从 registry 按 slot.impl 取模块，同名注册即替换生效）。
   */
  registerStageModule(mod: StageModule<S, Svc>): Disposable {
    // G1（契约时机回归修复）：注册时就地对引用本模块的启用槽位做契约校验，
    // 违规从「下次 run/snapshot 才炸（用户对话中途崩）」提前到「注册即抛」。
    // 语义与 assemble() 的 strict 行为对齐：strict 抛错且不写入注册表（无污染），
    // 非 strict 仅警告放行（后续 assemble 仍会以 issue 形式暴露）。
    const referrers = this.spec.slots.filter((s) => s.enabled !== false && s.impl === mod.id);
    const issues = referrers.flatMap((s) => checkContract(s, mod));
    if (issues.length > 0) {
      const detail = issues.map((i) => `  - [${i.kind}] ${i.slot}: ${i.message}`).join('\n');
      if (this.strict) {
        throw new Error(`[pipeline] 模块 "${mod.id}" 注册失败，共 ${issues.length} 个契约问题：\n${detail}`);
      }
      for (const i of issues) this.logger.warn(`pipeline contract issue: ${i.message}`);
    }

    const had = this.registry.has(mod.id);
    const previous = this.registry.get(mod.id);
    this.registry.set(mod.id, mod);
    this.assembled = null; // 失效缓存，下次装配用新 registry
    return {
      dispose: () => {
        if (had) this.registry.set(mod.id, previous!);
        else this.registry.delete(mod.id);
        this.assembled = null;
      },
    };
  }

  /** 读取已注册的模块（运行时可扩展查询；未注册返回 undefined） */
  getModule(id: string): StageModule<S, Svc> | undefined {
    return this.registry.get(id);
  }

  /** 已注册模块 id 列表 */
  listModules(): string[] {
    return [...this.registry.keys()];
  }

  // ─── 装配 ────────────────────────────────────────────────────────

  /**
   * 按配置装配管道并校验契约。
   * 重复调用会重新装配 —— 配置热重载后调用一次即可生效。
   */
  assemble(): AssembleResult<S, Svc> {
    const stages: Array<AssembledStage<S, Svc>> = [];
    const issues: ContractIssue[] = [];
    const skipped: string[] = [];
    const seenSlots = new Set<string>();

    for (const slot of this.spec.slots ?? []) {
      if (!slot?.id) {
        issues.push({ slot: '<anonymous>', module: '', kind: 'bad-spec', message: 'slot 缺少 id' });
        continue;
      }
      if (seenSlots.has(slot.id)) {
        issues.push({ slot: slot.id, module: slot.impl, kind: 'bad-spec', message: `槽位 "${slot.id}" 在配置中重复出现` });
        continue;
      }
      seenSlots.add(slot.id);

      if (slot.enabled === false) {
        skipped.push(slot.id);
        continue;
      }

      const mod = this.registry.get(slot.impl);
      if (!mod) {
        issues.push({
          slot: slot.id,
          module: slot.impl,
          kind: 'missing-module',
          message: `槽位 "${slot.id}" 引用的模块 "${slot.impl}" 未注册`,
        });
        continue;
      }

      issues.push(...checkContract(slot, mod));
      stages.push({ slot: slot.id, module: mod, config: slot.config ?? {} });
    }

    const result: AssembleResult<S, Svc> = { stages, issues, skipped };
    if (this.strict && issues.length > 0) {
      const detail = issues.map((i) => `  - [${i.kind}] ${i.slot}: ${i.message}`).join('\n');
      throw new Error(`[pipeline] 装配失败，共 ${issues.length} 个契约问题：\n${detail}`);
    }

    this.assembled = result;
    for (const i of issues) {
      this.logger.warn(`pipeline contract issue: ${i.message}`);
    }
    return result;
  }

  /** 读取最近一次装配结果（未装配过则先装配） */
  snapshot(): AssembleResult<S, Svc> {
    return this.assembled ?? this.assemble();
  }

  // ─── 执行 ────────────────────────────────────────────────────────

  /**
   * 跑完整条管道（= 一次迭代；while 循环在管道外，由调用方驱动）。
   *
   * 每个槽位都是总线上的一个**接缝**：插件可以 `intercept(slotId)` 短路或包裹它。
   * 槽位无挂载者时走快路径，零洋葱开销。
   */
  async run(state: S, ctx: StageContext<Svc>): Promise<S> {
    const { stages } = this.snapshot();
    let current = state;
    for (const stage of stages) {
      const core = (s: S) => stage.module.run(s, withConfig(ctx, stage.config));
      if (this.hooks) {
        current = await this.hooks.run(stage.slot as keyof M, current as M[keyof M], core as never) as unknown as S;
      } else {
        current = await core(current);
      }
    }
    return current;
  }

  /**
   * 只执行**单个槽位**（阶段级调用）。
   *
   * 调用方（如 AgentLoop.runTurn）按阶段语义逐槽驱动：每轮只跑一次目标槽，
   * 避免 `run()` 的全链语义造成阶段重复执行（如 llm 阶段每轮重复 createStream）。
   * 与 `run()` 共享同一装配快照与 hook 接缝：指定槽上的插件 intercept 照常生效。
   *
   * @throws 槽位 id 不存在或未启用时抛错（fail-fast，防拼错槽名静默穿透）
   */
  async runSlot(slotId: string, state: S, ctx: StageContext<Svc>): Promise<S> {
    const { stages } = this.snapshot();
    const stage = stages.find((s) => s.slot === slotId);
    if (!stage) {
      const available = stages.map((s) => s.slot).join(', ');
      throw new Error(
        `[pipeline] runSlot: 槽位 "${slotId}" 不存在或未启用（可用槽位: ${available || '<none>'}; 被禁用槽请先启用）`,
      );
    }
    const core = (s: S) => stage.module.run(s, withConfig(ctx, stage.config));
    if (this.hooks) {
      return await this.hooks.run(stage.slot as keyof M, state as M[keyof M], core as never) as unknown as S;
    }
    return await core(state);
  }

  /** 便于诊断：列出槽位 → 模块的绑定关系 */
  describe(): Array<{ slot: string; impl: string; enabled: boolean; reads: string[]; writes: string[] }> {
    return (this.spec.slots ?? []).map((s) => {
      const mod = this.registry.get(s.impl);
      return {
        slot: s.id,
        impl: s.impl,
        enabled: s.enabled !== false,
        reads: mod?.reads ?? [],
        writes: mod?.writes ?? [],
      };
    });
  }
}

// ─── 契约校验 ──────────────────────────────────────────────────────

/** 通配匹配：'a.*' 命中 'a.b'，'a' 精确命中 'a' */
function pathMatches(pattern: string, field: string): boolean {
  if (pattern === field) return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // 保留尾点：'a.'
    return field.startsWith(prefix);
  }
  return false;
}

function covers(declared: string[] | undefined, required: string[] | undefined): string[] {
  if (!required || required.length === 0) return [];
  const pool = declared ?? [];
  return required.filter((r) => !pool.some((d) => pathMatches(d, r)));
}

/** 校验一个模块是否满足槽位契约（requires ⊆ 模块声明） */
export function checkContract(slot: SlotSpec, mod: StageModule<any, any>): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const missingWrites = covers(mod.writes, slot.requires?.writes);
  if (missingWrites.length > 0) {
    issues.push({
      slot: slot.id,
      module: mod.id,
      kind: 'missing-writes',
      fields: missingWrites,
      message: `槽位 "${slot.id}" 要求写入 [${missingWrites.join(', ')}]，但模块 "${mod.id}" 未声明`,
    });
  }
  const missingReads = covers(mod.reads, slot.requires?.reads);
  if (missingReads.length > 0) {
    issues.push({
      slot: slot.id,
      module: mod.id,
      kind: 'missing-reads',
      fields: missingReads,
      message: `槽位 "${slot.id}" 要求读取 [${missingReads.join(', ')}]，但模块 "${mod.id}" 未声明`,
    });
  }
  return issues;
}

/** 给 ctx 套上本槽位的 config 片段（不污染后续槽位） */
function withConfig<Svc extends object>(
  ctx: StageContext<Svc>,
  config: Record<string, unknown>,
): StageContext<Svc> {
  return { ...ctx, config: <T = Record<string, unknown>>(): T => config as T } as StageContext<Svc>;
}

/** 便捷：创建管道专用接缝总线 */
export function createPipelineBus<M extends Record<string, unknown>>(options?: HookBusOptions): HookBus<M> {
  return new HookBus<M>({ name: 'pipeline', ...options });
}
