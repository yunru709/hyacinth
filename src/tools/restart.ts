import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from './interface.js';

const RESTART_EXIT_CODE = 42;
const RESTART_FILE = '.agent/.restart-session';

export class RestartTool implements Tool {
  readonly name = 'restart';
  readonly description =
    'Restart the Agent process. The current session is persisted and resumed automatically after restart. ' +
    'Config is saved, child processes are stopped gracefully.';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  };

  constructor(private cwd: string) {}

  async execute(_args: Record<string, unknown>): Promise<string> {
    // 写入重启标记文件，包含当前 session 目录名
    try {
      mkdirSync(join(this.cwd, '.agent'), { recursive: true });
      // sessionDir 的尾段就是 session ID
      // 我们在 factory/CLI 层注入 cwd，工具本身不持有 sessionDir
      // 但我们可以写一个标记文件告诉 guardian 使用 --continue
      writeFileSync(join(this.cwd, RESTART_FILE), 'true', 'utf-8');
    } catch {}
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    return 'Restarting... Session will be resumed.';
  }
}
