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
    const agentDir = join(homedir(), '.agent');
    try {
      mkdirSync(agentDir, { recursive: true });
      // 标记文件告诉 guardian 使用 --continue。
      // 格式：优先读取全局渠道 Session 注册表（__channelSessionRegistry），
      // 注册表存的是「getter」，调用它获取各渠道当前的 sessionId（实时反映切换），
      // 把「渠道 → sessionId」映射序列化为 JSON 写入，重启后按启动渠道恢复各自 session，
      // 避免多渠道共享进程时（TUI + 飞书）重启串 session。
      // 若无注册表/为空，退化为 'true'（继续最近）。
      const sessionRegistry = (globalThis as any).__channelSessionRegistry as Map<string, () => string> | undefined;
      let marker = 'true';
      if (sessionRegistry && sessionRegistry.size > 0) {
        const snapshot: Record<string, string> = {};
        for (const [channel, getter] of sessionRegistry) {
          try {
            const sid = getter();
            // 过滤伪 session（'__shared__' / 'feishu_default' 等无真实目录的虚拟会话）
            if (channel && sid && sid !== '__shared__' && !sid.endsWith('_default')) {
              snapshot[channel] = sid;
            }
          } catch { /* 单渠道 getter 失败不影响整体快照 */ }
        }
        if (Object.keys(snapshot).length > 0) {
          marker = JSON.stringify(snapshot);
        }
      }
      writeFileSync(join(agentDir, '.restart-session'), marker, 'utf-8');

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
