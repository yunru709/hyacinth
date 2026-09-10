import { describe, it, expect, vi } from 'vitest';
import { PluginHost, Pipeline, createPipelineBus } from './index.js';
import type { HyPlugin, PluginContext, StageModule, StageContext, SlotSpec } from './index.js';
import type { HookBus } from './hook-bus.js';

/**
 * 端到端联调：配置驱动装配 + 插件挂接缝 + 槽位短路/包裹 + 卸载回滚。
 * 这是「模块化插件化 agent」的一条完整垂直切片：
 *   config.json(kernel.pipeline) → Pipeline.assemble → 槽位执行 → 插件 intercept → 回滚
 */

interface TurnState {
  log: string[];
  messages?: string[];
  stopped?: boolean;
}

interface PipeHooks extends Record<string, unknown> {
  input: TurnState;
  context: TurnState;
  llm: TurnState;
}

interface Services extends Record<string, unknown> {
  'kernel.turnState': TurnState;
}

function ctx(iteration = 1): StageContext {
  return {
    iteration,
    get: () => undefined,
    require: () => { throw new Error('no service'); },
    config: <T = Record<string, unknown>>(): T => ({} as T),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const mk = (id: string): StageModule<TurnState> => ({
  id,
  async run(state) {
    return { ...state, log: [...state.log, id] };
  },
});

/** 内置上下文组装器：声明槽位契约（reads/writes） —— 契约真相源在代码 */
const composer = (): StageModule<TurnState> => ({
  id: 'builtin:composer',
  reads: ['log'],
  writes: ['messages'],
  async run(state) {
    return { ...state, log: [...state.log, 'builtin:composer'], messages: [] };
  },
});

const spec = (): { slots: SlotSpec[] } => ({
  slots: [
    { id: 'input', impl: 'builtin:input' },
    {
      id: 'context',
      impl: 'builtin:composer',
      requires: { reads: ['log'], writes: ['messages'] },
    },
    { id: 'llm', impl: 'builtin:llm' },
  ],
});

describe('内核垂直切片：PluginHost × Pipeline × HookBus 端到端', () => {
  it('插件通过 ctx.aroundHook 短路 context 槽位 → 整段替换上下文组装器', async () => {
    const bus = createPipelineBus<PipeHooks>();
    const host = new PluginHost<Services, PipeHooks>({ hooks: bus });
    const pipeline = new Pipeline<TurnState, PipeHooks>({
      modules: [mk('builtin:input'), composer(), mk('builtin:llm')],
      spec: spec(),
      hooks: bus,
    });

    // 插件：拦截 context 槽位，用「自己的组装器」替换内置的
    const swapper: HyPlugin<Services, PipeHooks> = {
      id: 'demo:context-swap',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        ctx.aroundHook('context', async (state) => ({
          ...state,
          log: [...state.log, 'my-composer'],
          messages: ['composed-by-plugin'],
        }));
      },
    };
    await host.mount(swapper);

    const out = await pipeline.run({ log: [] }, ctx());

    // builtin:composer 被插件整体短路，从未执行
    expect(out.log).toEqual(['builtin:input', 'my-composer', 'builtin:llm']);
    expect(out.messages).toEqual(['composed-by-plugin']);

    // 卸载插件 → 恢复内置组装器
    await host.unmount('demo:context-swap');
    const out2 = await pipeline.run({ log: [] }, ctx());
    expect(out2.log).toEqual(['builtin:input', 'builtin:composer', 'builtin:llm']);
  });

  it('插件包裹 context 槽位：内置组装器前后各插一段逻辑（不改实现）', async () => {
    const bus = createPipelineBus<PipeHooks>();
    const host = new PluginHost<Services, PipeHooks>({ hooks: bus });
    const pipeline = new Pipeline<TurnState, PipeHooks>({
      modules: [mk('builtin:input'), composer(), mk('builtin:llm')],
      spec: spec(),
      hooks: bus,
    });

    const wrapper: HyPlugin<Services, PipeHooks> = {
      id: 'demo:context-wrap',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        ctx.aroundHook('context', async (state, next) => {
          const withPre = { ...state, log: [...state.log, 'pre-composer'] };
          const result = await next(withPre);
          return { ...result, log: [...result.log, 'post-composer'] };
        });
      },
    };
    await host.mount(wrapper);

    const out = await pipeline.run({ log: [] }, ctx());

    expect(out.log).toEqual(['builtin:input', 'pre-composer', 'builtin:composer', 'post-composer', 'builtin:llm']);
  });

  it('插件可通过 ctx.require 读内核服务（Capability Seam 的 Consumer 侧）', async () => {
    const bus = createPipelineBus<PipeHooks>();
    const host = new PluginHost<Services, PipeHooks>({ hooks: bus });
    const pipeline = new Pipeline<TurnState, PipeHooks>({
      modules: [mk('builtin:input'), mk('builtin:llm')],
      spec: { slots: [{ id: 'input', impl: 'builtin:input' }, { id: 'llm', impl: 'builtin:llm' }] },
      hooks: bus,
    });

    host.register('kernel.turnState', { log: ['seeded'] });

    let consumed: TurnState | undefined;
    const consumer: HyPlugin<Services, PipeHooks> = {
      id: 'demo:consumer',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        consumed = ctx.require('kernel.turnState');
        ctx.onHook('input', (state) => ({ ...state, log: [...state.log, `seed=${consumed!.log.join(',')}`] }));
      },
    };
    await host.mount(consumer);

    const out = await pipeline.run({ log: [] }, ctx());

    expect(consumed?.log).toEqual(['seeded']);
    expect(out.log).toEqual(['seed=seeded', 'builtin:input', 'builtin:llm']);

    // 服务是宿主注册的（不是插件注册的），插件卸载不摘除它 —— 只摘除插件的钩子
    await host.unmount('demo:consumer');
    expect(host.get('kernel.turnState')).toEqual({ log: ['seeded'] });
    expect(bus.count('input')).toBe(0);
  });

  it('契约校验在插件接管前就拦截错配模块（防替换装错）', async () => {
    const bad = (): StageModule<TurnState> => ({
      id: 'builtin:composer',
      // 忘了声明 writes: ['messages']
      async run(state) {
        return { ...state, log: [...state.log, 'builtin:composer'] };
      },
    });

    const pipeline = new Pipeline<TurnState, PipeHooks>({
      modules: [mk('builtin:input'), bad(), mk('builtin:llm')],
      spec: spec(),
    });

    expect(() => pipeline.assemble()).toThrow(/要求写入 \[messages\]/);
  });

  it('总线断线自愈：拦截器抛错时管道仍跑完内置模块（插件故障不炸主循环）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createPipelineBus<PipeHooks>();
    const host = new PluginHost<Services, PipeHooks>({ hooks: bus });
    const pipeline = new Pipeline<TurnState, PipeHooks>({
      modules: [mk('builtin:input'), composer(), mk('builtin:llm')],
      spec: spec(),
      hooks: bus,
    });

    const broken: HyPlugin<Services, PipeHooks> = {
      id: 'demo:broken',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        ctx.aroundHook('context', async () => { throw new Error('plugin crashed'); });
      },
    };
    await host.mount(broken);

    const out = await pipeline.run({ log: [] }, ctx());

    expect(out.log).toEqual(['builtin:input', 'builtin:composer', 'builtin:llm']);
    spy.mockRestore();
  });
});

describe('PluginHost 能力注册（P3：registerTool / registerContextSource）', () => {
  function makeRegistries() {
    const tools: string[] = [];
    const sources: string[] = [];
    const toolRegistry = {
      register: (t: { name: string }) => { tools.push(t.name); },
      unregister: (n: string) => { const i = tools.indexOf(n); if (i >= 0) tools.splice(i, 1); return true; },
    };
    const contextComposer = {
      registerSource: (s: { name: string }) => { sources.push(s.name); },
      unregisterSource: (n: string) => { const i = sources.indexOf(n); if (i >= 0) sources.splice(i, 1); },
    };
    return { tools, sources, toolRegistry, contextComposer };
  }

  it('注册工具与 ContextSource，卸载后自动回滚', async () => {
    const { tools, sources, toolRegistry, contextComposer } = makeRegistries();
    const host = new PluginHost<Services, PipeHooks>({ toolRegistry, contextComposer });

    const plug: HyPlugin<Services, PipeHooks> = {
      id: 'demo:capabilities',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        ctx.registerTool({ name: 'kb_search', input_schema: {} } as never);
        ctx.registerTool({ name: 'kb_add', input_schema: {} } as never);
        const src = {
          name: 'kb_context',
          strategy: 'always_inline',
          cacheability: 'live',
          description: 'kb',
          getContent: async () => '',
        } as { name: string; [k: string]: unknown };
        ctx.registerContextSource(src);
      },
    };
    await host.mount(plug);
    expect(tools).toEqual(['kb_search', 'kb_add']);
    expect(sources).toEqual(['kb_context']);

    await host.unmount('demo:capabilities');
    expect(tools).toEqual([]);
    expect(sources).toEqual([]);
  });

  it('未注入 registry 时 registerTool 抛错', async () => {
    const host = new PluginHost<Services, PipeHooks>({});
    const plug: HyPlugin<Services, PipeHooks> = {
      id: 'demo:no-tools',
      activate(ctx: PluginContext<Services, PipeHooks>) {
        ctx.registerTool({ name: 'x', input_schema: {} } as never);
      },
    };
    await expect(host.mount(plug)).rejects.toThrow(/registerTool/);
  });
});
