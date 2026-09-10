import { describe, it, expect } from 'vitest';
import { Pipeline, type StageContext, type SlotSpec, type StageModule } from '../kernel/pipeline.js';
import { PluginHost } from '../kernel/plugin-host.js';
import { createDemoOverrideContextPlugin, DEMO_OVERRIDE_CONTEXT_PLUGIN_ID, DEMO_MARKER_TEXT } from './demo-override-context.js';
import { CONTEXT_STAGE_ID } from '../orchestrator/stages/context.js';
import type { TurnState } from '../orchestrator/turn-state.js';
import type { ContextComposerLike } from '../context/interface.js';
import type { Message } from '../types.js';

// ─── 测试替身 ──────────────────────────────────────────────────────

/** mock contextComposer：compose 返回一条固定消息（重载签名用 as 断言兼容） */
function mockComposer(): ContextComposerLike {
  return {
    activeConditions: new Set<string>(),
    async compose() {
      return {
        messages: [{ role: 'assistant', content: { type: 'text', text: 'composed-by-mock' } }],
        zoneBreakdown: { total: 1 },
      };
    },
  } as unknown as ContextComposerLike;
}

/** 判定消息内容是否包含 demo marker（content 是 MessageContent 联合，解析 text 块比较） */
function hasMarker(msgs: Message[]): boolean {
  return msgs.some((m) => {
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    return blocks.some((b) => b.type === 'text' && (b as { text?: string }).text === DEMO_MARKER_TEXT);
  });
}

function makeCtx(composer: ContextComposerLike): StageContext<Record<string, unknown>> {
  return {
    iteration: 1,
    get: (k: string) => (k === 'contextComposer' ? composer : undefined),
    require: (k: string) => {
      if (k === 'contextComposer') return composer as unknown;
      if (k === 'sessionDir') return '/tmp/demo';
      if (k === 'maxContextTokens') return 200000;
      throw new Error(`no service "${k}" in test`);
    },
    config: <T = Record<string, unknown>>(): T => ({} as T),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function baseState(): TurnState {
  return {
    userInput: 'hi',
    history: [],
    historyWithoutLastUser: [],
    toolDefinitions: [],
    messages: [],
    zoneBreakdown: { total: 0 },
  } as unknown as TurnState;
}

const ctxSpec: SlotSpec[] = [{ id: 'context', impl: CONTEXT_STAGE_ID, enabled: true }];

// ─── 验收三断言 ────────────────────────────────────────────────────

describe('demo-override-context（B 验收：模块可替换）', () => {
  it('断言① 替换生效：挂插件后自定义 context 模块被调用（注入 marker）', async () => {
    const composer = mockComposer();
    // 内置 context 模块：只组装，不注入 marker
    const builtin: StageModule<TurnState, Record<string, unknown>> = {
      id: CONTEXT_STAGE_ID,
      name: 'builtin',
      reads: [],
      writes: ['messages'],
      async run(state, stageCtx) {
        const c = stageCtx.require('contextComposer') as unknown as ContextComposerLike;
        const layered = await c.compose({} as never);
        return { ...state, messages: layered.messages };
      },
    };
    const pipeline = new Pipeline<TurnState, Record<string, unknown>, Record<string, unknown>>({
      modules: [builtin],
      spec: { slots: ctxSpec },
    });

    // 插件宿主：pipeline 服务化（create-kernel 实际路径）
    const host = new PluginHost();
    host.register('kernel.pipeline', pipeline as never);
    const disposer = await host.mount(createDemoOverrideContextPlugin());

    // 替换生效：demo 模块组装 + 注入 marker
    const out = await pipeline.run(baseState(), makeCtx(composer) as never);
    expect(hasMarker(out.messages)).toBe(true);
    expect(out.zoneBreakdown.total).toBe(1);

    disposer.dispose();
    void host;
  });

  it('断言② 卸载回落内置：dispose 后恢复内置 context 模块（marker 消失）', async () => {
    const composer = mockComposer();
    const builtin: StageModule<TurnState, Record<string, unknown>> = {
      id: CONTEXT_STAGE_ID,
      name: 'builtin',
      reads: [],
      writes: ['messages'],
      async run(state, stageCtx) {
        const c = stageCtx.require('contextComposer') as unknown as ContextComposerLike;
        const layered = await c.compose({} as never);
        return { ...state, messages: layered.messages };
      },
    };
    const pipeline = new Pipeline<TurnState, Record<string, unknown>, Record<string, unknown>>({
      modules: [builtin],
      spec: { slots: ctxSpec },
    });
    const host = new PluginHost();
    host.register('kernel.pipeline', pipeline as never);
    const disposer = await host.mount(createDemoOverrideContextPlugin());

    // 替换生效时 marker 在
    const replaced = await pipeline.run(baseState(), makeCtx(composer) as never);
    expect(hasMarker(replaced.messages)).toBe(true);

    // 卸载回落：marker 消失（回到内置组装）
    await disposer.dispose();
    expect(host.isMounted(DEMO_OVERRIDE_CONTEXT_PLUGIN_ID)).toBe(false);
    const rolledBack = await pipeline.run(baseState(), makeCtx(composer) as never);
    expect(hasMarker(rolledBack.messages)).toBe(false);
  });

  it('registerStageModule 直接语义：同名替换 + dispose 恢复注册前值', async () => {
    const pipeline = new Pipeline<{ log: string[] }, Record<string, unknown>, Record<string, unknown>>({
      modules: [{ id: 'a', async run(s) { return { log: [...s.log, 'a'] }; } }],
      spec: { slots: [{ id: 's1', impl: 'a' }] },
    });
    const ctx = makeCtx(mockComposer()) as never;

    const replaced = await pipeline.run({ log: [] }, ctx);
    expect(replaced.log).toEqual(['a']);

    // 同名注册替换
    const disposer = pipeline.registerStageModule({
      id: 'a',
      async run(s) { return { log: [...s.log, 'a-demo'] }; },
    });
    const out = await pipeline.run({ log: [] }, ctx);
    expect(out.log).toEqual(['a-demo']);

    // 卸载恢复注册前值
    disposer.dispose();
    const back = await pipeline.run({ log: [] }, ctx);
    expect(back.log).toEqual(['a']);
  });
});
