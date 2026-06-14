/**
 * 后台进程管理工具 — process_list / process_kill / process_output
 *
 * 这些工具供模型控制由 bash(async: true) 启动的后台进程。
 * 所有工具通过 BackgroundProcessRegistry 操作，保持安全管理。
 */
import type { Tool } from './interface.js';
import type { BackgroundProcessRegistry } from './background-registry.js';

/** 创建 process_list 工具：列出所有后台进程 */
export function createProcessListTool(registry: BackgroundProcessRegistry): Tool {
  return {
    name: 'process_list',
    description:
      'List all background processes started with bash(async:true). ' +
      'Returns handle, command, PID, status (running/stopped/crashed), start time, and output buffer size for each.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<string> {
      const processes = registry.list();
      if (processes.length === 0) return '(no background processes)';

      const lines: string[] = [];
      lines.push(`${'HANDLE'.padEnd(8)} ${'PID'.padEnd(8)} ${'STATUS'.padEnd(8)} ${'OUTPUT'.padEnd(8)} COMMAND`);
      lines.push('-'.repeat(80));
      for (const p of processes) {
        const handle = p.handle.padEnd(8);
        const pid = String(p.pid ?? '?').padEnd(8);
        const status = p.status.padEnd(8);
        const output = `${p.outputSize} lines`.padEnd(8);
        lines.push(`${handle} ${pid} ${status} ${output} ${p.command}`);
      }
      return lines.join('\n');
    },
  };
}

/** 创建 process_kill 工具：停止指定后台进程 */
export function createProcessKillTool(registry: BackgroundProcessRegistry): Tool {
  return {
    name: 'process_kill',
    description:
      'Stop a background process by its handle (e.g. "bg_001"). ' +
      'Kills the process tree. Use process_list to see available handles.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'The background process handle (e.g. "bg_001"). Get from process_list.',
        },
      },
      required: ['handle'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const handle = args.handle as string;
      if (!handle) return 'Error: "handle" parameter is required.';

      const killed = await registry.kill(handle);
      if (killed) return `Process ${handle} stopped.`;
      return `No process found for handle: ${handle}`;
    },
  };
}

/** 创建 process_output 工具：读取后台进程输出 */
export function createProcessOutputTool(registry: BackgroundProcessRegistry): Tool {
  return {
    name: 'process_output',
    description:
      'Read the captured stdout/stderr output of a background process. ' +
      'Returns up to 1000 lines of buffered output. Use process_list to see available handles.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: 'The background process handle (e.g. "bg_001"). Get from process_list.',
        },
      },
      required: ['handle'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const handle = args.handle as string;
      if (!handle) return 'Error: "handle" parameter is required.';

      const status = registry.getStatus(handle);
      if (!status) {
        return `No process found for handle: ${handle}. Use process_list to see running processes.`;
      }

      const output = registry.getOutput(handle);
      const header = `[${handle}] PID ${status.pid ?? '?'} | ${status.status} | started ${status.startTime}`;

      if (!output || output === '(no output yet)') {
        return `${header}\n(no output captured yet — process may still be starting)`;
      }

      // 截断过长的输出
      const maxChars = 8000;
      if (output.length > maxChars) {
        return `${header}\n${output.slice(0, maxChars)}\n\n[Output truncated: ${output.length - maxChars} more characters]`;
      }
      return `${header}\n${output}`;
    },
  };
}
