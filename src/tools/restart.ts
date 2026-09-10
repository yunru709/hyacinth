import type { Tool } from './interface.js';
import {
  RESTART_EXIT_CODE,
  RESTART_CONTINUATION_MARKER,
  writeMarker,
  prepareShellRestart,
} from '../supervisor/protocol.js';

export class RestartTool implements Tool {
  readonly name = 'restart';
  readonly description =
    '重启 Agent 进程。当前会话自动持久化，重启后自动恢复。配置已保存，子进程优雅关闭。可选参数 message：如果提供，重启后自动发送此消息继续工作；不提供则等待用户输入。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Optional. After restart, this message will be automatically sent to continue working (e.g. "继续测试"). Omit to wait for user input.',
      },
    },
  };

  constructor(
    private cwd: string,
    private sessionId?: string,
    private channel?: string,
  ) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    try {
      // 会话快照 + 重启原因存档走协议层 prepareShellRestart —— 与壳层兜底
      // 重启（插件热更新失败 44）同一封装，保证各重启路径恢复行为一致。
      const message = args.message as string | undefined;
      prepareShellRestart({
        code: RESTART_EXIT_CODE,
        source: 'restart-tool',
        ...(message ? { detail: message.slice(0, 120) } : {}),
      });

      // 如果传了 message，保存续工指令
      if (message) {
        writeMarker(RESTART_CONTINUATION_MARKER, message);
      }
    } catch {}

    setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    if (args.message) {
      return `Restarting... "${(args.message as string).slice(0, 60)}" will be executed after restart.`;
    }
    return 'Restarting... Session will be resumed.';
  }
}
