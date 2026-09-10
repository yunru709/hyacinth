/**
 * 内核装配入口。
 *
 * 从 AgentLoop 构造中提取 HookBus + PluginHost + Pipeline 的创建，
 * 使其可独立测试且与业务解耦。factory.ts / AgentLoop 调用此函数获取
 * 内核三件套，不再各自组装。
 */
import { createLoopHookBus, type LoopHookBus, type LoopHooks } from './loop-hooks.js';
import { BUILTIN_STAGE_CONTRIBUTIONS } from './stage-registry.js';
import { INPUT_STAGE_ID } from './stages/input.js';
import { BYPASS_STAGE_ID } from './stages/bypass.js';
import { CONTEXT_STAGE_ID } from './stages/context.js';
import { LLM_STAGE_ID } from './stages/llm.js';
import { TOOLS_STAGE_ID } from './stages/tools.js';
import { FINALIZE_STAGE_ID } from './stages/finalize.js';
import { Pipeline, createPipelineBus, type SlotSpec } from '../kernel/pipeline.js';
import { PluginHost } from '../kernel/plugin-host.js';
import type { TurnState } from './turn-state.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import { createLogger } from '../logging/logger.js';
import type { StageServiceKey, StageServiceMap } from './stage-services.js';

const logger = createLogger('kernel');

// ─── 默认管道槽位（与 runtime/defaults.ts 的 kernel.pipeline 骨架一致）──

export const DEFAULT_PIPELINE_SLOTS: SlotSpec[] = [
  { id: 'input', impl: INPUT_STAGE_ID, enabled: true, requires: { reads: ['history', 'userInput'], writes: ['userInput'] } },
  { id: 'bypass', impl: BYPASS_STAGE_ID, enabled: true, requires: { reads: ['history', 'userInput'], writes: ['userInput', 'bypassInjections'] } },
  { id: 'context', impl: CONTEXT_STAGE_ID, enabled: true, requires: { reads: ['history', 'userInput', 'tools'], writes: ['messages', 'zoneBreakdown'] } },
  { id: 'llm', impl: LLM_STAGE_ID, enabled: true, requires: { reads: ['messages'], writes: ['streamText', 'stopReason'] } },
  { id: 'tools', impl: TOOLS_STAGE_ID, enabled: true, requires: { reads: ['toolCalls'], writes: ['toolCalled'] } },
  { id: 'finalize', impl: FINALIZE_STAGE_ID, enabled: true, requires: { reads: ['stop'], writes: ['stop', 'stopReason'] } },
];

// ─── 返回类型 ──────────────────────────────────────────────────────

export interface KernelComponents {
  /** 主循环钩子总线（10 个钩子点） */
  loopHooks: LoopHookBus;
  /** 插件宿主（挂载面 = loopHooks） */
  pluginHost: PluginHost<Record<string, unknown>, LoopHooks>;
  /** 内核管道（6 槽位，已装配 + 契约校验通过；服务键受 StageServiceMap 编译期保护） */
  pipeline: Pipeline<TurnState, Record<string, unknown>, StageServiceMap>;
}

// ─── 装配 ──────────────────────────────────────────────────────────

/**
 * 阶段模块的内核服务键（get/require 编译期受保护，见 stage-services.ts）。
 * 本模块 re-export 保持旧引用（loop.ts 等）可用；真源在 stage-services.ts。
 */
export type { StageServiceKey } from './stage-services.js';

export interface CreateKernelOptions {
  configCenter?: RuntimeConfigCenter;
  /** 外部注入的钩子总线（测试用；默认自动创建） */
  loopHooks?: LoopHookBus;
  /** 阶段模块的内核服务表（可选注入；未注入时由调用方自建并 set） */
  stageServices?: Map<StageServiceKey, unknown>;
  /**
   * 外部注入的插件宿主（统一宿主）：目录插件与内核插件共享同一 PluginHost，
   * 插件可 deps 相互依赖 + getService 互取服务。缺省内部创建（含 loopHooks）。
   * 注入宿主时其 hooks 由调用方（装配层 setHooks）设置，本函数不覆盖。
   */
  pluginHost?: PluginHost<Record<string, unknown>, LoopHooks>;
}

/**
 * 装配内核三件套：HookBus → PluginHost → Pipeline。
 *
 * 调用方拿到后直接挂到 AgentLoop 实例上即可，不再需要分别创建。
 * 契约校验在 assemble() 内完成：不满足时启动即报错（fail-fast）。
 */
export function createKernel(options: CreateKernelOptions = {}): KernelComponents {
  const { configCenter, stageServices, loopHooks: injectedHooks, pluginHost: injectedHost } = options;

  // 1. 钩子总线
  const loopHooks = injectedHooks ?? createLoopHookBus();

  // 2. 插件宿主（统一宿主：外部注入则复用 —— 目录/内核插件同宿主；
  //    空宿主零开销；mountPlugin 时才激活）
  const pluginHost = injectedHost ?? new PluginHost<Record<string, unknown>, LoopHooks>({
    hooks: loopHooks,
  });

  // 3. 管道装配（P6-3：内置阶段经 BUILTIN_STAGE_CONTRIBUTIONS + registerStageModule
  //    注册，与插件替换内置同一 API —— 硬编码 modules 数组消失，新增阶段只改注册表）
  const pipelineSlots = configCenter?.get<SlotSpec[]>('kernel.pipeline');
  const pipeline = new Pipeline<TurnState, Record<string, unknown>, StageServiceMap>({
    modules: [],
    spec: { slots: pipelineSlots ?? DEFAULT_PIPELINE_SLOTS },
    hooks: createPipelineBus(),
  });
  for (const contrib of BUILTIN_STAGE_CONTRIBUTIONS) {
    pipeline.registerStageModule(contrib.create());
  }
  pipeline.assemble(); // 契约校验：requires ⊆ 模块声明，不满足启动即报错

  // 4. pipeline 服务化：注册进插件宿主，插件可经 ctx.require('kernel.pipeline')
  //    拿到管道 → registerStageModule 运行时替换/扩展阶段（B：模块可替换）
  pluginHost.register('kernel.pipeline', pipeline as never);

  logger.info('kernel assembled', {
    hooks: loopHooks.hookNames().length,
    pipeline: pipeline.describe(),
  });

  return { loopHooks, pluginHost, pipeline };
}
