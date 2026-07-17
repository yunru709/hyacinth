// ============================================================
// SpecFlow — 需求规格 → 执行 → 验证 Flow
// ============================================================
//
// 三阶段：
//   1. define            — 一份提示词，同时写出 spec.md + tasks.md + checklist.md
//   2. executing_tasks    — 逐条解析 tasks.md 的 - [ ]，注入 → 标记 [x] → 推进
//   3. executing_checklist — 逐条解析 checklist.md 的 - [ ]，注入 → 标记 [x] → 推进
//
// Guard 通过解析文件中的 [ ]/[x] 状态判断是否全部完成。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MachineContext, MachineDef, MachineSnapshot, AdvanceResult } from '../types.js';
import { MachineRunner } from '../runner.js';
import type { FlowController } from './types.js';
import { loadPrompt } from '../../prompts/loader.js';

// ── 文件解析 ────────────────────────────────────────────────

interface CheckItem {
  line: string;
  checked: boolean;
}

/** 解析 markdown 中的 - [ ] / - [x] 条目 */
function parseCheckItems(filePath: string): CheckItem[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const items: CheckItem[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
        items.push({ line: trimmed, checked: true });
      } else if (trimmed.startsWith('- [ ]')) {
        items.push({ line: trimmed, checked: false });
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** 获取 spec 目录路径 */
function specDir(ctx: MachineContext): string {
  return (ctx.specDir as string) || path.join(process.cwd(), '.agent', 'specs', (ctx.task as string) || 'unknown');
}

/** 从 tasks/checklist 抽取条目列表（给 getInjection 用） */
function formatItemList(items: CheckItem[]): string {
  return items.map((it, i) => {
    const marker = it.checked ? '[x]' : '[ ]';
    return `${i + 1}. ${marker} ${it.line.replace(/^-\s*\[.\]\s*/, '')}`;
  }).join('\n');
}

/** 找第一个未完成的条目 */
function firstUnchecked(items: CheckItem[]): string {
  const item = items.find(it => !it.checked);
  return item ? item.line.replace(/^-\s*\[.\]\s*/, '') : '';
}

// ── MachineDef ──────────────────────────────────────────────

function createSpecMachineDef(): MachineDef {
  return {
    id: 'spec',
    initial: 'define',
    states: {
      define:               { label: '撰写文档' },
      executing_tasks:      { label: '执行任务' },
      executing_checklist:  { label: '验收检查' },
      __completed__:        { label: '已完成' },
    },
    transitions: [
      // define → executing_tasks
      { from: 'define', to: 'executing_tasks', event: 'flow_complete' },

      // executing_tasks → executing_tasks（还有未完成任务）
      {
        from: 'executing_tasks', to: 'executing_tasks', event: 'flow_complete',
        guard: (ctx) => {
          const items = parseCheckItems(path.join(specDir(ctx), 'tasks.md'));
          return { ok: items.some(i => !i.checked), reason: 'All tasks completed — moving to checklist verification.' };
        },
      },
      // executing_tasks → executing_checklist（全部完成）
      {
        from: 'executing_tasks', to: 'executing_checklist', event: 'flow_complete',
        guard: (ctx) => {
          const items = parseCheckItems(path.join(specDir(ctx), 'tasks.md'));
          return { ok: items.length > 0 && items.every(i => i.checked) };
        },
      },

      // executing_checklist → executing_checklist（还有未验证项）
      {
        from: 'executing_checklist', to: 'executing_checklist', event: 'flow_complete',
        guard: (ctx) => {
          const items = parseCheckItems(path.join(specDir(ctx), 'checklist.md'));
          return { ok: items.some(i => !i.checked), reason: 'All checklist items verified — flow complete.' };
        },
      },
      // executing_checklist → __completed__（全部验证通过）
      {
        from: 'executing_checklist', to: '__completed__', event: 'flow_complete',
        guard: (ctx) => {
          const items = parseCheckItems(path.join(specDir(ctx), 'checklist.md'));
          return { ok: items.length > 0 && items.every(i => i.checked) };
        },
      },
    ],
    terminalStates: ['__completed__'],
  };
}

// ── SpecFlow ─────────────────────────────────────────────────

export class SpecFlow implements FlowController {
  readonly id = 'spec';
  readonly runner: MachineRunner;

  private prompts = new Map<string, string>();

  constructor() {
    this.runner = new MachineRunner(createSpecMachineDef());
  }

  // ── 生命周期 ──────────────────────────────────────────────

  activate(context?: MachineContext): void {
    const task = (context?.task as string) ?? '';
    const dir = path.join(process.cwd(), '.agent', 'specs', task.replace(/[<>:"/\\|?*]/g, '-'));
    this.runner.activate({ task, specDir: dir });
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

    const dir = specDir(snap.context as MachineContext);
    const task = (snap.context.task as string) || '';

    switch (snap.currentState) {
      case 'define': {
        const prompt = this.loadPrompt('spec-define')
          .replace(/\{\{task\}\}/g, task)
          .replace(/\{\{specDir\}\}/g, dir);
        return `\n[Spec: 撰写文档]\n${prompt}`;
      }

      case 'executing_tasks': {
        const items = parseCheckItems(path.join(dir, 'tasks.md'));
        const current = firstUnchecked(items);
        const list = formatItemList(items);
        const prompt = this.loadPrompt('spec-executing-tasks')
          .replace(/\{\{task\}\}/g, task)
          .replace(/\{\{item_list\}\}/g, list)
          .replace(/\{\{current_item\}\}/g, current || '(all done)');
        const done = items.filter(i => i.checked).length;
        return `\n[Spec: 执行任务 ${done}/${items.length}]\n${prompt}`;
      }

      case 'executing_checklist': {
        const items = parseCheckItems(path.join(dir, 'checklist.md'));
        const current = firstUnchecked(items);
        const list = formatItemList(items);
        const prompt = this.loadPrompt('spec-executing-checklist')
          .replace(/\{\{task\}\}/g, task)
          .replace(/\{\{item_list\}\}/g, list)
          .replace(/\{\{current_item\}\}/g, current || '(all done)');
        const done = items.filter(i => i.checked).length;
        return `\n[Spec: 验收检查 ${done}/${items.length}]\n${prompt}`;
      }

      default:
        return null;
    }
  }

  // ── 内部 ──────────────────────────────────────────────────

  private loadPrompt(file: string): string {
    if (!this.prompts.has(file)) {
      this.prompts.set(file, loadPrompt(`flows/${file}`));
    }
    return this.prompts.get(file)!;
  }
}
