/**
 * ## DSL 模块统一导出
 *
 * parseAndCompile 是主入口：YAML 字符串 → WorkflowDefinition。
 */
export { parse } from './parser.js';
export { compileWorkflow } from './compiler.js';
export { HookRegistry, getGlobalHookRegistry, setGlobalHookRegistry } from './hooks.js';
export { loadWorkflowFile, scanWorkflowsDir, parseAndCompile } from './loader.js';
export { getBuiltinYamlPath, hasBuiltinYaml, BUILTIN_WORKFLOW_NAMES } from './builtins.js';
export type { BuiltinWorkflowName } from './builtins.js';

export type { ParseResult } from './parser.js';
export type {
  WorkflowIR,
  PhaseIR,
  InitIR,
  CompleteIR,
  RenderPersistentDef,
  RenderStepDef,
  StaticVarDef,
  StepSourceDef,
  ActionDefsIR,
  LegacySimpleStep,
  LegacyWorkflowRaw,
} from './schema.js';
export type { HookResult, HookFunction } from './hooks.js';
