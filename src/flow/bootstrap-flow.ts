// ============================================================
// BootstrapFlow — 身份引导 Flow
// ============================================================
//
// 首次安装后自动运行一次。通过 4 个步骤引导模型与用户交流，
// 逐步填写 SOUL.md、IDENTITY.md、USER.md，完成后永久标记。
//
// 步骤提示词从 src/prompts/flows/bootstrap-*.md 加载。
// ============================================================

import type { FlowController, FlowStep, FlowStatus } from './types.js';
import { loadPrompt } from '../prompts/loader.js';
import { markBootstrapComplete } from '../setup/persona-bootstrap.js';

const STEP_FILES = [
  'bootstrap-soul',
  'bootstrap-identity',
  'bootstrap-user',
  'bootstrap-confirm',
] as const;

export class BootstrapFlow implements FlowController {
  readonly id = 'bootstrap';
  status: FlowStatus = 'idle';
  currentStepIndex = 0;
  private steps: FlowStep[] = [];
  private personaDir: string;

  constructor(personaDir: string) {
    this.personaDir = personaDir;
  }

  activate(): void {
    this.currentStepIndex = 0;
    this.status = 'active';
    // 延迟加载步骤提示词（activate 时才加载，避免模块导入时的副作用）
    this.steps = STEP_FILES.map((file) => ({
      id: file,
      prompt: loadPrompt(`flows/${file}`).replace(/\{\{personaDir\}\}/g, this.personaDir),
    }));
  }

  deactivate(): void {
    this.status = 'idle';
    this.steps = [];
  }

  getSteps(): FlowStep[] {
    return this.steps;
  }

  getCurrentStep(): FlowStep | null {
    if (this.status !== 'active') return null;
    return this.steps[this.currentStepIndex] ?? null;
  }

  advance(): boolean {
    this.currentStepIndex++;
    if (this.currentStepIndex >= this.steps.length) {
      return false; // 所有步骤完成
    }
    return true;
  }

  isComplete(): boolean {
    return this.currentStepIndex >= this.steps.length;
  }

  getInjection(): string | null {
    const step = this.getCurrentStep();
    if (!step) return null;

    const total = this.steps.length;
    const current = this.currentStepIndex + 1;
    const header = `\n[Bootstrap ${current}/${total}]\n`;
    return header + step.prompt;
  }

  /** 所有步骤完成后调用：标记 bootstrap 完成，永久不再触发 */
  async onComplete(): Promise<void> {
    await markBootstrapComplete(this.personaDir);
  }
}
