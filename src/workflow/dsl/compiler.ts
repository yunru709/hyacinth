/**
 * ## DSL 编译器 — WorkflowIR → WorkflowDefinition
 *
 * 核心编译逻辑：将声明式 IR 编译为可执行的 WorkflowDefinition 实例。
 *
 * 设计约束：
 *   - 所有文件 I/O 包裹 try/catch，失败返回 null 或空字符串（不崩溃）
 *   - loadPrompt 包裹 try/catch，失败返回占位错误消息
 *   - 步骤索引：action.id 是 1-based，调用 markStepInFile 时转为 0-based
 *   - 状态更新：单次对象展开，保证原子性
 *   - phase 位置由 init.phaseField 控制（state / data / both）
 *
 * 新增编译能力：
 *   在 compileCreateState / compileHandleStep / compileRender 等函数中添加 case
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WorkflowDefinition, WorkflowState, WorkflowStep } from '../types.js';
import { loadPrompt, renderPrompt } from '../../prompts/loader.js';
import {
  parseSimpleSteps,
  parseTaskSections,
  flattenSections,
  markStepInFile,
  buildWfSteps,
  buildWfStepsFromFlat,
  findInProgressId,
  allStepsDone,
  renderProgress,
} from '../shared/file-steps.js';
import { getGlobalHookRegistry } from './hooks.js';
import type {
  WorkflowIR,
  PhaseIR,
  InitIR,
  CompleteIR,
  StaticVarDef,
  StepSourceDef,
  ActionDoneDef,
  ActionBlockedDef,
  ActionAddDef,
  ActionCompleteDef,
  RenderPersistentDef,
  RenderStepDef,
} from './schema.js';

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export function compileWorkflow(ir: WorkflowIR): WorkflowDefinition {
  return {
    name: ir.name,
    description: ir.description,
    source: 'file',
    relatedTools: ir.relatedTools,
    triggerKeywords: ir.triggerKeywords,

    createState: compileCreateState(ir),
    handleStep: compileHandleStep(ir),
    renderForInjection: compileRenderForInjection(ir),
    renderPersistent: compileRenderPersistent(ir),
    renderStep: compileRenderStep(ir),
    isComplete: compileIsComplete(ir),
    onDeactivate: ir.onDeactivate !== 'none' ? () => {} : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Variable Substitution
// ═══════════════════════════════════════════════════════════════════════════

/** 在字符串中替换 {var} 占位符 */
function sub(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

/** 从文件名生成 slug */
function slugify(text: string, maxLen = 60, fallback = 'default'): string {
  const s = String(text)
    .replace(/[^a-zA-Z0-9一-鿿㐀-䶿_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
  return s || fallback;
}

/** 解析静态变量为实际值 */
function resolveStaticVar(def: StaticVarDef, allVars: Record<string, string>): string {
  switch (def.compute) {
    case 'slug': {
      const source = sub(def.from ?? '', allVars);
      return slugify(source, def.maxLen, def.fallback);
    }
    case 'path': {
      const joined = def.segments.map(s => sub(s, allVars)).join('/');
      const resolved = joined.replace(/^~/, os.homedir());
      if (def.mkdir) {
        try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* ignore */ }
      }
      return resolved;
    }
    case 'literal':
      return String(def.value ?? '');
  }
}

/** 展开 path 模板中的 ~ 和 {var} */
function expandPath(template: string, staticVars: Record<string, string>): string {
  let result = sub(template, staticVars);
  if (result.startsWith('~')) result = os.homedir() + result.slice(1);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase Helpers
// ═══════════════════════════════════════════════════════════════════════════

function readPhase(state: WorkflowState, init: InitIR): string | undefined {
  if (init.phaseField === 'data') return state.data.phase as string | undefined;
  if (init.phaseField === 'state') return state.phase;
  // both: prefer state.phase, fallback to data.phase
  return state.phase || (state.data.phase as string | undefined);
}

function writePhase(newState: Record<string, unknown>, data: Record<string, unknown>, phase: string, init: InitIR): void {
  if (init.phaseField === 'state' || init.phaseField === 'both') {
    newState.phase = phase;
  }
  if (init.phaseField === 'data' || init.phaseField === 'both') {
    data.phase = phase;
  }
}

function getPhase(phases: PhaseIR[], name: string): PhaseIR | undefined {
  return phases.find(p => p.name === name);
}

/** 解析文件的步骤为基础 ParsedStep[]（根据 format） */
function parseFileSteps(filePath: string, format: 'flat' | 'sectioned'): { done: boolean }[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (format === 'sectioned') {
      return flattenSections(parseTaskSections(content)).map(f => ({ done: f.step.done }));
    }
    return parseSimpleSteps(content).map(s => ({ done: s.done }));
  } catch {
    return [];
  }
}

/** 从步骤源构建 WorkflowStep[] */
function buildStepsFromSource(
  source: StepSourceDef,
  staticVars: Record<string, string>,
  existingInProgress?: number,
  stepNameTemplate?: string,
): { steps: WorkflowStep[]; parsedCount: number } {
  if (source.type === 'memory') {
    // Memory source: steps are in state.data, compiler accesses via state
    return { steps: [], parsedCount: 0 };
  }
  if (source.type === 'none') {
    return { steps: [], parsedCount: 0 };
  }

  // File source
  const filePath = expandPath(source.path, staticVars);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');

    if (source.format === 'sectioned') {
      const sections = parseTaskSections(content);
      const flat = flattenSections(sections);
      if (flat.length === 0) return { steps: [], parsedCount: 0 };
      // Apply step naming template
      const effTemplate = stepNameTemplate || '[{section}] {text}';
      const namedFlat = flat.map(f => ({
        ...f,
        step: {
          ...f.step,
          text: effTemplate.replace('{section}', f.section).replace('{text}', f.step.text),
        },
      }));
      return { steps: buildWfStepsFromFlat(namedFlat, existingInProgress), parsedCount: flat.length };
    }

    const parsed = parseSimpleSteps(content);
    if (parsed.length === 0) return { steps: [], parsedCount: 0 };
    return { steps: buildWfSteps(parsed, existingInProgress), parsedCount: parsed.length };
  } catch {
    return { steps: [], parsedCount: 0 };
  }
}

/** 从当前 state 构建 memory 步骤的 WorkflowStep[] */
function buildMemorySteps(state: WorkflowState, source: StepSourceDef): WorkflowStep[] {
  if (source.type !== 'memory') return [];
  const field = source.field || 'steps';
  const arr = (state.data[field] as unknown[]) || [];
  return arr.map((item: unknown, idx: number) => {
    const s = item as Record<string, unknown>;
    return {
      id: (s.id as number) ?? idx + 1,
      name: (s.name as string) || (s.description as string) || `Step ${idx + 1}`,
      description: (s.description as string) || (s.name as string) || '',
      status: (s.status as WorkflowStep['status']) || 'pending',
      reason: s.reason as string | undefined,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// createState Compiler
// ═══════════════════════════════════════════════════════════════════════════

function compileCreateState(ir: WorkflowIR): (params: Record<string, unknown>) => WorkflowState {
  return (params: Record<string, unknown>) => {
    // 1. Resolve static vars (order matters: task → slug → workDir)
    const staticVars: Record<string, string> = {};
    staticVars.name = ir.name;

    // 1a. taskFrom shortcut
    if (ir.init.taskFrom) {
      const paramKey = ir.init.taskFrom.startsWith('params.')
        ? ir.init.taskFrom.slice('params.'.length)
        : ir.init.taskFrom;
      staticVars.task = String(params[paramKey] ?? '');
    }

    // 1b. Explicit staticVars (slug etc.) — must resolve before workDir
    for (const [key, def] of Object.entries(ir.init.staticVars)) {
      staticVars[key] = resolveStaticVar(def, staticVars);
    }

    // 1c. workDir shortcut — now {slug} is resolved
    if (ir.init.workDir) {
      const wd = ir.init.workDir;
      const segments = wd.segments.map(s => sub(s, staticVars));
      const joined = segments.join('/');
      const resolved = joined.replace(/^~/, os.homedir());
      try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* ignore */ }
      staticVars.workDir = resolved;
    }

    // 2. Build data object
    const dataObj: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(ir.init.data)) {
      dataObj[key] = def.default;
    }

    // 3. Determine initial phase
    let initialPhase = ir.phases[0]?.name || '';
    let steps: WorkflowStep[] = [];

    for (const phase of ir.phases) {
      if (phase.skipIf) {
        try {
          const fp = expandPath(phase.skipIf.file, staticVars);
          let shouldSkip = false;
          switch (phase.skipIf.condition) {
            case 'exists':
              shouldSkip = fs.existsSync(fp);
              break;
            case 'non-empty':
              shouldSkip = fs.existsSync(fp) && fs.readFileSync(fp, 'utf-8').trim().length > 0;
              break;
            case 'has-checkboxes':
              if (fs.existsSync(fp)) {
                const parsed = parseSimpleSteps(fs.readFileSync(fp, 'utf-8'));
                shouldSkip = parsed.length > 0;
              }
              break;
          }
          if (shouldSkip) {
            initialPhase = phase.skipIf.thenPhase;
            continue; // skip this phase
          }
        } catch { /* skip check failed → stay in this phase */ }
      }
      // First non-skipped phase = initial
      initialPhase = phase.name;
      break;
    }

    // 4. Initialize steps for the initial phase
    const initPhaseDef = getPhase(ir.phases, initialPhase);
    if (initPhaseDef && initPhaseDef.stepSource.type !== 'none') {
      const built = buildStepsFromSource(initPhaseDef.stepSource, staticVars);
      steps = built.steps;
    }

    // 5. Write phase
    const state: WorkflowState = {
      name: ir.name,
      data: dataObj,
      steps,
      startedAt: new Date().toISOString(),
    };

    // Store static vars in data for render-time use
    state.data._staticVars = staticVars;

    writePhase(state as unknown as Record<string, unknown>, dataObj, initialPhase, ir.init);

    return state;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// handleStep Compiler
// ═══════════════════════════════════════════════════════════════════════════

function compileHandleStep(ir: WorkflowIR): WorkflowDefinition['handleStep'] {
  return (state, action) => {
    const currentPhaseName = readPhase(state, ir.init);
    if (!currentPhaseName) return null;

    const phaseDef = getPhase(ir.phases, currentPhaseName);
    if (!phaseDef) return null;

    // Action whitelist check
    if (!phaseDef.actions.includes(action.action)) return null;

    const staticVars = (state.data._staticVars as Record<string, string>) || {};

    switch (action.action) {
      case 'done':
        return handleDone(state, phaseDef, action.id!, staticVars, ir);
      case 'blocked':
        return handleBlocked(state, phaseDef, action.id!, staticVars, action.message, ir);
      case 'add':
        return handleAdd(state, phaseDef, staticVars, action.description, ir);
      case 'note':
      case 'progress':
        return handleNoteProgress(state, phaseDef, action.action, action.message, ir);
      case 'complete':
        return handleComplete(state, phaseDef, staticVars, ir);
      default:
        return null;
    }
  };
}

function handleDone(
  state: WorkflowState, phaseDef: PhaseIR, stepId: number,
  staticVars: Record<string, string>, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  const def = phaseDef.onAction.done;
  if (!def) return null;

  const newData = { ...state.data } as Record<string, unknown>;
  let newSteps: WorkflowStep[];

  if (def.source === 'file' && phaseDef.stepSource.type === 'file') {
    const filePath = expandPath(phaseDef.stepSource.path, staticVars);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const newContent = markStepInFile(content, stepId - 1, 'x'); // 1-based → 0-based
      fs.writeFileSync(filePath, newContent, 'utf-8');
      // Rebuild steps
      const built = buildStepsFromSource(phaseDef.stepSource, staticVars, undefined, phaseDef.stepNameTemplate);
      newSteps = built.steps;
    } catch {
      return null;
    }
  } else if (def.source === 'memory' && phaseDef.stepSource.type === 'memory') {
    const field = phaseDef.stepSource.field || 'steps';
    const arr = (newData[field] as unknown[]) || [];
    const idx = arr.findIndex((s: unknown) => (s as Record<string, unknown>).id === stepId);
    if (idx === -1) return null;
    const item = { ...(arr[idx] as Record<string, unknown>) };
    item.status = 'completed';
    arr[idx] = item;
    newData[field] = arr;
    newSteps = buildMemorySteps({ ...state, data: newData }, phaseDef.stepSource);
    // Auto-advance
    if (def.autoAdvance !== false) {
      autoAdvanceMemorySteps(arr);
    }
  } else {
    return null;
  }

  const newState: WorkflowState = { ...state, data: newData as Record<string, unknown>, steps: newSteps };

  // Auto-transition check
  const autoResult = checkAutoTransition(newState, phaseDef, newSteps, staticVars, ir);
  if (autoResult) return autoResult;

  const completed = newSteps.filter(s => s.status === 'completed').length;
  const blocked = newSteps.filter(s => s.status === 'blocked').length;
  const total = newSteps.length;
  const allDone = total > 0 && allStepsDone(newSteps.map(s => ({ done: s.status === 'completed' })));

  return {
    newState,
    result: {
      workflow: ir.name,
      phase: readPhase(newState, ir.init),
      progress: renderProgress(completed, total, blocked),
      allDone,
      nextStep: newSteps.find(s => s.status === 'pending' || s.status === 'in_progress'),
    },
  };
}

function handleBlocked(
  state: WorkflowState, phaseDef: PhaseIR, stepId: number,
  staticVars: Record<string, string>, message: string | undefined, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  const def = phaseDef.onAction.blocked;
  if (!def) return null;

  const newData = { ...state.data } as Record<string, unknown>;
  let newSteps: WorkflowStep[];

  if (def.source === 'file' && phaseDef.stepSource.type === 'file') {
    const filePath = expandPath(phaseDef.stepSource.path, staticVars);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const newContent = markStepInFile(content, stepId - 1, '🚫', message);
      fs.writeFileSync(filePath, newContent, 'utf-8');
      const built = buildStepsFromSource(phaseDef.stepSource, staticVars, undefined, phaseDef.stepNameTemplate);
      newSteps = built.steps;
    } catch {
      return null;
    }
  } else if (def.source === 'memory' && phaseDef.stepSource.type === 'memory') {
    const field = phaseDef.stepSource.field || 'steps';
    const arr = (newData[field] as unknown[]) || [];
    const idx = arr.findIndex((s: unknown) => (s as Record<string, unknown>).id === stepId);
    if (idx === -1) return null;
    const item = { ...(arr[idx] as Record<string, unknown>) };
    item.status = 'blocked';
    item.reason = message;
    arr[idx] = item;
    newData[field] = arr;
    newSteps = buildMemorySteps({ ...state, data: newData }, phaseDef.stepSource);
    if (def.autoAdvance !== false) {
      autoAdvanceMemorySteps(arr);
    }
  } else {
    return null;
  }

  const newState: WorkflowState = { ...state, data: newData as Record<string, unknown>, steps: newSteps };

  const autoResult = checkAutoTransition(newState, phaseDef, newSteps, staticVars, ir);
  if (autoResult) return autoResult;

  const completed = newSteps.filter(s => s.status === 'completed').length;
  const blocked = newSteps.filter(s => s.status === 'blocked').length;
  const total = newSteps.length;
  const allDone = total > 0 && allStepsDone(newSteps.map(s => ({ done: s.status === 'completed' })));

  return {
    newState,
    result: {
      workflow: ir.name,
      phase: readPhase(newState, ir.init),
      progress: renderProgress(completed, total, blocked),
      allDone,
      nextStep: newSteps.find(s => s.status === 'pending' || s.status === 'in_progress'),
    },
  };
}

function handleAdd(
  state: WorkflowState, phaseDef: PhaseIR,
  staticVars: Record<string, string>, description: string | undefined, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  const def = phaseDef.onAction.add;
  if (!def) return null;

  const newData = { ...state.data } as Record<string, unknown>;
  let newSteps: WorkflowStep[];

  if (def.source === 'file' && phaseDef.stepSource.type === 'file') {
    const filePath = expandPath(phaseDef.stepSource.path, staticVars);
    try {
      let content = '';
      try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* file may not exist yet */ }
      const line = description ? `- [ ] ${description}` : '- [ ] New step';
      const newContent = content ? content + '\n' + line : line;
      fs.writeFileSync(filePath, newContent, 'utf-8');
      // Preserve existing in_progress
      const inProgressIdx = findInProgressId(state.steps);
      const existingInProgress = inProgressIdx >= 0 ? inProgressIdx : undefined;
      const built = buildStepsFromSource(phaseDef.stepSource, staticVars, existingInProgress, phaseDef.stepNameTemplate);
      newSteps = built.steps;
    } catch {
      return null;
    }
  } else if (def.source === 'memory' && phaseDef.stepSource.type === 'memory') {
    const field = phaseDef.stepSource.field || 'steps';
    const arr = (newData[field] as unknown[]) || [];
    const newId = arr.length > 0 ? Math.max(...arr.map((s: unknown) => (s as Record<string, unknown>).id as number || 0)) + 1 : 1;
    arr.push({
      id: newId,
      name: description || `Step ${newId}`,
      description: description || `Step ${newId}`,
      status: 'pending',
    });
    newData[field] = arr;
    newSteps = buildMemorySteps({ ...state, data: newData }, phaseDef.stepSource);
    // Activate first step if none in_progress
    const hasInProgress = newSteps.some(s => s.status === 'in_progress');
    if (!hasInProgress) {
      const firstPending = arr.find((s: unknown) => (s as Record<string, unknown>).status === 'pending') as Record<string, unknown> | undefined;
      if (firstPending) firstPending.status = 'in_progress';
      newSteps = buildMemorySteps({ ...state, data: newData }, phaseDef.stepSource);
    }
  } else {
    return null;
  }

  const newState: WorkflowState = { ...state, data: newData as Record<string, unknown>, steps: newSteps };

  const completed = newSteps.filter(s => s.status === 'completed').length;
  const blocked = newSteps.filter(s => s.status === 'blocked').length;
  const total = newSteps.length;

  return {
    newState,
    result: {
      workflow: ir.name,
      phase: readPhase(newState, ir.init),
      progress: renderProgress(completed, total, blocked),
      allDone: false,
      nextStep: newSteps.find(s => s.status === 'pending' || s.status === 'in_progress'),
    },
  };
}

function handleNoteProgress(
  state: WorkflowState, phaseDef: PhaseIR,
  actionType: string, message: string | undefined, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  const def = actionType === 'note' ? phaseDef.onAction.note : phaseDef.onAction.progress;
  if (!def) return null;

  const newData = { ...state.data } as Record<string, unknown>;
  const msg = message || (actionType === 'note' ? 'Noted.' : 'Progress updated.');

  if (def.appendToData) {
    const existing = (newData[def.appendToData] as string) || '';
    newData[def.appendToData] = existing ? existing + '\n' + msg : msg;
  }
  if (def.appendToDataArray) {
    const arr = (newData[def.appendToDataArray] as string[]) || [];
    arr.push(msg);
    newData[def.appendToDataArray] = arr;
  }

  const newState: WorkflowState = { ...state, data: newData as Record<string, unknown> };

  return {
    newState,
    result: {
      workflow: ir.name,
      phase: readPhase(newState, ir.init),
      progress: msg,
      allDone: false,
    },
  };
}

function handleComplete(
  state: WorkflowState, phaseDef: PhaseIR,
  staticVars: Record<string, string>, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  const def = phaseDef.onAction.complete;
  if (!def) return null;

  const newData = { ...state.data } as Record<string, unknown>;

  // Run validations
  if (def.validate) {
    for (const v of def.validate) {
      let passed = false;
      if (v.type === 'file' && v.path) {
        const fp = expandPath(v.path, staticVars);
        try {
          switch (v.condition) {
            case 'exists':
              passed = fs.existsSync(fp);
              break;
            case 'non-empty':
              passed = fs.existsSync(fp) && fs.readFileSync(fp, 'utf-8').trim().length > 0;
              break;
            case 'has-checkboxes':
              if (fs.existsSync(fp)) {
                passed = parseSimpleSteps(fs.readFileSync(fp, 'utf-8')).length > 0;
              }
              break;
            case 'all-done':
              if (fs.existsSync(fp)) {
                passed = allStepsDone(parseSimpleSteps(fs.readFileSync(fp, 'utf-8')).map(s => ({ done: s.done })));
              }
              break;
          }
        } catch { passed = false; }
      } else if (v.type === 'data' && v.field) {
        const val = newData[v.field];
        if (v.condition === 'non-empty') {
          passed = Array.isArray(val) ? val.length > 0 : !!val;
        } else if (v.condition === 'all-done' && Array.isArray(val)) {
          passed = val.every((s: unknown) => (s as Record<string, unknown>).status === 'completed');
        }
      }
      if (!passed) {
        return {
          newState: state,
          result: {
            workflow: ir.name,
            phase: readPhase(state, ir.init),
            progress: v.message,
            allDone: false,
          },
        };
      }
    }
  }

  // Run hook if specified
  if (def.hook) {
    const hookRegistry = getGlobalHookRegistry();
    const hookResult = hookRegistry.invoke(def.hook, state, []);
    if (!hookResult.success) {
      return {
        newState: state,
        result: {
          workflow: ir.name,
          phase: readPhase(state, ir.init),
          progress: hookResult.message,
          allDone: false,
        },
      };
    }
  }

  // Transition
  if (def.transition) {
    const newPhase = def.transition;
    const newStateObj: Record<string, unknown> = { ...state };
    writePhase(newStateObj, newData, newPhase, ir.init);

    // Initialize steps for the new phase
    const targetPhase = getPhase(ir.phases, newPhase);
    let newSteps: WorkflowStep[] = [];
    if (targetPhase && targetPhase.stepSource.type !== 'none') {
      const built = buildStepsFromSource(
        targetPhase.stepSource, staticVars, undefined, targetPhase.stepNameTemplate,
      );
      newSteps = built.steps;
    }

    const newState: WorkflowState = {
      ...state,
      phase: newStateObj.phase as string | undefined,
      data: newData as Record<string, unknown>,
      steps: newSteps,
    };

    const nextStep = newSteps.find(s => s.status === 'in_progress' || s.status === 'pending');

    return {
      newState,
      result: {
        workflow: ir.name,
        phase: newPhase,
        progress: `Phase transitioned to: ${newPhase}`,
        allDone: false,
        nextStep,
      },
    };
  }

  // No transition but has flag → check flag-based completion
  if (ir.complete.condition === 'flag') {
    const allDone = !!newData[ir.complete.flag];
    return {
      newState: { ...state, data: newData as Record<string, unknown> },
      result: {
        workflow: ir.name,
        phase: readPhase(state, ir.init),
        progress: allDone ? 'Complete.' : 'Still in progress.',
        allDone,
      },
    };
  }

  // No transition = just acknowledge
  return {
    newState: state,
    result: {
      workflow: ir.name,
      phase: readPhase(state, ir.init),
      progress: 'Acknowledged.',
      allDone: false,
    },
  };
}

// ─── Auto-transition ──────────────────────────────────────────────────────

function checkAutoTransition(
  state: WorkflowState, phaseDef: PhaseIR,
  steps: WorkflowStep[], staticVars: Record<string, string>, ir: WorkflowIR,
): { newState: WorkflowState; result: { workflow: string; phase?: string; progress: string; allDone: boolean; nextStep?: WorkflowStep } } | null {
  if (!phaseDef.autoTransition || phaseDef.autoTransition.when !== 'all-steps-done') return null;
  if (!allStepsDone(steps.map(s => ({ done: s.status === 'completed' })))) return null;

  const toPhase = phaseDef.autoTransition.toPhase;
  if (!toPhase) {
    // null → workflow complete
    return {
      newState: state,
      result: {
        workflow: ir.name,
        phase: readPhase(state, ir.init),
        progress: renderProgress(steps.filter(s => s.status === 'completed').length, steps.length),
        allDone: true,
      },
    };
  }

  // Transition to next phase
  const newData = { ...state.data } as Record<string, unknown>;
  const newStateObj: Record<string, unknown> = { ...state };
  writePhase(newStateObj, newData, toPhase, ir.init);

  const targetPhase = getPhase(ir.phases, toPhase);
  let newSteps: WorkflowStep[] = [];
  if (targetPhase && targetPhase.stepSource.type !== 'none') {
    const built = buildStepsFromSource(targetPhase.stepSource, staticVars, undefined, targetPhase.stepNameTemplate);
    newSteps = built.steps;
  }

  const newState: WorkflowState = {
    ...state,
    phase: newStateObj.phase as string | undefined,
    data: newData as Record<string, unknown>,
    steps: newSteps,
  };

  return {
    newState,
    result: {
      workflow: ir.name,
      phase: toPhase,
      progress: `Auto-transitioned to: ${toPhase}`,
      allDone: false,
      nextStep: newSteps.find(s => s.status === 'in_progress' || s.status === 'pending'),
    },
  };
}

// ─── Memory step helpers ──────────────────────────────────────────────────

function autoAdvanceMemorySteps(arr: unknown[]): void {
  const hasInProgress = arr.some((s: unknown) => (s as Record<string, unknown>).status === 'in_progress');
  if (!hasInProgress) {
    const next = arr.find((s: unknown) => (s as Record<string, unknown>).status === 'pending') as Record<string, unknown> | undefined;
    if (next) next.status = 'in_progress';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Render Compilers
// ═══════════════════════════════════════════════════════════════════════════

function compileRenderForInjection(ir: WorkflowIR): (state: WorkflowState) => string {
  // Just delegates to renderPersistent (same as all existing builtins)
  const renderPersistent = compileRenderPersistent(ir);
  return (state) => renderPersistent(state);
}

function compileRenderPersistent(ir: WorkflowIR): (state: WorkflowState) => string {
  return (state: WorkflowState): string => {
    const phaseName = readPhase(state, ir.init);
    if (!phaseName) return '';

    const phaseDef = getPhase(ir.phases, phaseName);
    if (!phaseDef) return '';

    return renderPersistentDef(phaseDef.render.persistent, state, ir);
  };
}

function renderPersistentDef(
  def: RenderPersistentDef | undefined,
  state: WorkflowState,
  ir: WorkflowIR,
): string {
  if (!def) return '';

  const staticVars = (state.data._staticVars as Record<string, string>) || {};

  switch (def.type) {
    case 'template': {
      let text = '';
      try {
        text = loadPrompt(def.template);
      } catch {
        return `[提示词模板缺失: ${def.template}]`;
      }
      // Build vars: static + dynamic
      const vars: Record<string, string> = { ...def.staticVars };
      for (const [key, val] of Object.entries(vars)) {
        vars[key] = sub(val, staticVars);
      }
      if (def.dynamicVars) {
        for (const [key, expr] of Object.entries(def.dynamicVars)) {
          vars[key] = resolveDynamicVar(expr, state, staticVars);
        }
      }
      return renderPrompt(text, vars);
    }
    case 'progress-summary': {
      const title = sub(def.title, staticVars);
      let completed = 0, total = 0, blocked = 0;
      if (def.fromMemory) {
        const steps = state.steps;
        completed = steps.filter(s => s.status === 'completed').length;
        blocked = steps.filter(s => s.status === 'blocked').length;
        total = steps.length;
      } else if (def.file) {
        const fp = expandPath(def.file, staticVars);
        const parsed = parseFileSteps(fp, 'flat');
        completed = parsed.filter(s => s.done).length;
        total = parsed.length;
      }
      const progressStr = renderProgress(completed, total, blocked);
      return title ? `## ${title}\n${progressStr}` : progressStr;
    }
    case 'file-content': {
      try {
        const fp = expandPath(def.file, staticVars);
        return fs.readFileSync(fp, 'utf-8');
      } catch {
        return def.onMissing === 'error' ? `[文件缺失: ${def.file}]` : '';
      }
    }
    case 'data-content': {
      const val = (state.data as Record<string, unknown>)[def.field];
      if (val === undefined || val === null || val === '') {
        return def.fallback || '';
      }
      if (def.transform === 'join' && Array.isArray(val)) {
        const joined = val.map(String).join('\n');
        return def.prefix ? def.prefix + joined : joined;
      }
      const str = String(val);
      return def.prefix ? def.prefix + str : str;
    }
    case 'composite': {
      return def.sections.map(s => renderPersistentDef(s, state, ir)).filter(Boolean).join('\n\n');
    }
    case 'none':
      return '';
    default:
      return '';
  }
}

function compileRenderStep(ir: WorkflowIR): (state: WorkflowState) => string {
  return (state: WorkflowState): string => {
    const phaseName = readPhase(state, ir.init);
    if (!phaseName) return '';

    const phaseDef = getPhase(ir.phases, phaseName);
    if (!phaseDef) return '';

    return renderStepDef(phaseDef.render.step, state, phaseDef);
  };
}

function renderStepDef(
  def: RenderStepDef | undefined,
  state: WorkflowState,
  phaseDef: PhaseIR,
): string {
  if (!def || def.type === 'none') return '';

  const steps = state.steps;

  // Edge cases: no steps
  if (steps.length === 0) return '';

  const allDone = allStepsDone(steps.map(s => ({ done: s.status === 'completed' })));
  if (allDone) return '\n✅ All steps complete.';

  const allBlocked = steps.length > 0 && steps.every(s => s.status === 'blocked' || s.status === 'completed');
  if (allBlocked) {
    const blockedCount = steps.filter(s => s.status === 'blocked').length;
    return `\n⚠️ All ${blockedCount} remaining step(s) are blocked. Resolve blockers before continuing.`;
  }

  const label = def.stepLabel || 'Step';

  if (def.type === 'current-step') {
    const current = steps.find(s => s.status === 'in_progress');
    if (current) {
      const total = steps.length;
      const showCmd = def.showWorkflowCommand !== false;
      const cmdBlock = showCmd
        ? `\n\nMark done: \`workflow({action:"step", id:${current.id}, stepAction:"done"})\`\nMark blocked: \`workflow({action:"step", id:${current.id}, stepAction:"blocked", message:"reason"})\``
        : '';
      return `\n**Current ${label}** (${current.id}/${total}): ${current.description}${cmdBlock}`;
    }
  }

  // Fallback: next-step (or current-step without in_progress)
  const next = steps.find(s => s.status === 'pending');
  if (next) {
    const showCmd = def.showWorkflowCommand !== false;
    const cmdBlock = showCmd
      ? `\n\nStart: \`workflow({action:"step", id:${next.id}, stepAction:"done"})\``
      : '';
    return `\n**Next ${label}**: ${next.description}${cmdBlock}`;
  }

  return '';
}

// ─── Dynamic variable resolution ──────────────────────────────────────────

function resolveDynamicVar(expr: string, state: WorkflowState, staticVars: Record<string, string>): string {
  // expr can reference data fields, file paths, or step stats
  // Simple implementation: handle common patterns
  const dataRecord = state.data as Record<string, unknown>;

  // data.fieldName → read from state.data
  if (expr.startsWith('data.')) {
    const field = expr.slice(5);
    const val = dataRecord[field];
    if (Array.isArray(val)) return val.map(String).join('\n');
    if (val === undefined || val === null) return '';
    return String(val);
  }

  // file:path → read file content
  if (expr.startsWith('file:')) {
    const fp = expandPath(expr.slice(5), staticVars);
    try {
      return fs.readFileSync(fp, 'utf-8');
    } catch {
      return '';
    }
  }

  // steps.count → return count of steps
  if (expr === 'steps.count') return String(state.steps.length);

  // Literal (passed through sub)
  return sub(expr, staticVars);
}

// ═══════════════════════════════════════════════════════════════════════════
// isComplete Compiler
// ═══════════════════════════════════════════════════════════════════════════

function compileIsComplete(ir: WorkflowIR): (state: WorkflowState) => boolean {
  return (state: WorkflowState): boolean => {
    const staticVars = (state.data._staticVars as Record<string, string>) || {};

    switch (ir.complete.condition) {
      case 'all-steps-done': {
        if (ir.complete.file) {
          const fp = expandPath(ir.complete.file, staticVars);
          const parsed = parseFileSteps(fp, 'flat');
          return parsed.length > 0 && parsed.every(s => s.done);
        }
        return state.steps.length > 0 && state.steps.every(s => s.status === 'completed');
      }
      case 'phase-and-all-done': {
        const currentPhase = readPhase(state, ir.init);
        if (currentPhase !== ir.complete.phase) return false;
        if (ir.complete.file) {
          const fp = expandPath(ir.complete.file, staticVars);
          const parsed = parseFileSteps(fp, 'flat');
          return parsed.length > 0 && parsed.every(s => s.done);
        }
        return state.steps.length > 0 && state.steps.every(s => s.status === 'completed');
      }
      case 'flag': {
        return !!(state.data as Record<string, unknown>)[ir.complete.flag];
      }
      default:
        return false;
    }
  };
}
