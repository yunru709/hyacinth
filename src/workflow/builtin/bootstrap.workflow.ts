/**
 * Bootstrap Workflow — 首次运行身份初始化
 *
 * 激活时机：bootstrapStatus === 'pending' 时自动激活。
 * 完成后调用 workflow({action:"step", stepAction:"complete"}) 结束。
 *
 * 复用 bootstrap.mode.ts 的核心逻辑。
 */

import type { WorkflowDefinition, WorkflowState } from '../types.js';
import { loadPrompt, renderPrompt } from '../../prompts/loader.js';
import {
  markBootstrapCompleteSync,
  validatePersonaFilesSync,
} from '../../setup/persona-bootstrap.js';

interface BootstrapData {
  personaDir: string;
  allDone: boolean;
  progress: string[];
}

function getData(state: WorkflowState): BootstrapData {
  return state.data as unknown as BootstrapData;
}

function formatValidationFailure(missing: string[], templateFiles: string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (templateFiles.length > 0) parts.push(`templates: ${templateFiles.join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : 'persona files are incomplete';
}

export function createBootstrapWorkflow(personaDir: string): WorkflowDefinition {
  return {
    name: 'bootstrap',
    description: '首次运行身份初始化 — 配置 Agent 的人设和记忆',
    source: 'builtin',
    relatedTools: ['write', 'read'],
    triggerKeywords: ['bootstrap', 'setup', 'identity', 'persona'],

    createState() {
      return {
        name: 'bootstrap',
        data: {
          personaDir,
          allDone: false,
          progress: [],
        } as unknown as Record<string, unknown>,
        steps: [],
        startedAt: new Date().toISOString(),
      };
    },

    handleStep(state, action) {
      const data = getData(state);

      if (action.action === 'note' || action.action === 'progress') {
        const message = action.message ?? 'Progress noted.';
        data.progress.push(message);
        return {
          newState: { ...state },
          result: {
            workflow: 'bootstrap',
            phase: 'collect',
            progress: data.progress.join('\n'),
            allDone: false,
          },
        };
      }

      if (action.action !== 'complete') return null;

      const validation = validatePersonaFilesSync(data.personaDir);
      let allDone = false;
      let progress = '';

      if (validation.complete) {
        markBootstrapCompleteSync(data.personaDir);
        data.allDone = true;
        allDone = true;
        progress = 'Bootstrap complete.';
      } else {
        progress = `Bootstrap incomplete: ${formatValidationFailure(validation.missing, validation.templateFiles)}`;
        data.progress.push(progress);
      }

      return {
        newState: { ...state },
        result: {
          workflow: 'bootstrap',
          phase: allDone ? 'complete' : 'collect',
          progress,
          allDone,
        },
      };
    },

    renderForInjection(state) {
      const data = getData(state);
      const template = loadPrompt('modes/bootstrap');
      const progress = data.progress.length > 0
        ? data.progress.join('\n')
        : '(no confirmed details yet)';
      return renderPrompt(template, { personaDir: data.personaDir, progress });
    },

    isComplete(state) {
      return getData(state).allDone;
    },

    onDeactivate() {},
  };
}
