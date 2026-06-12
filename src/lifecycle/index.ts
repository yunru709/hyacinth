// 生命周期管理模块统一导出

// 接口类型
export type {
  ProcessState,
  HealthCheckConfig,
  ManagedProcessConfig,
  ProcessStatus,
  LocalModelBackend,
  LocalModelConfig,
  ProcessEventCallbacks,
} from './interface.js';

// ProcessManager
export { ProcessManager } from './manager.js';

// LocalModelManager
export { LocalModelManager, pickModelForProvider } from './local-model.js';
export type { LoadedModelInfo } from './local-model.js';

// ModelRegistry
export { ModelRegistry } from '../local-model/model-registry.js';
export type { ModelEntry, ModelBackend, ModelRegisterOptions } from '../local-model/model-registry.js';

// ModelBridge
export { ModelBridge } from '../local-model/model-bridge.js';
export type { RunningModelInfo } from '../local-model/model-bridge.js';

// LocalModelModule
export { LocalModelModule } from '../local-model/index.js';

// LifecycleSupervisor
export { LifecycleSupervisor } from './supervisor.js';
export type { ManagedEntityType } from './supervisor.js';