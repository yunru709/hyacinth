import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './interface.js';

const RESTART_EXIT_CODE = 42;
const RESTART_FILE = '.agent/.restart-session';
const CONTINUATION_FILE = '.agent/.restart-continuation';

export class RestartTool implements Tool {
  readonly name = 'restart';
  readonly description =
    'Restart the Agent process. The current session is persisted and resumed automatically after restart. ' +
    'Config is saved, child processes are stopped gracefully.\n' +
    'Optional parameter "message": if provided, this message will be automatically sent after restart to continue work. ' +
    'If omitted, the agent will wait for user input after restart.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Optional. After restart, this message will be automatically sent to continue working (e.g. "继续测试"). Omit to wait for user input.',
      },
    },
  };

  constructor(private cwd: string) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    const agentDir = join(homedir(), '.agent');
    try {
      mkdirSync(agentDir, { recursive: true });
      // 标记文件告诉 guardian 使用 --continue
      writeFileSync(join(agentDir, '.restart-session'), 'true', 'utf-8');

      // 如果传了 message，保存续工指令
      const message = args.message as string | undefined;
      if (message) {
        writeFileSync(join(agentDir, '.restart-continuation'), message, 'utf-8');
      }
    } catch {}

    setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    if (args.message) {
      return `Restarting... "${(args.message as string).slice(0, 60)}" will be executed after restart.`;
    }
    return 'Restarting... Session will be resumed.';
  }
}
