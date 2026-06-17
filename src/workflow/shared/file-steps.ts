/**
 * 文件驱动步骤工具 — 内置 workflow（Plan/Spec）共用。
 *
 * ## 适用场景
 *
 * 如果你的 Workflow 使用 checkbox 文件（- [ ] 描述）作为步骤的持久化方案，
 * 直接导入此模块的函数即可，无需在 handleStep 中手写解析/标记逻辑。
 *
 * ## 使用方式（以 Plan 为例）
 *
 *   import { parseSimpleSteps, markStepInFile, buildWfSteps, findNextStepIdx, renderProgress }
 *     from '../shared/file-steps.js';
 *
 *   // 解析文件中的步骤
 *   const steps = parseSimpleSteps(content);
 *   // 标记步骤为完成并写回
 *   const newContent = markStepInFile(content, stepIdx, 'x');
 *   // 构建 WorkflowStep[]（自动维护 in_progress）
 *   const wfSteps = buildWfSteps(updatedSteps);
 *   // 找到下一个可执行步骤
 *   const nextIdx = findNextStepIdx(steps, completedId);
 *
 * ## checkbox 格式
 *
 *   - [ ] 待执行
 *   - [x] 已完成  ← 只有 [x] 算完成
 *   - [🚫] 受阻  ← [🚫] ≠ 完成
 *
 * ## 多级段落（仅 Spec 的 tasks.md）
 *
 *   ## 第一部分: 标题
 *   - [ ] 步骤1
 *   - [ ] 步骤2
 *   ## 第二部分: 标题
 *   - [ ] 步骤3
 *
 *   使用 parseTaskSections + flattenSections + buildWfStepsFromFlat 处理。
 */
import type { WorkflowStep } from '../types.js';

// ─── 类型 ───────────────────────────────────────────────────────────

export interface ParsedStep {
  lineIdx: number;
  text: string;
  done: boolean;
  blocked: boolean;
}

export interface TaskSection {
  title: string;
  steps: ParsedStep[];
}

export interface FlatStep {
  index: number;     // 0-based across all sections
  section: string;   // section title
  step: ParsedStep;
}

// ─── 解析 ───────────────────────────────────────────────────────────

/** 解析一行 "  [x] / [ ] / [🚫] 描述" */
export function parseCheckboxLine(line: string): { ch: string; text: string } | null {
  const m = line.match(/^- \[(.)\] (.+)/);
  return m ? { ch: m[1], text: m[2].trim() } : null;
}

/** 解析纯 checkbox 列表（无段落结构） */
export function parseSimpleSteps(content: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cb = parseCheckboxLine(lines[i]);
    if (cb) {
      steps.push({
        lineIdx: i,
        text: cb.text,
        done: cb.ch === 'x',
        blocked: cb.ch === '🚫',
      });
    }
  }
  return steps;
}

/** 解析带段落标题的 tasks 结构（## 第N部分 → - [ ] 步骤） */
export function parseTaskSections(content: string): TaskSection[] {
  const sections: TaskSection[] = [];
  const lines = content.split('\n');
  let currentSection: TaskSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^## (.+)/);
    if (headingMatch) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: headingMatch[1].trim(), steps: [] };
      continue;
    }

    const cb = parseCheckboxLine(lines[i]);
    if (cb) {
      if (!currentSection) {
        currentSection = { title: '步骤', steps: [] };
      }
      currentSection.steps.push({
        lineIdx: i,
        text: cb.text,
        done: cb.ch === 'x',
        blocked: cb.ch === '🚫',
      });
    }
  }

  if (currentSection) sections.push(currentSection);
  return sections;
}

/** 把所有 section 的步骤展平为一个列表 */
export function flattenSections(sections: TaskSection[]): FlatStep[] {
  const flat: FlatStep[] = [];
  let idx = 0;
  for (const sec of sections) {
    for (const s of sec.steps) {
      flat.push({ index: idx++, section: sec.title, step: s });
    }
  }
  return flat;
}

// ─── 文件标记 ───────────────────────────────────────────────────────

/** 标记指定步骤为 done(x) 或 blocked(🚫)，写回文件内容 */
export function markStepInFile(
  content: string,
  stepIdx: number,
  mark: 'x' | '🚫',
  message?: string,
): string {
  const lines = content.split('\n');
  const allSteps = parseSimpleSteps(content);
  const step = allSteps[stepIdx];
  if (!step) return content;

  let suffix = '';
  if (mark === '🚫' && message) suffix = ` (受阻: ${message})`;

  lines[step.lineIdx] = lines[step.lineIdx].replace(/^- \[.\] (.+)/, `- [${mark}] $1${suffix}`);
  return lines.join('\n');
}

// ─── 判定 ───────────────────────────────────────────────────────────

export function allStepsDone(steps: Array<{ done: boolean }>): boolean {
  return steps.length > 0 && steps.every(s => s.done);
}

// ─── WorkflowStep 构建 ──────────────────────────────────────────────

/** 从 ParsedStep[] 构建 WorkflowStep[]，维护 in_progress 状态。existingInProgress 为已有 in_progress 步骤的 index（-1 表示无）。 */
export function buildWfSteps(
  parsedSteps: ParsedStep[],
  existingInProgress?: number,
): WorkflowStep[] {
  const valid = existingInProgress != null && existingInProgress >= 0;
  const inProgressIdx = valid ? existingInProgress : parsedSteps.findIndex(s => !s.done && !s.blocked);
  return parsedSteps.map((s, i) => ({
    id: i + 1,
    name: s.text,
    description: s.text,
    status: s.done ? 'completed' as const
      : s.blocked ? 'blocked' as const
      : (i === inProgressIdx ? 'in_progress' as const : 'pending' as const),
  }));
}

/** 从 FlatStep[] 构建 WorkflowStep[]（含段落名）。existingInProgress 为已有 in_progress 步骤的 index（-1 表示无）。 */
export function buildWfStepsFromFlat(
  flatSteps: FlatStep[],
  existingInProgress?: number,
): WorkflowStep[] {
  const valid = existingInProgress != null && existingInProgress >= 0;
  const inProgressIdx = valid ? existingInProgress : flatSteps.findIndex(f => !f.step.done && !f.step.blocked);
  return flatSteps.map((f, i) => ({
    id: i + 1,
    name: `[${f.section}] ${f.step.text}`,
    description: f.step.text,
    status: f.step.done ? 'completed' as const
      : f.step.blocked ? 'blocked' as const
      : (i === inProgressIdx ? 'in_progress' as const : 'pending' as const),
  }));
}

// ─── 步骤推进 ───────────────────────────────────────────────────────

/** 找到 afterStepId 之后第一个可执行的步骤（未 done 且未 blocked）。afterStepId 为 1-based 步骤号。 */
export function findNextStepIdx(
  steps: ParsedStep[],
  afterStepId: number,
): number {
  // afterStepId 是 1-based，转 0-based index 搜索
  return steps.findIndex((s, i) => i >= afterStepId - 1 && !s.done && !s.blocked);
}

/** 从 WorkflowStep[] 中找到当前 in_progress 步骤的 ID */
export function findInProgressId(wfSteps: WorkflowStep[]): number {
  return wfSteps.findIndex(s => s.status === 'in_progress');
}

// ─── 进度渲染 ───────────────────────────────────────────────────────

export function renderProgress(
  completed: number,
  total: number,
  blocked?: number,
): string {
  const blk = blocked ?? 0;
  let line = `**Progress**: ${completed}/${total} done`;
  if (blk > 0) line += `, ${blk} blocked`;
  line += `, ${total - completed - blk} remaining`;
  return line;
}
