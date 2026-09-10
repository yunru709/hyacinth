/**
 * demo-override-context — 「模块可替换」的演示插件（阶段 B 验收，2026-09-01）
 *
 * 目标：证明内核管道从「构造时填满、不可变」变为「运行时可注册 + 卸载回滚」。
 * 本插件在 activate 时注册一个**同名**（builtin:layered-composer）的 context 阶段
 * 模块替换内置实现，卸载时经 Disposable 回滚到内置 —— 验收三断言：
 *   ① 替换生效：自定义模块被调用（注入 demo marker 消息）
 *   ② 卸载回落内置：marker 消失
 *   ③ 全量测试绿
 *
 * 关键路径：create-kernel 把 pipeline 注册为 'kernel.pipeline' 服务 →
 * 插件 ctx.require('kernel.pipeline') 拿到管道 → registerStageModule(mod) →
 * ctx.add(disposer)（插件卸载自动回滚）。
 *
 * 自定义模块复用内核 contextComposer 服务（ContextComposerLike，B 收窄后的最小接口）
 * 组装上下文，不复制内置 400 行逻辑 —— 演示「换实现不换能力」。
 */
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { Pipeline, StageModule } from '../kernel/pipeline.js';
import type { StageContext } from '../kernel/pipeline.js';
import type { TurnState } from '../orchestrator/turn-state.js';
import type { ContextComposerLike } from '../context/interface.js';
import { CONTEXT_STAGE_ID } from '../orchestrator/stages/context.js';
import type { Message } from '../types.js';

export const DEMO_OVERRIDE_CONTEXT_PLUGIN_ID = 'demo-override-context';

/** 替换生效的可观测 marker 消息（demo 模块注入；断言「替换生效」） */
export const DEMO_MARKER_TEXT = '[demo-override-context]';

type KernelPipeline = Pipeline<TurnState, Record<string, unknown>, Record<string, unknown>>;
type KernelStageCtx = StageContext<Record<string, unknown>>;

/** 构建自定义 context 模块：复用 contextComposer 组装 + 注入 marker 消息 */
function buildDemoContextModule(): StageModule<TurnState, Record<string, unknown>> {
  return {
    id: CONTEXT_STAGE_ID, // 同名替换内置 builtin:layered-composer
    name: 'demo-override-context',
    reads: ['history', 'userInput', 'toolDefinitions'],
    writes: ['messages', 'zoneBreakdown'],
    async run(state: TurnState, stageCtx: KernelStageCtx): Promise<TurnState> {
      const composer = stageCtx.require('contextComposer') as unknown as ContextComposerLike;
      const layered = await composer.compose({
        sessionDir: stageCtx.require('sessionDir') as unknown as string,
        maxContextTokens: stageCtx.require('maxContextTokens') as unknown as number,
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        tools: state.toolDefinitions,
        history: state.history,
        userInput: state.userInput,
      });
      // 注入可观测 marker：替换生效断言用（内置 context 模块不注入）
      const marker: Message = { role: 'user', content: { type: 'text', text: DEMO_MARKER_TEXT } };
      return { ...state, messages: [...layered.messages, marker], zoneBreakdown: layered.zoneBreakdown };
    },
  };
}

/** 创建 demo-override-context 插件（挂载即替换内置 context 阶段，卸载即回落） */
export function createDemoOverrideContextPlugin(): HyPlugin {
  return {
    id: DEMO_OVERRIDE_CONTEXT_PLUGIN_ID,
    activate(ctx: PluginContext) {
      const pipeline = ctx.require('kernel.pipeline') as unknown as KernelPipeline;
      const disposer = pipeline.registerStageModule(buildDemoContextModule());
      ctx.add(disposer);
      ctx.logger.info('demo-override-context mounted：替换内置 context 阶段（builtin:layered-composer）');
    },
  };
}
