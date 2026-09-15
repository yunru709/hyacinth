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

// 全局子进程注册表 + 退出收割
export { installGlobalReaper, registerManager, unregisterManager, trackedManagerCount } from './global-registry.js';

// 子进程树强杀 + 父死自灭 watchdog
export { killProcessTreeSync, spawnWatchdog, buildWatchdogScript, WATCHDOG_MARK } from './watchdog.js';

// ModelRegistry
export { ModelRegistry } from '../local-model/model-registry.js';
export type { ModelEntry, ModelBackend, ModelRegisterOptions } from '../local-model/model-registry.js';

// ModelBridge
export { ModelBridge } from '../local-model/model-bridge.js';
export type { RunningModelInfo } from '../local-model/model-bridge.js';

// LocalModelModule
export { LocalModelModule } from '../local-model/index.js';

