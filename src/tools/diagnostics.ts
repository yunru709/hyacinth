/**
 * diagnostics — 代码修改后自动运行类型检查/编译检查
 *
 * 在 write/edit/multi_edit 工具执行后自动检测项目类型并运行对应的
 * 类型检查命令，结果在下轮对话中注入供 LLM 参考。
 *
 * 设计原则：
 *   - 不影响工具执行流（结果通过 pending 机制在下轮注入）
 *   - 超时保护（默认 15 秒，防止阻塞）
 *   - 静默降级（无已知项目类型时跳过）
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ── 项目类型检测 ─────────────────────────────────────────────

type ProjectType = 'typescript' | 'go' | 'rust' | 'python';

interface DiagnosticsCommand {
  cmd: string;
  args: string[];
}

/** 检测当前工作目录的项目类型 */
export function detectProjectType(cwd: string): ProjectType | null {
  // TypeScript / JavaScript
  if (fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    return 'typescript';
  }
  // Go
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return 'go';
  }
  // Rust
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return 'rust';
  }
  // Python
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return 'python';
  }
  return null;
}

/** 获取项目类型对应的诊断命令 */
export function getDiagnosticsCommand(type: ProjectType): DiagnosticsCommand {
  switch (type) {
    case 'typescript':
      return { cmd: 'npx', args: ['tsc', '--noEmit', '--pretty', 'false'] };
    case 'go':
      return { cmd: 'go', args: ['build', './...'] };
    case 'rust':
      return { cmd: 'cargo', args: ['check', '--message-format', 'short'] };
    case 'python':
      return { cmd: 'python', args: ['-m', 'compileall', '-q', '.'] };
  }
}

// ── 执行 & 格式化 ────────────────────────────────────────────

/**
 * 运行诊断命令并返回格式化结果。
 *
 * @param cwd     工作目录
 * @param timeout 超时时间（毫秒），默认 15000
 * @returns 格式化的诊断结果字符串，超时或无法运行时返回 null
 */
export async function runDiagnostics(
  cwd: string,
  timeout: number = 15000,
): Promise<string | null> {
  const projectType = detectProjectType(cwd);
  if (!projectType) return null;

  const { cmd, args } = getDiagnosticsCommand(projectType);

  try {
    // 对于 npx，Windows 上需要 .cmd 后缀
    const resolvedCmd = process.platform === 'win32' && cmd === 'npx'
      ? 'npx.cmd'
      : cmd;

    const { stdout, stderr } = await execFileAsync(resolvedCmd, args, {
      cwd,
      timeout,
      maxBuffer: 256 * 1024, // 256 KB
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });

    const output = (stderr + stdout).trim();

    // 区分"检查通过"和"有错误"
    if (!output) {
      return `[Diagnostics] ${typeLabel(projectType)} check passed — no errors.`;
    }

    // 截断过长输出
    const maxLen = 2000;
    const truncated = output.length > maxLen
      ? output.slice(0, maxLen) + `\n... (truncated, ${output.length - maxLen} more chars)`
      : output;

    return `[Diagnostics] ${typeLabel(projectType)} check results:\n${truncated}`;
  } catch (err: unknown) {
    // execFile 在非零退出码时会 throw
    const execErr = err as { stdout?: string; stderr?: string; killed?: boolean; code?: number };
    if (execErr.killed) {
      return `[Diagnostics] ${typeLabel(projectType)} check timed out (>${timeout / 1000}s).`;
    }
    const errOutput = ((execErr.stderr || '') + (execErr.stdout || '')).trim();
    if (!errOutput) {
      return `[Diagnostics] ${typeLabel(projectType)} check failed (exit code ${execErr.code}).`;
    }
    const maxLen = 2000;
    const truncated = errOutput.length > maxLen
      ? errOutput.slice(0, maxLen) + `\n... (truncated, ${errOutput.length - maxLen} more chars)`
      : errOutput;
    return `[Diagnostics] ${typeLabel(projectType)} check found errors:\n${truncated}`;
  }
}

function typeLabel(type: ProjectType): string {
  switch (type) {
    case 'typescript': return 'TypeScript (tsc)';
    case 'go': return 'Go (go build)';
    case 'rust': return 'Rust (cargo check)';
    case 'python': return 'Python (py_compile)';
  }
}
