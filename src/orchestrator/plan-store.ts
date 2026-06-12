import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Plan Data Types
// ---------------------------------------------------------------------------

/** Status of a plan step */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

/** Status of the overall plan */
export type PlanStatus = 'active' | 'completed' | 'abandoned';

/** A single step in the execution plan */
export interface PlanStep {
  id: string;
  description: string;
  selectedTools: string[];
  status: PlanStepStatus;
  result?: string; // summary when completed
  assignedAgent?: string; // agent assigned to this step
  agentResult?: string; // result returned by the assigned agent
}

/** The execution plan */
export interface Plan {
  id: string;
  userGoal: string;
  steps: PlanStep[];
  selectedTools: string[];
  estimatedTurns: number;
  reasoning: string;
  createdAt: string;
  updatedAt: string;
  status: PlanStatus;
}

// ---------------------------------------------------------------------------
// PlanStore
// ---------------------------------------------------------------------------

/**
 * Persists Plan objects to a JSONL file in the session directory.
 * Each write appends a new line; the latest active entry is the current state.
 */
export class PlanStore {
  /**
   * Create a new plan and persist it.
   * Writes a line to {sessionDir}/plan.jsonl
   */
  async create(sessionDir: string, plan: Plan): Promise<void> {
    const filePath = join(sessionDir, 'plan.jsonl');
    await appendFile(filePath, JSON.stringify(plan) + '\n', 'utf-8');
  }

  /**
   * Update an existing plan (append updated version to JSONL).
   * The latest entry in the file is the current state.
   */
  async update(sessionDir: string, plan: Plan): Promise<void> {
    const updated: Plan = {
      ...plan,
      updatedAt: new Date().toISOString(),
    };
    const filePath = join(sessionDir, 'plan.jsonl');
    await appendFile(filePath, JSON.stringify(updated) + '\n', 'utf-8');
  }

  /**
   * Read the latest plan from the session directory.
   * Returns undefined if no plan exists.
   */
  async readLatest(sessionDir: string): Promise<Plan | undefined> {
    const filePath = join(sessionDir, 'plan.jsonl');
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return undefined;
    }

    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return undefined;

    // Parse all lines and return the last one with status 'active'
    let latestActive: Plan | undefined;
    for (const line of lines) {
      try {
        const plan: Plan = JSON.parse(line);
        if (plan.status === 'active') {
          latestActive = plan;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return latestActive;
  }

  /**
   * Update plan progress based on tool calls made in the current turn.
   * Returns the updated Plan.
   *
   * Algorithm:
   * 1. Find the first step with status 'in_progress' — if found, check if any
   *    of its selectedTools were called this turn. If yes, mark it as 'done'
   *    and move to the next pending step.
   * 2. If no step is 'in_progress', find the first 'pending' step whose
   *    selectedTools overlap with the tools called this turn, and mark it as
   *    'in_progress'.
   * 3. If ALL steps are 'done' or 'skipped', mark the Plan's status as
   *    'completed'.
   */
  async updateProgress(
    sessionDir: string,
    toolCallsThisTurn: string[],
  ): Promise<Plan | undefined> {
    const plan = await this.readLatest(sessionDir);
    if (!plan || plan.status !== 'active') return undefined;

    if (toolCallsThisTurn.length === 0) return plan;

    const toolSet = new Set(toolCallsThisTurn);
    const steps = plan.steps.map((s) => ({ ...s })); // shallow clone steps

    // 1. Check for in_progress step
    const inProgressIdx = steps.findIndex((s) => s.status === 'in_progress');

    if (inProgressIdx !== -1) {
      const step = steps[inProgressIdx];
      const hasOverlap = step.selectedTools.some((t) => toolSet.has(t));
      if (hasOverlap) {
        step.status = 'done';
        // Move to next pending step whose tools overlap
        const nextIdx = steps.findIndex(
          (s, i) => i > inProgressIdx && s.status === 'pending' && s.selectedTools.some((t) => toolSet.has(t)),
        );
        if (nextIdx !== -1) {
          steps[nextIdx].status = 'in_progress';
        }
      }
    } else {
      // 2. No in_progress step — find first pending step with tool overlap
      const pendingIdx = steps.findIndex(
        (s) => s.status === 'pending' && s.selectedTools.some((t) => toolSet.has(t)),
      );
      if (pendingIdx !== -1) {
        steps[pendingIdx].status = 'in_progress';
      }
    }

    // 3. Check if all steps are done or skipped
    const allDone = steps.every(
      (s) => s.status === 'done' || s.status === 'skipped',
    );

    const updatedPlan: Plan = {
      ...plan,
      steps,
      status: allDone ? 'completed' : 'active',
      updatedAt: new Date().toISOString(),
    };

    await this.update(sessionDir, updatedPlan);
    return updatedPlan;
  }
}

// ---------------------------------------------------------------------------
// Helper: formatPlanAsText
// ---------------------------------------------------------------------------

/**
 * Format a Plan as human-readable text for injection into Zone 3.
 */
export function formatPlanAsText(plan: Plan): string {
  const stepsText = plan.steps
    .map((step, i) => {
      const statusIcon =
        step.status === 'done'
          ? '\u2713'
          : step.status === 'in_progress'
            ? '\u2192'
            : step.status === 'skipped'
              ? '\u2205'
              : '\u25CB';
      return `${statusIcon} Step ${i + 1}: ${step.description} [${step.selectedTools.join(', ')}]${step.assignedAgent ? ` → @${step.assignedAgent}` : ''}${step.result ? `\n  Result: ${step.result}` : ''}${step.agentResult ? `\n  Agent Result: ${step.agentResult}` : ''}`;
    })
    .join('\n');

  return `Execution Plan: ${plan.userGoal}\nReasoning: ${plan.reasoning}\nEstimated Turns: ${plan.estimatedTurns}\n\nSteps:\n${stepsText}`;
}

// ---------------------------------------------------------------------------
// Helper: createPlan
// ---------------------------------------------------------------------------

/**
 * Create a new Plan object with generated id and timestamps.
 */
export function createPlan(params: {
  userGoal: string;
  steps: Array<{ description: string; selectedTools: string[]; assignedAgent?: string }>;
  selectedTools: string[];
  estimatedTurns: number;
  reasoning: string;
}): Plan {
  const now = new Date().toISOString();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    userGoal: params.userGoal,
    steps: params.steps.map((s, i) => ({
      id: `step_${i + 1}`,
      description: s.description,
      selectedTools: s.selectedTools,
      status: 'pending' as const,
      ...(s.assignedAgent ? { assignedAgent: s.assignedAgent } : {}),
    })),
    selectedTools: params.selectedTools,
    estimatedTurns: params.estimatedTurns,
    reasoning: params.reasoning,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };
}
