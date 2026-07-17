// ============================================================
// BootstrapFlow — 身份引导 Flow
// ============================================================
//
// 首次安装后自动运行一次。通过 4 个步骤引导模型与用户交流，
// 逐步填写 SOUL.md、IDENTITY.md、USER.md，完成后永久标记。
//
// 基于 MachineDef：4 个固定状态，线性推进，无 guard，无动态步骤。
// 步骤提示词从 src/prompts/flows/bootstrap-*.md 加载。
// ============================================================

import type { MachineContext, MachineDef, MachineSnapshot, AdvanceResult } from '../types.js';
import { MachineRunner } from '../runner.js';
import type { FlowController } from './types.js';
import { loadPrompt } from '../../prompts/loader.js';
import { markBootstrapComplete } from '../../setup/persona-bootstrap.js';

// ── 步骤定义 ────────────────────────────────────────────────

const STEP_FILES = [
  'bootstrap-soul',
  'bootstrap-identity',
  'bootstrap-user',
  'bootstrap-confirm',
] as const;

const STATE_NAMES = ['soul', 'identity', 'user', 'confirm'] as const;

// ── MachineDef ──────────────────────────────────────────────

/**
 * Bootstrap 状态机定义。
 *
 * States:  soul → identity → user → confirm → __completed__
 * Initial: soul
 * Terminal: __completed__
 *
 * 线性推进，无 guard——每步的 complete_flow_step 无条件转移。
 * 最后一步 (confirm → __completed__) 的 onTransition 中调用
 * markBootstrapComplete() 做永久标记。
 */
function createBootstrapMachineDef(personaDir: string): MachineDef {
  return {
    id: 'bootstrap',
    initial: 'soul',
    states: {
      soul:          { label: '设定灵魂' },
      identity:      { label: '设定身份' },
      user:          { label: '了解用户' },
      confirm:       { label: '确认配置' },
      __completed__: { label: '已完成' },
    },
    transitions: [
      { from: 'soul',     to: 'identity', event: 'complete_flow_step' },
      { from: 'identity', to: 'user',     event: 'complete_flow_step' },
      { from: 'user',     to: 'confirm',  event: 'complete_flow_step' },
      {
        from: 'confirm',
        to: '__completed__',
        event: 'flow_complete',
      },
    ],
    terminalStates: ['__completed__'],
    onComplete: async (_ctx: MachineContext) => {
      await markBootstrapComplete(personaDir);
    },
  };
}

// ── BootstrapFlow ────────────────────────────────────────────

export class BootstrapFlow implements FlowController {
  readonly id = 'bootstrap';
  readonly runner: MachineRunner;

  private personaDir: string;
  private stepPrompts: Map<string, string> = new Map();

  constructor(personaDir: string) {
    this.personaDir = personaDir;
    this.runner = new MachineRunner(createBootstrapMachineDef(personaDir));
  }

  // ── 生命周期 ──────────────────────────────────────────────

  activate(_context?: MachineContext): void {
    // Bootstrap 不需要 context——步骤是固定的
    this.runner.activate();
  }

  deactivate(): void {
    this.runner.deactivate();
  }

  advance(event: string): AdvanceResult {
    return this.runner.advance(event);
  }

  getSnapshot(): MachineSnapshot {
    return this.runner.getSnapshot();
  }

  isComplete(): boolean {
    return this.runner.isComplete();
  }

  // ── Zone 5 注入 ───────────────────────────────────────────

  getInjection(): string | null {
    const snap = this.runner.getSnapshot();
    if (snap.status !== 'active') return null;

    // 从状态名映射到步骤文件
    const stateToFile: Record<string, string> = {
      soul: 'bootstrap-soul',
      identity: 'bootstrap-identity',
      user: 'bootstrap-user',
      confirm: 'bootstrap-confirm',
    };

    const fileKey = stateToFile[snap.currentState];
    if (!fileKey) return null;

    // 懒加载提示词
    const prompt = this.loadPromptOnce(fileKey)
      .replace(/\{\{personaDir\}\}/g, this.personaDir);

    const stepIndex = STATE_NAMES.indexOf(snap.currentState as typeof STATE_NAMES[number]);
    const stepNum = stepIndex >= 0 ? stepIndex + 1 : 1;
    const header = `\n[Bootstrap ${stepNum}/4]\n`;
    return header + prompt;
  }

  // ── 内部 ──────────────────────────────────────────────────

  private loadPromptOnce(file: string): string {
    if (!this.stepPrompts.has(file)) {
      this.stepPrompts.set(file, loadPrompt(`flows/${file}`));
    }
    return this.stepPrompts.get(file)!;
  }
}
