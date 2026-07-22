// ============================================================
// Machine — 桶导出
// ============================================================

export type {
  MachineContext,
  GuardResult,
  StateDef,
  TransitionDef,
  MachineDef,
  MachineStatus,
  MachineSnapshot,
  HistoryEntry,
  AdvanceResult,
} from './types.js';

export { MachineRunner } from './runner.js';
export { MachineRegistry } from './registry.js';

// ── Flows（状态机的业务实现）───────────────────────────────

export type { FlowController } from './flows/types.js';
export { TodoFlow } from './flows/todo.js';
export { SpecFlow } from './flows/spec.js';
