import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pipeline, checkContract, createPipelineBus } from './pipeline.js';
import type { StageModule, StageContext, SlotSpec } from './pipeline.js';
import { HookBus } from './hook-bus.js';

// ─── 测试替身 ──────────────────────────────────────────────────────

/** 一个极简的 TurnState：只有 log 数组，模块通过追加来记录自己跑过 */
interface S {
  log: string[];
  n?: number;
}

function makeCtx(overrides: Partial<StageContext> = {}): StageContext {
  return {
    iteration: 1,
    get: () => undefined,
    require: () => { throw new Error('no service in test'); },
    config: <T = Record<string, unknown>>(): T => ({} as T),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

/** 生成一个"往 log 里追加自己 id"的模块 */
function mod(id: string, extra: Partial<StageModule<S>> = {}): StageModule<S> {
  return {
    id,
    async run(state) {
      return { ...state, log: [...state.log, id] };
    },
    ...extra,
  };
}

function slot(id: string, impl: string, extra: Partial<SlotSpec> = {}): SlotSpec {
  return { id, impl, ...extra };
}

// ─── 基础执行 ──────────────────────────────────────────────────────

describe('Pipeline 基础执行', () => {
  it('按配置顺序依次执行槽位', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b'), mod('c')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b'), slot('s3', 'c')] },
    });

    const out = await p.run({ log: [] }, makeCtx());

    expect(out.log).toEqual(['a', 'b', 'c']);
  });

  it('配置调序即改执行顺序（不动代码）', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'b'), slot('s2', 'a')] },
    });

    const out = await p.run({ log: [] }, makeCtx());
    expect(out.log).toEqual(['b', 'a']);
  });

  it('enabled: false 的槽位被跳过，state 原样穿过', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b', { enabled: false })] },
    });

    const out = await p.run({ log: [] }, makeCtx());
    expect(out.log).toEqual(['a']);
    expect(p.snapshot().skipped).toEqual(['s2']);
  });

  it('ctx.config() 读到的是本槽位的配置片段，不污染下一个槽位', async () => {
    const seen: unknown[] = [];
    const spy = (id: string): StageModule<S> => ({
      id,
      async run(state, ctx) { seen.push(ctx.config()); return state; },
    });

    const p = new Pipeline<S>({
      modules: [spy('a'), spy('b')],
      spec: {
        slots: [
          slot('s1', 'a', { config: { k: 1 } }),
          slot('s2', 'b', { config: { k: 2 } }),
        ],
      },
    });

    await p.run({ log: [] }, makeCtx());
    expect(seen).toEqual([{ k: 1 }, { k: 2 }]);
  });

  it('重复模块 id 直接报错（注册表污染）', () => {
    expect(
      () => new Pipeline<S>({ modules: [mod('a'), mod('a')], spec: { slots: [] } }),
    ).toThrow(/duplicate module id "a"/);
  });
});

// ─── 模块可替换（作者的核心需求） ──────────────────────────────────

describe('Pipeline 模块可替换', () => {
  const builtinComposer = mod('builtin:composer', {
    name: '内置上下文组装器',
    reads: ['history', 'userInput', 'tools'],
    writes: ['messages', 'zoneBreakdown'],
  });
  const myComposer = mod('my:composer', {
    name: '我的上下文组装器',
    reads: ['history', 'userInput', 'tools'],
    writes: ['messages', 'zoneBreakdown'],
  });

  /** 教科书场景：整段替换上下文组装器，只改配置里的 impl 一行 */
  const specWith = (impl: string): PipelineSpecShape => ({
    slots: [
      slot('input', 'builtin:input'),
      slot('context', impl, {
        requires: { reads: ['history', 'userInput'], writes: ['messages', 'zoneBreakdown'] },
      }),
      slot('llm', 'builtin:llm'),
    ],
  });

  // 仅用于类型标注
  type PipelineSpecShape = { slots: SlotSpec[] };

  it('整段替换上下文组装器：改配置 impl 即可，内核代码不动', async () => {
    const modules = [mod('builtin:input'), builtinComposer, myComposer, mod('builtin:llm')];

    const before = new Pipeline<S>({ modules, spec: specWith('builtin:composer') });
    const after = new Pipeline<S>({ modules, spec: specWith('my:composer') });

    expect((await before.run({ log: [] }, makeCtx())).log)
      .toEqual(['builtin:input', 'builtin:composer', 'builtin:llm']);
    expect((await after.run({ log: [] }, makeCtx())).log)
      .toEqual(['builtin:input', 'my:composer', 'builtin:llm']);
  });

  it('替换后的模块收到同样的输入、产出符合契约的输出', async () => {
    const fake: StageModule<S> = {
      id: 'my:composer',
      reads: ['history', 'userInput', 'tools'],
      writes: ['messages', 'zoneBreakdown'],
      async run(state, ctx) {
        // 真实替换时会在这里读 state.history 并写 state.messages
        expect(ctx.iteration).toBe(1);
        return { ...state, log: [...state.log, 'my:composer:n=' + (state.n ?? 0)] };
      },
    };
    const p = new Pipeline<S>({
      modules: [fake],
      spec: { slots: [slot('context', 'my:composer')] },
    });

    const out = await p.run({ log: [], n: 7 }, makeCtx());
    expect(out.log).toEqual(['my:composer:n=7']);
  });

  it('describe() 输出槽位→模块的绑定关系，便于诊断', () => {
    const p = new Pipeline<S>({
      modules: [builtinComposer, mod('builtin:llm')],
      spec: {
        slots: [slot('context', 'builtin:composer'), slot('llm', 'builtin:llm', { enabled: false })],
      },
    });

    expect(p.describe()).toEqual([
      { slot: 'context', impl: 'builtin:composer', enabled: true, reads: ['history', 'userInput', 'tools'], writes: ['messages', 'zoneBreakdown'] },
      { slot: 'llm', impl: 'builtin:llm', enabled: false, reads: [], writes: [] },
    ]);
  });
});

// ─── 契约校验 ──────────────────────────────────────────────────────

describe('Pipeline 契约校验', () => {
  const good = mod('good', { reads: ['a', 'b'], writes: ['c'] });

  it('满足契约时无 issue', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [slot('s', 'good', { requires: { reads: ['a'], writes: ['c'] } })] },
    });
    expect(p.assemble().issues).toEqual([]);
  });

  it('模块缺少写入契约 → missing-writes', () => {
    const issues = checkContract(
      slot('s', 'good', { requires: { writes: ['c', 'd'] } }),
      good,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('missing-writes');
    expect(issues[0].fields).toEqual(['d']);
  });

  it('模块缺少读取契约 → missing-reads', () => {
    const issues = checkContract(slot('s', 'good', { requires: { reads: ['z'] } }), good);
    expect(issues[0].kind).toBe('missing-reads');
    expect(issues[0].fields).toEqual(['z']);
  });

  it('通配契约：模块声明 a.* 覆盖槽位要求的 a.b', () => {
    const wildcard = mod('wc', { writes: ['ctx.*'] });
    expect(checkContract(slot('s', 'wc', { requires: { writes: ['ctx.messages'] } }), wildcard))
      .toEqual([]);
  });

  it('引用的模块未注册 → missing-module', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [slot('s', 'nope')] },
      strict: false,
    });
    const issues = p.assemble().issues;
    expect(issues[0].kind).toBe('missing-module');
    expect(issues[0].message).toMatch(/未注册/);
  });

  it('严格模式下契约问题直接抛错，且不产出半成品管道', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [slot('s', 'nope')] },
    });
    expect(() => p.assemble()).toThrow(/装配失败/);
  });

  it('槽位重复出现 → bad-spec', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [slot('s', 'good'), slot('s', 'good')] },
      strict: false,
    });
    expect(p.assemble().issues.some((i) => i.kind === 'bad-spec')).toBe(true);
  });

  it('槽位缺 id → bad-spec', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [{ id: '', impl: 'good' }] },
      strict: false,
    });
    expect(p.assemble().issues.some((i) => i.kind === 'bad-spec')).toBe(true);
  });

  it('被禁用的槽位不参与契约校验', () => {
    const p = new Pipeline<S>({
      modules: [good],
      spec: { slots: [slot('s', 'nope', { enabled: false })] },
    });
    expect(p.assemble().issues).toEqual([]);
  });

  it('registerStageModule 就地校验（G1）：契约满足的替换注册成功且生效，dispose 回落内置', async () => {
    const builtin = mod('ctx', {
      reads: ['history', 'userInput', 'tools'],
      writes: ['messages', 'zoneBreakdown'],
    });
    const p = new Pipeline<S>({
      modules: [builtin],
      spec: {
        slots: [slot('context', 'ctx', { requires: { reads: ['tools'], writes: ['messages'] } })],
      },
    });
    // 满足契约的替换：注册即通过（不抛），替换生效
    const disposer = p.registerStageModule({
      id: 'ctx',
      reads: ['history', 'userInput', 'tools'],
      writes: ['messages', 'zoneBreakdown'],
      async run(state) {
        return { ...state, log: [...state.log, 'ctx-replaced'] };
      },
    });
    expect((await p.run({ log: [] }, makeCtx())).log).toEqual(['ctx-replaced']);
    disposer.dispose();
    expect((await p.run({ log: [] }, makeCtx())).log).toEqual(['ctx']);
  });

  it('registerStageModule 就地校验（G1）：契约违规注册即抛，注册表不被污染', () => {
    const builtin = mod('ctx', {
      reads: ['history', 'userInput', 'tools'],
      writes: ['messages', 'zoneBreakdown'],
    });
    const p = new Pipeline<S>({
      modules: [builtin],
      spec: {
        slots: [slot('context', 'ctx', { requires: { reads: ['tools'], writes: ['messages', 'zoneBreakdown'] } })],
      },
    });
    // 缺 writes: zoneBreakdown 声明的替换模块 → 注册即抛（而不是下次 run 才炸）
    const bad = mod('ctx', { reads: ['history', 'userInput', 'tools'], writes: ['messages'] });
    expect(() => p.registerStageModule(bad)).toThrow(/注册失败/);
    // 注册表未被污染：原内置仍在，装配照常通过
    expect(() => p.snapshot()).not.toThrow();
  });

  it('registerStageModule 就地校验（G1）：strict:false 时违规不抛、注册放行，assemble 仍以 issue 暴露', async () => {
    const p = new Pipeline<S>({
      modules: [mod('ctx', { reads: ['tools'], writes: ['messages'] })],
      spec: {
        slots: [slot('context', 'ctx', { requires: { reads: ['tools'], writes: ['messages'] } })],
      },
      strict: false,
    });
    // 无 reads/writes 声明的模块：非 strict 注册放行，但装配结果如实记录 issue
    const disposer = p.registerStageModule(mod('ctx'));
    const snap = p.snapshot();
    expect(snap.issues.some((i) => i.kind === 'missing-reads')).toBe(true);
    expect(snap.issues.some((i) => i.kind === 'missing-writes')).toBe(true);
    disposer.dispose();
  });

  it('snapshot 会缓存装配结果；重新 assemble 可热更新配置', async () => {
    const spec = { slots: [slot('s1', 'a'), slot('s2', 'b')] };
    const p = new Pipeline<S>({ modules: [mod('a'), mod('b')], spec });
    expect((await p.run({ log: [] }, makeCtx())).log).toEqual(['a', 'b']);

    spec.slots.reverse();
    p.assemble();
    expect((await p.run({ log: [] }, makeCtx())).log).toEqual(['b', 'a']);
  });
});

// ─── 槽位即接缝：可被插件短路 / 包裹 ───────────────────────────────

interface PipeHooks extends Record<string, unknown> {
  context: S;
  s1: S;
  s2: S;
}

describe('Pipeline 槽位作为接缝', () => {
  let bus: HookBus<PipeHooks>;

  beforeEach(() => {
    bus = createPipelineBus<PipeHooks>();
  });

  function makePipeline(): Pipeline<S, PipeHooks> {
    return new Pipeline<S, PipeHooks>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b')] },
      hooks: bus,
    });
  }

  it('插件可 intercept 某个槽位，短路掉该模块', async () => {
    const p = makePipeline();
    bus.intercept('s1', async (state) => ({ ...state, log: [...state.log, 's1-short-circuited'] }));

    const out = await p.run({ log: [] }, makeCtx());

    expect(out.log).toEqual(['s1-short-circuited', 'b']);
  });

  it('插件可包裹槽位：模块前后各插一段逻辑', async () => {
    const p = makePipeline();
    bus.intercept('s1', async (state, next) => {
      const withPre = { ...state, log: [...state.log, 'pre-s1'] };
      const r = await next(withPre);
      return { ...r, log: [...r.log, 'post-s1'] };
    });

    const out = await p.run({ log: [] }, makeCtx());

    expect(out.log).toEqual(['pre-s1', 'a', 'post-s1', 'b']);
  });

  it('槽位上的观察者可改写传给模块的 state', async () => {
    const p = makePipeline();
    bus.on('s1', (state) => ({ ...state, log: [...state.log, 'observed'] }));

    const out = await p.run({ log: [] }, makeCtx());

    expect(out.log).toEqual(['observed', 'a', 'b']);
  });

  it('拦截器抛错时兜底执行原模块，管道不中断', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = makePipeline();
    bus.intercept('s1', async () => { throw new Error('boom'); });

    const out = await p.run({ log: [] }, makeCtx());

    expect(out.log).toEqual(['a', 'b']);
    spy.mockRestore();
  });

  it('无挂载者时走快路径，结果与不带总线一致', async () => {
    const withBus = makePipeline();
    const noBus = new Pipeline<S>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b')] },
    });

    expect(await withBus.run({ log: [] }, makeCtx())).toEqual(
      await noBus.run({ log: [] }, makeCtx()),
    );
  });
});

// ─── 阶段级执行（runSlot）───────────────────────────────────────────
// runTurn ↔ pipeline 集成修复（P0）：runSlot 只执行单个目标槽，
// 避免 run() 全链语义造成阶段重复执行（llm 每轮重复 createStream）。

describe('Pipeline runSlot 阶段级执行', () => {
  it('只执行指定槽位，其它槽不跑', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b'), mod('c')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b'), slot('s3', 'c')] },
    });

    const out = await p.runSlot('s2', { log: [] }, makeCtx());

    expect(out.log).toEqual(['b']); // 只有 s2 的模块跑了
  });

  it('连续 runSlot 按阶段顺序驱动，状态逐步累积', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b')] },
    });

    let s: S = { log: [] };
    s = await p.runSlot('s1', s, makeCtx());
    s = await p.runSlot('s2', s, makeCtx());

    expect(s.log).toEqual(['a', 'b']);
  });

  it('未知槽位 id 抛错（fail-fast，防拼错槽名静默穿透）', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a')],
      spec: { slots: [slot('s1', 'a')] },
    });

    await expect(p.runSlot('nope', { log: [] }, makeCtx())).rejects.toThrow(/nope/);
  });

  it('被禁用槽位同样报错（不可经 runSlot 绕过 enabled:false）', async () => {
    const p = new Pipeline<S>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b', { enabled: false })] },
    });

    await expect(p.runSlot('s2', { log: [] }, makeCtx())).rejects.toThrow(/s2/);
  });

  it('与 run 共享 hook 接缝：指定槽上的拦截器生效', async () => {
    const bus = createPipelineBus<{ s1: S; s2: S }>();
    const p = new Pipeline<S, { s1: S; s2: S }>({
      modules: [mod('a'), mod('b')],
      spec: { slots: [slot('s1', 'a'), slot('s2', 'b')] },
      hooks: bus,
    });
    bus.on('s1', (state) => ({ ...state, log: [...state.log, 'observed'] }));

    const out = await p.runSlot('s1', { log: [] }, makeCtx());

    expect(out.log).toEqual(['observed', 'a']);
  });
});
