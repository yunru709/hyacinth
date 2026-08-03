import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from './interface.js';
import type { BackgroundProcessRegistry } from './background-registry.js';

/** 沙箱配置接口 — 限制 BashTool 可执行的命令 */
export interface SandboxConfig {
  /** @deprecated 路径白名单已废弃，不再限制工作目录 */
  allowedPaths?: string[];
  /** 危险命令黑名单（大小写不敏感子串匹配） */
  blockedCommands: string[];
  /** 最大输出字节数，默认 1MB */
  maxOutputBytes?: number;
}

/** 默认的危险命令黑名单（子串匹配） */
const DEFAULT_BLOCKED_COMMANDS: string[] = [
  'rm -rf /',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'del /f /s /q C:',
];

/** 词边界正则黑名单 — 匹配独立危险命令。
 *  (?!-) 确保 format 不误杀 PowerShell 的 Format-List/Format-Table/Format-Hex 等 cmdlet */
const BLOCKED_COMMAND_REGEX: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bformat\b(?!-)/i, label: 'format' },
];

/**
 * 如果命令是 `powershell -Command "..."` 包装，取出内部脚本。
 * spawnWindows 已通过 -File 在 PowerShell 中执行，嵌套的 powershell
 * 会重新引入 cmd.exe 包装层，破坏 $_ / 管道 / 重定向。
 *
 * 不靠枚举标志名的正则——只找 -Command/-c 分隔点，拿到后面的内容即可。
 */
function unwrapPsCommand(command: string): string {
  const lc = command.toLowerCase();
  // 只处理以 powershell 开头的命令行
  if (!lc.startsWith('powershell')) return command;

  // 找 -Command 或 -c（必须是独立参数，不能是 -CustomFlag 的一部分）
  const cmdIdx = lc.search(/\s-(?:command|c)\b/i);
  if (cmdIdx === -1) {
    // 没有 -Command 标志，可能是裸 powershell 调用，
    // 整个 command 就是脚本内容 — 但 powershell 本身不是有效 PS 脚本，
    // 把整个字符串当 PS 代码执行（PS 会报语法错），也算合理。
    return command;
  }

  let script = command.slice(cmdIdx).trim().replace(/^-(?:command|c)\s*/i, '').trim();

  // 去掉外层引号
  if ((script.startsWith('"') && script.endsWith('"')) ||
      (script.startsWith("'") && script.endsWith("'"))) {
    script = script.slice(1, -1);
  }

  return script || command;
}

/**
 * Windows: 将命令写入临时 .ps1 文件，通过 `powershell -File` 直接执行。
 *
 * 绕过了 spawn({ shell: true }) 的 cmd.exe 包装层，命令原文直达 PowerShell。
 */
function spawnWindows(command: string, cwd: string, env: NodeJS.ProcessEnv, opts: {
  timeout: number;
  signal?: AbortSignal;
  detached: boolean;
  stdin: 'ignore' | 'pipe';
}): ReturnType<typeof spawn> {
  // 剥掉可能的 powershell -Command "..." 外壳，避免嵌套调用
  const script = unwrapPsCommand(command);
  // 写临时 .ps1 文件，UTF-8 with BOM（PowerShell -File 靠 BOM 识别编码）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ps-'));
  const psFile = path.join(tmpDir, 'script.ps1');
  // BOM + 编码设置：确保 PS 解析和外部命令都走 UTF-8
  const preamble = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '[Console]::InputEncoding  = [Text.Encoding]::UTF8',
    '$OutputEncoding = [Text.Encoding]::UTF8',
    // 关键修复：PS 5.1 的 Get-Content/Select-String 默认按 ANSI(GB2312) 解码
    // 无 BOM 的 UTF-8 文件导致中文乱码。用 PSDefaultParameterValues 强制读取走 UTF-8。
    '$PSDefaultParameterValues["Get-Content:Encoding"] = "utf8"',
    '$PSDefaultParameterValues["Select-String:Encoding"] = "utf8"',
    'chcp 65001 > $null',       // 让 cmd.exe / 外部命令也走 UTF-8
  ].join('\n');
  fs.writeFileSync(psFile, '﻿' + preamble + '\n' + script + '\n', 'utf-8');

  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', psFile,
  ], {
    cwd,
    env,
    detached: opts.detached,
    stdio: [opts.stdin, 'pipe', 'pipe'],
    // shell: false — 不经过 cmd.exe，直接创建 powershell 进程
    windowsHide: true,
  });

  // 子进程退出后清理临时目录
  child.on('close', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
  child.on('error', () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  return child;
}

/**
 * BashTool — 在子进程中执行命令
 *
 * 参数：
 * - command (必需): 要执行的命令
 * - timeout (可选): 超时时间（秒），默认 600
 * - env (可选): 环境变量映射，会自动持久化到后续调用
 *
 * 平台适配：
 * - Windows: 命令写入临时 .ps1 文件，powershell -File 直接执行
 * - Linux/macOS: 使用 /bin/sh 执行
 *
 * 返回 stdout + stderr，超时后终止进程树
 * 工作目录为当前 Agent 的工作目录
 */
export class BashTool implements Tool {
  readonly name = 'bash';
  readonly description =
    '执行 Shell 命令并返回 stdout/stderr。Windows 下原生运行在 PowerShell —— 不要加 "powershell -Command" 前缀。Linux/macOS 下运行在 /bin/sh。async=true 时以后台进程方式执行，返回进程句柄，可通过 process_list / process_output / process_kill 管理。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Default is 600. Applies to both sync and async execution.',
      },
      env: {
        type: 'object',
        description: 'Environment variables to set for this command. These persist across subsequent bash calls in this session. Example: {"PYTHONIOENCODING": "utf-8"}',
      },
      async: {
        type: 'boolean',
        description: 'If true, run the command as a background process. Returns a handle immediately (e.g. [background:bg_001]). The process continues running and can be managed with process_list/process_output/process_kill.',
      },
    },
    required: ['command'],
  };
  readonly executionMode = 'asyncable';

  private cwd: string;
  private sandboxConfig: SandboxConfig;
  private persistentEnv: Record<string, string>;
  private backgroundRegistry?: BackgroundProcessRegistry;
  private allowAsync = true;

  constructor(cwd?: string, sandboxConfig?: SandboxConfig) {
    this.cwd = cwd ?? process.cwd();
    this.sandboxConfig = sandboxConfig ?? {
      blockedCommands: DEFAULT_BLOCKED_COMMANDS,
    };
    this.persistentEnv = {};
  }

  /** 更新工作目录 */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** 运行时更新沙箱配置 */
  setSandboxConfig(config: SandboxConfig): void {
    this.sandboxConfig = config;
  }

  /** 注入后台进程注册表（用于 async 模式） */
  setBackgroundRegistry(registry: BackgroundProcessRegistry): void {
    this.backgroundRegistry = registry;
  }

  /** 是否允许 async 模式（默认 true，可通过 tools.allowAsync 配置关闭） */
  setAllowAsync(allow: boolean): void {
    this.allowAsync = allow;
  }

  /** 获取当前沙箱配置（只读） */
  getSandboxConfig(): Readonly<SandboxConfig> {
    return this.sandboxConfig;
  }

  /**
   * 杀死进程树
   * - Windows: 使用 taskkill /T /F /PID
   * - Unix: 使用 process.kill(-pid) 杀进程组
   */
  private killProcessTree(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 进程已退出，忽略
      }
    }
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const command = args.command as string;
    if (!command) return '错误：缺少 command 参数。请提供要执行的命令。';
    const timeout = (args.timeout as number | undefined) ?? 600;
    const callEnv = (args.env as Record<string, string>) ?? {};
    const runAsync = args.async === true;

    // 持久化本次调用指定的环境变量
    for (const [key, value] of Object.entries(callEnv)) {
      this.persistentEnv[key] = value;
    }

    // 沙箱拦截：检查危险命令黑名单（子串匹配）
    const commandLower = command.toLowerCase();
    for (const blocked of this.sandboxConfig.blockedCommands) {
      if (commandLower.includes(blocked.toLowerCase())) {
        throw new Error(`Command blocked by sandbox: contains blocked pattern "${blocked}"`);
      }
    }

    // 沙箱拦截：词边界正则匹配
    for (const { pattern, label } of BLOCKED_COMMAND_REGEX) {
      if (pattern.test(command)) {
        throw new Error(`Command blocked by sandbox: contains blocked command "${label}"`);
      }
    }

    // 沙箱路径白名单已废弃 — 不再限制 cd 目标和工作目录，由 LLM 自行约束
    // （保留注释以供将来可能需要恢复时参考）
    // if (this.sandboxConfig.allowedPaths?.length) {
    //   const cdMatch = commandLower.match(/(?:^|\s|&&|\|{1,2}|;)\s*cd\s+([^\s;&|]+)/);
    //   if (cdMatch) {
    //     const targetPath = path.resolve(this.cwd, cdMatch[1]);
    //     const isAllowed = this.sandboxConfig.allowedPaths.some(
    //       (allowed) => targetPath.startsWith(path.resolve(allowed)),
    //     );
    //     if (!isAllowed) {
    //       return `Error: Directory "${cdMatch[1]}" is outside allowed paths. Blocked by sandbox.`;
    //     }
    //   }
    // }
    // if (this.sandboxConfig.allowedPaths?.length) {
    //   const cwdAllowed = this.sandboxConfig.allowedPaths.some(
    //     (p) => this.cwd === p || this.cwd.startsWith(p + (os.platform() === 'win32' ? '\\' : '/')),
    //   );
    //   if (!cwdAllowed) {
    //     throw new Error(
    //       `Command blocked by sandbox: working directory "${this.cwd}" is not in allowed paths`,
    //     );
    //   }
    // }

    const isWin = process.platform === 'win32';

    // 构建环境变量
    const mergedEnv: Record<string, string | undefined> = { ...process.env };
    if (isWin) {
      mergedEnv.PYTHONIOENCODING = mergedEnv.PYTHONIOENCODING ?? 'utf-8';
      mergedEnv.PYTHONUTF8 = mergedEnv.PYTHONUTF8 ?? '1';
    }
    for (const [key, value] of Object.entries(this.persistentEnv)) {
      mergedEnv[key] = value;
    }

    // ── 异步执行路径 ──
    if (runAsync) {
      if (!this.allowAsync) {
        return 'Error: Async execution is disabled (tools.allowAsync = false). Run the command synchronously by omitting the "async" parameter.';
      }
      if (!this.backgroundRegistry) {
        return 'Error: BackgroundProcessRegistry not available. Cannot run async commands.';
      }

      const childProcess = isWin
        ? spawnWindows(command, this.cwd, mergedEnv as NodeJS.ProcessEnv, {
            timeout,
            signal,
            detached: false,
            stdin: 'ignore',
          })
        : spawn(command, [], {
            cwd: this.cwd,
            shell: '/bin/sh',
            env: mergedEnv as NodeJS.ProcessEnv,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      const handle = this.backgroundRegistry.register('bash', command, childProcess);
      const pid = childProcess.pid ?? '?';

      // 超时自动终止（和同步路径一致）
      const timeoutMs = timeout * 1000;
      const timer = setTimeout(() => {
        if (childProcess.pid) {
          this.killProcessTree(childProcess.pid);
        }
        this.backgroundRegistry?.kill(handle);
      }, timeoutMs);
      // 子进程正常退出时清除定时器，避免重复 kill
      childProcess.on('exit', () => clearTimeout(timer));

      return `[background:${handle}] PID ${pid}\nCommand: ${command}\n\nUse process_output("${handle}") to read output, process_kill("${handle}") to stop.`;
    }

    // ── 同步执行路径 ──

    // 输出截断配置
    const MAX_OUTPUT_BYTES = this.sandboxConfig.maxOutputBytes ?? 500 * 1024;
    const LIMIT_KB = Math.round(MAX_OUTPUT_BYTES / 1024);
    let outputSize = 0;
    let truncated = false;

    return new Promise<string>((resolve, reject) => {
      const startTime = Date.now();

      const childProcess = isWin
        ? spawnWindows(command, this.cwd, mergedEnv as NodeJS.ProcessEnv, {
            timeout,
            signal,
            detached: false,
            stdin: 'pipe',
          })
        : spawn(command, [], {
            cwd: this.cwd,
            shell: '/bin/sh',
            env: mergedEnv as NodeJS.ProcessEnv,
            detached: false,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

      let stdout = '';
      let stderr = '';

      // 收集 stdout/stderr，超过上限后丢弃数据
      childProcess.stdout!.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        outputSize += chunk.length;
        if (outputSize <= MAX_OUTPUT_BYTES) {
          stdout += chunk.toString();
        } else if (!truncated) {
          truncated = true;
          stdout += `\n\n[Output truncated: exceeded ${LIMIT_KB}KB limit]`;
        }
      });

      childProcess.stderr!.on('data', (data: Buffer | string) => {
        const chunk = Buffer.from(data);
        outputSize += chunk.length;
        if (outputSize <= MAX_OUTPUT_BYTES) {
          stderr += chunk.toString();
        } else if (!truncated) {
          truncated = true;
          stderr += `\n\n[Output truncated: exceeded ${LIMIT_KB}KB limit]`;
        }
      });

      // 超时处理
      const timer = setTimeout(() => {
        if (childProcess.pid) {
          this.killProcessTree(childProcess.pid);
        }
      }, timeout * 1000);

      // AbortSignal 监听
      const onAbort = () => {
        if (childProcess.pid) {
          this.killProcessTree(childProcess.pid);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      childProcess.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(stderr);

        if (truncated) {
          parts.push(`[Output truncated: exceeded ${LIMIT_KB}KB limit]`);
        }

        const output = parts.join('\n');

        if (code === 0) {
          const elapsed = Date.now() - startTime;
          if (output) {
            resolve(output + `\n[Exit code: 0, ${elapsed}ms]`);
          } else {
            resolve(`Command completed successfully [Exit code: 0, ${elapsed}ms]`);
          }
        } else {
          const elapsed = Date.now() - startTime;
          const timedOut = code === null;
          if (timedOut) {
            parts.push(`[Process timed out after ${timeout} seconds, ${elapsed}ms]`);
          } else {
            parts.push(`[Exit code: ${code}, ${elapsed}ms]`);
          }
          const errOutput = parts.join('\n');
          if (errOutput) {
            reject(new Error(errOutput));
          } else {
            reject(new Error(`Command failed with exit code ${code}`));
          }
        }
      });

      childProcess.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Command failed: ${err.message}`));
      });

      // 关闭 stdin
      childProcess.stdin!.end();
    });
  }
}
