/**
 * ## DSL 解析器 — YAML 字符串 → WorkflowIR
 *
 * 设计约束：
 *   - 使用 `yaml` npm 包解析（零依赖，严格 YAML 规范）
 *   - parse() 返回 Validated<WorkflowIR>，包含所有验证错误
 *   - 旧简单格式（无 phases）自动升级为单阶段 memory 型工作流
 *   - 所有可选字段有合理默认值
 */
import { parse as parseYaml } from 'yaml';
import type {
  WorkflowIR,
  InitIR,
  PhaseIR,
  CompleteIR,
  RenderPersistentDef,
  RenderStepDef,
} from './schema.js';

// ─── Result type ──────────────────────────────────────────────────────────

export interface ParseResult {
  ir?: WorkflowIR;
  errors: string[];
}

function fail(errors: string[]): ParseResult {
  return { errors };
}

function ok(ir: WorkflowIR): ParseResult {
  return { ir, errors: [] };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * 解析 YAML 字符串为 WorkflowIR。
 * 返回所有验证错误（而非遇到第一个就退出），方便用户一次性修复。
 */
export function parse(yamlText: string): ParseResult {
  const errors: string[] = [];

  // 1. YAML parse
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(yamlText) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') {
      return fail(['YAML must be a mapping (key-value document)']);
    }
  } catch (err) {
    return fail([`YAML parse error: ${err instanceof Error ? err.message : String(err)}`]);
  }

  // 2. Detect legacy format (has steps[], no phases) — auto-upgrade to DSL
  if (!raw.phases && raw.steps && Array.isArray(raw.steps)) {
    const modern = toModernFormat(raw);
    const ir = buildIR(modern, errors);
    if (errors.length > 0) return fail(errors);
    return ok(ir!);
  }

  // 3. Validate & build IR
  const ir = buildIR(raw, errors);
  if (errors.length > 0) return fail(errors);
  return ok(ir!);
}

// ─── Build IR ─────────────────────────────────────────────────────────────

function buildIR(raw: Record<string, unknown>, errors: string[]): WorkflowIR {
  const schema = asString(raw.schema) || '1.0';
  const name = asString(raw.name);
  const description = asString(raw.description);

  if (!name) errors.push('Missing required field: name');
  if (!description) errors.push('Missing required field: description');

  const rawPhases = asArray(raw.phases);
  if (rawPhases.length === 0) errors.push('Missing required field: phases (at least one phase required)');

  return {
    schema,
    name: name || 'unnamed',
    description: description || 'No description',
    triggerKeywords: asStringArray(raw.triggerKeywords),
    relatedTools: asStringArray(raw.relatedTools),
    init: buildInit(raw.init, errors),
    phases: rawPhases.map((p, i) => buildPhase(asRecord(p) || {}, i, errors)),
    complete: buildComplete(raw.complete, errors),
    hooks: asRecord(raw.hooks) as WorkflowIR['hooks'],
    onDeactivate: asString(raw.onDeactivate) || 'none',
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────

function buildInit(raw: unknown, errors: string[]): InitIR {
  const obj = asRecord(raw) || {};
  const phaseField = (asString(obj.phaseField) || 'both') as InitIR['phaseField'];

  if (!['state', 'data', 'both'].includes(phaseField)) {
    errors.push(`init.phaseField must be "state", "data", or "both", got: ${phaseField}`);
  }

  return {
    staticVars: (asRecord(obj.staticVars) || {}) as InitIR['staticVars'],
    dynamicVars: (asRecord(obj.dynamicVars) || {}) as InitIR['dynamicVars'],
    data: (asRecord(obj.data) || {}) as InitIR['data'],
    taskFrom: asString(obj.taskFrom),
    workDir: obj.workDir ? {
      base: asString((obj.workDir as Record<string, unknown>).base) || '~/.agent/workflows',
      segments: asStringArray((obj.workDir as Record<string, unknown>).segments),
    } : undefined,
    phaseField,
  };
}

// ─── Phase ────────────────────────────────────────────────────────────────

function buildPhase(raw: Record<string, unknown>, _index: number, errors: string[]): PhaseIR {
  const name = asString(raw.name);
  if (!name) errors.push('Phase missing required field: name');

  return {
    name: name || `phase-${_index}`,
    description: asString(raw.description),
    skipIf: buildSkipIf(asRecord(raw.skipIf)),
    stepSource: buildStepSource(asRecord(raw.stepSource), errors),
    stepNameTemplate: asString(raw.stepNameTemplate) || '[{section}] {text}',
    actions: asStringArray(raw.actions),
    onAction: asRecord(raw.onAction) || {},
    autoTransition: buildAutoTransition(asRecord(raw.autoTransition)),
    render: buildRender(asRecord(raw.render), errors, name || `phase-${_index}`),
  };
}

function buildSkipIf(obj: Record<string, unknown> | null): PhaseIR['skipIf'] {
  if (!obj) return undefined;
  const condition = asString(obj.condition);
  if (!condition || !['exists', 'non-empty', 'has-checkboxes'].includes(condition)) return undefined;
  const file = asString(obj.file);
  const thenPhase = asString(obj.thenPhase);
  if (!file || !thenPhase) return undefined;
  return { file, condition: condition as 'exists' | 'non-empty' | 'has-checkboxes', thenPhase };
}

function buildStepSource(obj: Record<string, unknown> | null, errors: string[]): PhaseIR['stepSource'] {
  if (!obj) return { type: 'none' };
  const type = asString(obj.type) || 'none';

  if (type === 'file') {
    const path = asString(obj.path);
    const format = asString(obj.format) || 'flat';
    if (!path) errors.push('stepSource.type=file requires path');
    return { type: 'file', path: path || '', format: format as 'flat' | 'sectioned' };
  }
  if (type === 'memory') {
    return { type: 'memory', field: asString(obj.field) || 'steps' };
  }
  return { type: 'none' };
}

function buildAutoTransition(obj: Record<string, unknown> | null): PhaseIR['autoTransition'] {
  if (!obj) return undefined;
  const when = asString(obj.when);
  if (when !== 'all-steps-done') return undefined;
  const toPhase = obj.toPhase === null || obj.toPhase === undefined ? null : asString(obj.toPhase);
  return { when: 'all-steps-done', toPhase: toPhase ?? null };
}

// ─── Render ───────────────────────────────────────────────────────────────

function buildRender(obj: Record<string, unknown> | null, errors: string[], phaseName: string): PhaseIR['render'] {
  if (!obj) return { persistent: { type: 'none' }, step: { type: 'none' } };

  return {
    persistent: buildRenderPersistent(asRecord(obj.persistent), errors, phaseName),
    step: buildRenderStep(asRecord(obj.step), errors),
  };
}

function buildRenderPersistent(
  obj: Record<string, unknown> | null,
  errors: string[],
  _phaseName: string,
): RenderPersistentDef {
  if (!obj) return { type: 'none' };
  const type = asString(obj.type) || 'none';

  switch (type) {
    case 'template': {
      const template = asString(obj.template);
      if (!template) {
        errors.push(`render.persistent type=template needs "template" field`);
        return { type: 'none' };
      }
      return {
        type: 'template',
        template,
        staticVars: (asRecord(obj.staticVars) || {}) as Record<string, string>,
        dynamicVars: (asRecord(obj.dynamicVars) || {}) as Record<string, string>,
      };
    }
    case 'progress-summary':
      return {
        type: 'progress-summary',
        title: asString(obj.title) || '',
        file: asString(obj.file),
        fromMemory: asBool(obj.fromMemory),
      };
    case 'file-content':
      return {
        type: 'file-content',
        file: asString(obj.file) || '',
        onMissing: (asString(obj.onMissing) as 'empty' | 'error') || 'empty',
      };
    case 'data-content':
      return {
        type: 'data-content',
        field: asString(obj.field) || '',
        transform: asString(obj.transform) as 'join' | undefined,
        fallback: asString(obj.fallback),
        prefix: asString(obj.prefix),
      };
    case 'composite': {
      const rawSections = asArray(obj.sections);
      const sections = rawSections.map(s => buildRenderPersistent(asRecord(s), errors, 'composite-section'));
      return { type: 'composite', sections };
    }
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'none' };
  }
}

function buildRenderStep(obj: Record<string, unknown> | null, _errors: string[]): RenderStepDef {
  if (!obj) return { type: 'none' };
  const type = asString(obj.type) || 'none';

  if (type === 'current-step' || type === 'next-step') {
    return {
      type,
      stepLabel: asString(obj.stepLabel) || 'Step',
      showWorkflowCommand: obj.showWorkflowCommand !== false,
    };
  }
  return { type: 'none' };
}

// ─── Complete ─────────────────────────────────────────────────────────────

function buildComplete(raw: unknown, errors: string[]): CompleteIR {
  const obj = asRecord(raw);
  if (!obj) {
    errors.push('Missing required field: complete');
    return { condition: 'all-steps-done' };
  }
  const condition = asString(obj.condition) || 'all-steps-done';

  if (condition === 'phase-and-all-done') {
    const phase = asString(obj.phase);
    if (!phase) errors.push('complete.condition=phase-and-all-done requires phase');
    return { condition, phase: phase || '', file: asString(obj.file) };
  }
  if (condition === 'flag') {
    const flag = asString(obj.flag);
    if (!flag) errors.push('complete.condition=flag requires flag');
    return { condition, flag: flag || '' };
  }
  return { condition: 'all-steps-done', file: asString(obj.file) };
}

// ─── Legacy format upgrade ────────────────────────────────────────────────

/**
 * 将旧简单格式（name/description/steps[]）转换为 DSL 格式。
 * 生成单阶段 memory 型工作流。
 */
function toModernFormat(raw: Record<string, unknown>): Record<string, unknown> {
  const steps = asArray(raw.steps);
  return {
    name: raw.name,
    description: raw.description || raw.name || 'Imported workflow',
    triggerKeywords: raw.triggerKeywords || [],
    relatedTools: raw.relatedTools || [],
    init: {
      staticVars: {},
      dynamicVars: {},
      data: {
        steps: { type: 'array', default: (steps || []).map((s: unknown) => {
          const st = asRecord(s) || {};
          return {
            id: st.id || 1,
            name: st.name || st.description || 'Untitled',
            description: st.description || st.name || '',
            status: 'pending',
          };
        }) },
      },
      phaseField: 'data',
    },
    phases: [{
      name: 'execute',
      stepSource: { type: 'memory', field: 'steps' },
      actions: ['done', 'blocked', 'add', 'note', 'progress'],
      onAction: {
        done: { source: 'memory', setStatus: 'completed', autoAdvance: true },
        blocked: { source: 'memory', setStatus: 'blocked', autoAdvance: true },
        add: { source: 'memory', pushToMemory: true },
        note: { appendToData: 'notes' },
        progress: { appendToData: 'notes' },
      },
      render: {
        persistent: { type: 'progress-summary', fromMemory: true, title: (raw.name as string) || 'Workflow' },
        step: { type: 'current-step', stepLabel: 'Step', showWorkflowCommand: true },
      },
    }],
    complete: { condition: 'all-steps-done' },
  };
}

// ─── Type coercion helpers ────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  return undefined;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return [];
}

function asStringArray(v: unknown): string[] {
  return asArray(v).map(item => typeof item === 'string' ? item : String(item));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}
