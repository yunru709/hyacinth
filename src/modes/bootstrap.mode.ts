/**
 * Bootstrap Mode.
 *
 * Global first-run identity setup. Unlike plan/spec/todo, this mode is
 * activated by global persona state and completes only after persona files pass
 * validation.
 */

import type { ModeDefinition, ModeState, TaskMarkParams, TaskMarkResult } from './types.js';
import { loadPrompt, renderPrompt } from '../prompts/loader.js';
import {
  markBootstrapCompleteSync,
  validatePersonaFilesSync,
} from '../setup/persona-bootstrap.js';

interface BootstrapData {
  personaDir: string;
  allDone: boolean;
  progress: string[];
}

function getData(state: ModeState): BootstrapData {
  return state.data as unknown as BootstrapData;
}

function setData(state: ModeState, data: BootstrapData): ModeState {
  return { ...state, data: data as unknown as Record<string, unknown> };
}

function formatValidationFailure(missing: string[], templateFiles: string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (templateFiles.length > 0) parts.push(`templates: ${templateFiles.join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : 'persona files are incomplete';
}

export function createBootstrapMode(personaDir: string): ModeDefinition {
  return {
    name: 'bootstrap',

    createState() {
      return {
        name: 'bootstrap',
        data: {
          personaDir,
          allDone: false,
          progress: [],
        } as unknown as Record<string, unknown>,
      };
    },

    handleToolCall(state, action, params: TaskMarkParams) {
      const data = getData(state);

      if (action === 'progress' || action === 'note') {
        const message = params.message ?? 'Progress noted.';
        data.progress.push(message);
        const result: TaskMarkResult = {
          mode: 'bootstrap',
          phase: 'collect',
          progress: data.progress.join('\n'),
          allDone: false,
        };
        return { newState: setData(state, data), result };
      }

      if (action !== 'complete') return null;

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

      const result: TaskMarkResult = {
        mode: 'bootstrap',
        phase: allDone ? 'complete' : 'collect',
        progress,
        allDone,
      };
      return { newState: setData(state, data), result };
    },

    renderForInjection(state) {
      const data = getData(state);
      const template = loadPrompt('modes/bootstrap');
      const progress = data.progress.length > 0 ? data.progress.join('\n') : '(no confirmed details yet)';
      return renderPrompt(template, { personaDir: data.personaDir, progress });
    },

    isComplete(state) {
      return getData(state).allDone;
    },

    onDeactivate() {},
  };
}
