/**
 * 内核层（Kernel）桶文件。
 *
 * 定位：最小 agent 模式所需的**生命周期、接缝与装配原语**。
 * 本层刻意不依赖任何业务模块（orchestrator / channels / companion…），
 * 只依赖 logging。后续 `verify:layers` 会把这条作为硬性检查项。
 */

export {
  DisposableStore,
  toDisposable,
  noopDisposable,
  type Disposable,
  type Disposer,
} from './types.js';

export {
  HookBus,
  type HookHandler,
  type AnyHookHandler,
  type Interceptor,
  type SeamCore,
  type HookBusOptions,
} from './hook-bus.js';

export {
  Pipeline,
  checkContract,
  createPipelineBus,
  type StageModule,
  type StageContext,
  type SlotSpec,
  type PipelineSpec,
  type PipelineOptions,
  type AssembleResult,
  type AssembledStage,
  type FieldContract,
  type ContractIssue,
} from './pipeline.js';

export {
  PluginHost,
  createHookBus,
  type HyPlugin,
  type PluginContext,
  type PluginHostOptions,
  type PluginState,
  type ServiceMap,
} from './plugin-host.js';
