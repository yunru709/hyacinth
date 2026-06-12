/**
 * Spec 模式 — 三阶段，文件驱动。
 *
 * 文件: ~/.agent/specs/<slug>/spec.md | tasks.md | checklist.md
 * mode_mark 工具负责创建和标记，此模块只管理状态和注入。
 */

import type { ModeDefinition, ModeState } from './types.js';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface SpecData { task: string; phase: 'spec' | 'tasks' | 'checklist'; specDir: string; }

function getData(state: ModeState): SpecData {
  return state.data as unknown as SpecData;
}

function readFile(specDir: string, name: string): string {
  try { return fs.readFileSync(path.join(specDir, name), 'utf-8'); } catch { return ''; }
}

function parseSteps(content: string): Array<{ lineIdx: number; text: string; done: boolean }> {
  const steps: Array<{ lineIdx: number; text: string; done: boolean }> = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^- \[(.)\] (.+)/);
    if (m) steps.push({ lineIdx: steps.length, text: m[2].trim(), done: m[1] !== ' ' });
  }
  return steps;
}

export function createSpecMode(): ModeDefinition {
  return {
    name: 'spec',

    createState(params) {
      const task = String(params.task ?? '');
      const taskSlug = task.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').slice(0, 60) || 'spec';
      const specDir = path.join(os.homedir(), '.agent', 'specs', taskSlug);
      if (!fs.existsSync(specDir)) fs.mkdirSync(specDir, { recursive: true });
      return {
        name: 'spec',
        data: { task, phase: 'spec', specDir } as unknown as Record<string, unknown>,
      };
    },

    renderForInjection(state) {
      const { task, phase, specDir } = getData(state);
      const specContent = readFile(specDir, 'spec.md');

      // spec.md 是持久锚点，所有阶段注入
      const specAnchor = specContent
        ? `\n---\n## 规格文档 (spec.md)\n${specContent}\n---\n`
        : '\n(还未创建 spec.md — 调用 mode_mark init)\n';

      switch (phase) {
        case 'spec': {
          return renderPrompt(loadPrompt('modes/spec-phase1'), {
            task: task || '(未指定)', specDir,
          }) + specAnchor;
        }

        case 'tasks': {
          const rules = loadPrompt('modes/spec-tasks-rules');
          const tasksContent = readFile(specDir, 'tasks.md');
          const steps = parseSteps(tasksContent);
          const next = steps.find(s => !s.done);

          return specAnchor + '\n' + rules + '\n' + renderPrompt(loadPrompt('modes/spec-phase2'), {
            task: task || '',
            currentStep: next
              ? `🔄 当前: 步骤 ${steps.findIndex(s => !s.done) + 1} — ${next.text}`
              : (tasksContent ? '✅ 全部完成' : ''),
            progress: steps.map((s, i) => {
              const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
              return `  ${mark} [${i + 1}] ${s.text}`;
            }).join('\n'),
          });
        }

        case 'checklist': {
          const rules = loadPrompt('modes/spec-checklist-rules');
          const clContent = readFile(specDir, 'checklist.md');
          const steps = parseSteps(clContent);
          const next = steps.find(s => !s.done);

          return specAnchor + '\n' + rules + '\n' + renderPrompt(loadPrompt('modes/spec-phase3'), {
            task: task || '',
            currentStep: next
              ? `🔄 当前: 检查项 ${steps.findIndex(s => !s.done) + 1} — ${next.text}`
              : (clContent ? '✅ 全部验收完成' : ''),
            progress: steps.map((s, i) => {
              const mark = s.done ? '✅' : (s === next ? '🔄' : '⬜');
              return `  ${mark} [${i + 1}] ${s.text}`;
            }).join('\n'),
          });
        }

        default: return '';
      }
    },

    isComplete(state) {
      const { phase, specDir } = getData(state);
      if (phase !== 'checklist') return false;
      const content = readFile(specDir, 'checklist.md');
      if (!content.trim()) return false;
      const steps = parseSteps(content);
      return steps.length > 0 && steps.every(s => s.done);
    },
  };
}
