/**
 * Plan 模式 — 文件驱动。
 *
 * 文件唯一真相源：~/.agent/plans/<slug>/plan.md
 * mode_mark 工具负责创建和标记，此模块只管理状态和注入。
 */

import type { ModeDefinition, ModeState } from './types.js';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface PlanData { task: string; planDir: string; }

function getData(state: ModeState): PlanData {
  return state.data as unknown as PlanData;
}

function readPlanFile(planDir: string): string {
  try { return fs.readFileSync(path.join(planDir, 'plan.md'), 'utf-8'); } catch { return ''; }
}

function parseSteps(content: string): Array<{ lineIdx: number; text: string; done: boolean }> {
  const steps: Array<{ lineIdx: number; text: string; done: boolean }> = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[(.)\] (.+)/);
    if (m) steps.push({ lineIdx: steps.length, text: m[2].trim(), done: m[1] !== ' ' });
  }
  return steps;
}

export function createPlanMode(): ModeDefinition {
  return {
    name: 'plan',

    createState(params) {
      const task = String(params.task ?? '');
      const taskSlug = task.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').slice(0, 60) || 'plan';
      const planDir = path.join(os.homedir(), '.agent', 'plans', taskSlug);
      if (!fs.existsSync(planDir)) fs.mkdirSync(planDir, { recursive: true });
      return {
        name: 'plan',
        data: { task, planDir } as unknown as Record<string, unknown>,
      };
    },

    renderForInjection(state) {
      const { task, planDir } = getData(state);
      const content = readPlanFile(planDir);
      const steps = parseSteps(content);
      const next = steps.find(s => !s.done);

      const planPath = path.join(planDir, 'plan.md');
      const template = loadPrompt('modes/plan');
      return renderPrompt(template, {
        task: task || '(未指定)',
        planPath,
        content: content || '(尚未创建 — 调用 mode_mark({action:"init", content: plan 全文}))',
        currentStep: next ? `🔄 当前: 步骤 ${steps.findIndex(s => !s.done) + 1} — ${next.text}` : (content ? '✅ 全部完成' : ''),
        progress: steps.map((s, i) => {
          const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
          return `  ${mark} [${i + 1}] ${s.text}`;
        }).join('\n'),
      });
    },

    isComplete(state) {
      const content = readPlanFile(getData(state).planDir);
      if (!content.trim()) return false;
      const steps = parseSteps(content);
      return steps.length > 0 && steps.every(s => s.done);
    },
  };
}
