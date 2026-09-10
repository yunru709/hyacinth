import path from 'node:path';
import fs from 'node:fs';
import type { Tool } from './interface.js';
import { isWriteTool } from './side-effect.js';

/**
 * 解析路径的真实绝对路径（跟随符号链接），用于防 symlink 逃逸的围栏校验。
 *
 * 目标不存在时（写新文件的场景），向上找到最近存在的父目录解析其真实路径，
 * 再把剩余的相对段拼回去——保证"父目录若是 symlink 指向外部"也能被识别。
 */
function resolveRealPathSync(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    let dir = path.dirname(p);
    const suffix: string[] = [];
    for (let guard = 0; guard < 64; guard++) {
      try {
        return path.join(fs.realpathSync(dir), ...[...suffix].reverse());
      } catch {
        const base = path.basename(dir);
        if (base === dir) break; // 到达根目录仍不存在
        suffix.push(base);
        dir = path.dirname(dir);
      }
    }
    // 全部失败：回退到纯字符串规范化（保守：此时外部调用方应自行保证目录存在）
    return path.resolve(p);
  }
}

/** 各工具类型对应的路径参数名 */
const PATH_PARAMS: Record<string, string[]> = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  grep: ['path'],
  glob: ['path'],
};

/** 路径是否位于 .git 目录内（Codex WritableRoot 思想：git hook 是跨会话存活的执行点） */
function isInsideGitDir(resolved: string): boolean {
  return resolved.split(/[\\/]/).includes('.git');
}

/**
 * 为工具创建路径沙箱包装。
 * 对 read/write/edit/grep/glob: 校验并解析路径参数到 sandboxRoot 下。
 * 对 bash: 直接拒绝（沙箱模式下不允许执行任意命令）。
 * 其他工具: 原样透传。
 */
export function createSandboxedTool(tool: Tool, sandboxRoot: string): Tool {
  const normalizedRoot = path.resolve(sandboxRoot);
  const realRoot = resolveRealPathSync(normalizedRoot);
  const pathParams = PATH_PARAMS[tool.name];

  // 沙箱模式下禁止 bash
  if (tool.name === 'bash') {
    return {
      ...tool,
      async execute(args: Record<string, unknown>): Promise<string> {
        return 'Error: bash tool is not allowed in sub-agent sandbox mode. Use read/write/edit/grep/glob for file operations restricted to the sandbox directory.';
      },
    };
  }

  // 非路径敏感工具，原样返回
  if (!pathParams || pathParams.length === 0) {
    return tool;
  }

  return {
    ...tool,
    async execute(args: Record<string, unknown>): Promise<string> {
      // 校验每个路径参数
      for (const param of pathParams) {
        const value = args[param];
        if (value !== undefined && typeof value === 'string') {
          const resolved = path.resolve(normalizedRoot, value);
          // 用真实路径（跟随符号链接）判界，防 symlink 逃逸
          const realTarget = resolveRealPathSync(resolved);
          const rel = path.relative(realRoot, realTarget);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return `Error: path "${value}" resolves to "${resolved}" which is outside the sandbox directory "${normalizedRoot}". All file access must be within the project directory.`;
          }
          // 将相对路径替换为沙箱内的绝对路径
          (args as Record<string, unknown>)[param] = resolved;
        }
      }
      return tool.execute(args);
    },
  };
}

/**
 * 批量包装工具注册表中的路径敏感工具。
 * 返回一个新 Map（不修改原 registry）。
 */
export function wrapSandboxedTools(
  tools: Tool[],
  sandboxRoot: string,
): Tool[] {
  return tools.map(t => createSandboxedTool(t, sandboxRoot));
}

// ── 主 Agent 工作区围栏（kernel/security P0）─────────────────────

/**
 * 为主 Agent 激活工作区围栏：写类工具（write/edit/multi_edit/insert）只许写
 * workspaceRoot 内、且不许碰 .git；read/grep/glob 不受限（读外部是合法需求，
 * 写外部才是"不利影响"）；bash 不在此拦（由内核进程守卫 + 命令分类器接管）。
 *
 * 返回实际包装的工具数。重复调用幂等（同名同源覆盖允许，内核 env 已在
 * registry.register 的 overwriteGuard 规则内）。
 */
export function applyWorkspaceFence(
  registry: { getAll(): Tool[]; register(tool: Tool): void },
  workspaceRoot: string,
): number {
  const normalizedRoot = path.resolve(workspaceRoot);
  let wrapped = 0;
  for (const tool of registry.getAll()) {
    if (!isWriteTool(tool.name)) continue;
    registry.register(createWriteFencedTool(tool, normalizedRoot));
    wrapped++;
  }
  return wrapped;
}

/** 为写类工具创建围栏包装：校验 file_path 在工作区内且不触 .git */
function createWriteFencedTool(tool: Tool, root: string): Tool {
  const realRoot = resolveRealPathSync(root);
  const pathParam = tool.name === 'insert' ? 'file_path' : (PATH_PARAMS[tool.name]?.[0] ?? 'file_path');
  return {
    ...tool,
    async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
      const value = args[pathParam];
      if (typeof value === 'string' && value.length > 0) {
        const resolved = path.resolve(root, value);
        if (isInsideGitDir(resolved)) {
          return `Error: writing to ".git" is blocked by the workspace fence (git hooks outlive the session). Target: ${resolved}`;
        }
        // 用真实路径（跟随符号链接）判界，防 symlink 逃逸
        const realTarget = resolveRealPathSync(resolved);
        const rel = path.relative(realRoot, realTarget);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return `Error: path "${value}" resolves to "${resolved}" which is outside the workspace root "${root}". Writes must stay inside the workspace (security workspace fence).`;
        }
      }
      return tool.execute(args, signal);
    },
  };
}
