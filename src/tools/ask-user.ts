// ============================================================
// ask_user — 向用户展示交互式多问题表单
// ============================================================

import type { Tool } from './interface.js';
import type { AskUserQuestion } from '../orchestrator/loop.js';

export type { AskUserQuestion } from '../orchestrator/loop.js';

/** 工具依赖：调用 OutputHandler.onAskUser 的函数 */
export type AskUserFn = (questions: AskUserQuestion[]) => Promise<string>;

let askUserHandler: AskUserFn | null = null;

/** TUI 启动后由 tui.ts 调用，将 onAskUser 的实现注入到工具中 */
export function setAskUserHandler(handler: AskUserFn): void {
  askUserHandler = handler;
}

export function createAskUserTool(): Tool {
  return {
    name: 'ask_user',
    description:
      '暂停执行，向用户展示交互式问题表单。支持多问题、多选选项和自定义文本输入。适用于需要澄清需求、收集偏好或确认选项后再继续的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to ask the user',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question text to display',
              },
              header: {
                type: 'string',
                description: 'Optional short label for the tab (max 12 chars)',
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Available choices (empty = custom text input only)',
              },
              multiSelect: {
                type: 'boolean',
                description: 'Allow selecting multiple options (default: false = single choice)',
              },
              customInput: {
                type: 'boolean',
                description: 'Show a free-text input below the options',
              },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const questions = (args.questions as AskUserQuestion[]) ?? [];
      if (!questions || questions.length === 0) {
        return JSON.stringify({ error: 'No questions provided.' });
      }
      if (!askUserHandler) {
        return JSON.stringify({ error: 'Ask user handler not connected (TUI not active).' });
      }
      return askUserHandler(questions);
    },
  };
}
