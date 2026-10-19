import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Tool } from './interface.js';
import {
  RESTART_EXIT_CODE,
  RESTART_CONTINUATION_MARKER,
  writeMarker,
  prepareShellRestart,
  serializeRestartContinuation,
  detectChannelBySessionId,
} from '../supervisor/protocol.js';

// ── 重启冒烟（与工具本体同文件：避免 tools 顶层文件互相 import 的层间耦合）──

export interface RestartSmokeResult {
  ok: boolean;
  /** 成功时是版本号；失败时是可读原因（含退出码/输出摘要） */
  detail: string;
}

/** 冒烟超时（ms）：正常 `--version` 在 1s 内返回；留足 cold start 余量 */
export const DEFAULT_RESTART_SMOKE_TIMEOUT_MS = 15_000;

/**
 * 用当前 node 运行入口的 `--version`，确认 dist 能加载、CLI 入口没被改坏。
 *
 * 为什么需要：restart 是 agent 自我改进的最后一跳。它此前只写会话快照就
 * exit(42)，如果 agent 刚把 dist 改坏，guardian 会原样拉起一个启动即崩的进程；
 * crash-loop 限流只能停手，不会回退。这里在 exit 前做**构建可加载性**冒烟：
 * 能捕获语法错误、缺失 import、入口初始化崩溃等“重启即砖”，但捕获不了行为回归。
 */
export function smokeTestEntry(
  entry: string,
  cwd: string,
  timeoutMs: number = DEFAULT_RESTART_SMOKE_TIMEOUT_MS,
): Promise<RestartSmokeResult> {
  if (!entry || !existsSync(entry)) {
    return Promise.resolve({ ok: false, detail: `entry not found: ${entry || '<empty>'}` });
  }

  return new Promise<RestartSmokeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout = '';
    let stderr = '';

    const finish = (result: RestartSmokeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry, '--version'], {
        cwd,
        // 避免子进程再走 guardian；--version 本身不触发重启
        env: { ...process.env, HYACINTH_RESTART_PREFLIGHT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ ok: false, detail: `spawn failed: ${(err as Error).message}` });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, detail: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + String(chunk)).slice(-4000);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on('error', (err) => {
      finish({ ok: false, detail: `spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      const version = stdout.trim();
      if (code === 0 && /\d+\.\d+\.\d+/.test(version)) {
        finish({ ok: true, detail: version.split('\n').at(-1)?.trim() ?? version });
        return;
      }
      finish({
        ok: false,
        detail:
          `exit ${code ?? 'null'}; stdout="${version.slice(0, 200)}"; ` +
          `stderr="${stderr.trim().slice(0, 300)}"`,
      });
    });
  });
}

export interface RestartToolOptions {
  /** 冒烟实现（测试注入；缺省用当前构建跑 `--version`） */
  smokeTest?: (entry: string, cwd: string) => Promise<RestartSmokeResult>;
  /** 退出实现（测试注入；缺省 process.exit） */
  exit?: (code: number) => void;
  /** 退出延迟（测试可设 0） */
  exitDelayMs?: number;
}

export class RestartTool implements Tool {
  readonly name = 'restart';
  readonly description =
    '重启 Agent 进程。当前会话自动持久化，重启后自动恢复。配置已保存，子进程优雅关闭。可选参数 message：如果提供，重启后自动发送此消息继续工作；不提供则等待用户输入。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: '可选。重启后会自动发送此消息以继续工作（如 "继续测试"）。省略则等待用户输入。',
      },
    },
  };

  constructor(
    private cwd: string,
    private sessionId?: string,
    private channel?: string,
    private options: RestartToolOptions = {},
  ) {}

  async execute(args: Record<string, unknown>): Promise<string> {
    // ── 重启前置：当前构建冒烟（防“改坏 dist 后 exit 42 → guardian 拉起即崩”）──
    // 失败直接抛错 → 工具层 is_error → 模型看到原因，不会真的安排重启。
    const entry = process.argv[1];
    const smoke = this.options.smokeTest ?? smokeTestEntry;
    const smokeResult = await smoke(entry ?? '', this.cwd);
    if (!smokeResult.ok) {
      throw new Error(
        `[restart] blocked: 当前构建未通过冒烟测试（${smokeResult.detail}）。` +
        '请先修复 build / dist（建议 pnpm build 或 verify_change），再重试 restart；本次未安排重启。',
      );
    }

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
      // v2 结构化落盘：带上触发重启时所在的渠道/会话，启动侧据此**定向注入** ——
      // 渠道优先取构造期注入的 this.channel，回退按 sessionId 反查渠道会话注册表。
      // 两者都拿不到 = 无渠道归属（纯 CLI），此时任何启动模式都可注入（v1 旧行为）。
      if (message) {
        writeMarker(RESTART_CONTINUATION_MARKER, serializeRestartContinuation({
          channel: this.channel ?? detectChannelBySessionId(this.sessionId),
          sessionId: this.sessionId,
          message,
          createdAt: new Date().toISOString(),
        }));
      }
    } catch {}

    const exit = this.options.exit ?? ((code: number) => process.exit(code));
    setTimeout(() => exit(RESTART_EXIT_CODE), this.options.exitDelayMs ?? 500);
    if (args.message) {
      return `Restarting... "${(args.message as string).slice(0, 60)}" will be executed after restart.`;
    }
    return 'Restarting... Session will be resumed.';
  }
}
