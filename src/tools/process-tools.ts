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
      '列出所有通过 bash(async:true) 启动的后台进程。返回句柄、PID、ALIVE（实时存活探测）、'
      + '状态、REMAIN（距超时还剩秒数）、输出缓冲区大小。'
      + '注意：Windows 下 PID 是 shell 的 PID 且会被 OS 复用，判断"还在不在跑"请以 ALIVE 列为准。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<string> {
      const processes = registry.list();
      if (processes.length === 0) return '(no background processes)';

      const lines: string[] = [];
      lines.push(
        `${'HANDLE'.padEnd(8)} ${'PID'.padEnd(7)} ${'ALIVE'.padEnd(6)} ${'STATUS'.padEnd(8)} `
        + `${'REMAIN'.padEnd(8)} ${'OUTPUT'.padEnd(10)} COMMAND`,
      );
      lines.push('-'.repeat(100));
      for (const p of processes) {
        const handle = p.handle.padEnd(8);
        const pid = String(p.pid ?? '?').padEnd(7);
        // ★ ALIVE：实时存活探测结果。单独一列，因为 pid 本身不足以下判断（见工具描述）：
        //   曾出现"两个句柄显示同一个 PID、而真正在跑的是另一个 PID"，据此误判成"没启动"。
        const alive = (p.status === 'running' ? (p.alive ? 'yes' : 'NO') : '-').padEnd(6);
        // 带上停止原因（如 timeout after 600s）：否则"进程停了我不知道为什么"，
        // 长跑监控场景下无法区分"死了"和"闲着"。
        const statusText = p.stoppedReason ? `${p.status}(${p.stoppedReason})` : p.status;
        const status = statusText.padEnd(8);
        // ★ REMAIN：距超时还剩多少秒。长跑时靠它提前决定"缩规模还是等"，
        //   而不是等 watchdog 静默杀掉之后、靠数落盘文件反推已完成几个 run。
        const remain = (p.remainingSec === null ? '-' : `${p.remainingSec}s`).padEnd(8);
        const output = `${p.outputSize} lines`.padEnd(10);
        const dup = p.duplicateOf ? `  <== DUPLICATE of ${p.duplicateOf}` : '';
        lines.push(`${handle} ${pid} ${alive} ${status} ${remain} ${output} ${p.command}${dup}`);
      }
      const dupes = processes.filter((p) => p.duplicateOf !== undefined);
      if (dupes.length > 0) {
        lines.push('');
        lines.push(`WARNING 同命令重复启动: ${dupes.map((p) => `${p.handle} -> ${p.duplicateOf}`).join(', ')}`);
        lines.push('  两份副本的产物逐位相同 ==> 汇总前必须按 (arm, seed) 去重，否则会被当成独立样本。');
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
      '终止指定句柄的后台进程（如 "bg_001"）。杀死整个进程树。先用 process_list 查看可用句柄。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: '后台进程句柄（如 "bg_001"）。可通过 process_list 获取。',
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
      '读取后台进程已捕获的 stdout/stderr 输出。最多返回缓冲区中 1000 行。先用 process_list 查看可用句柄。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: '后台进程句柄（如 "bg_001"）。可通过 process_list 获取。',
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
      const maxChars = 200_000; // ToolResultBuffer handles context protection
      if (output.length > maxChars) {
        return `${header}\n${output.slice(0, maxChars)}\n\n[Output truncated: ${output.length - maxChars} more characters]`;
      }
      return `${header}\n${output}`;
    },
  };
}
