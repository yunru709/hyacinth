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

/** realTarget 是否落在 realBase 之内（相等也算之内 ✓） */
function isInsideReal(realBase: string, realTarget: string): boolean {
  const rel = path.relative(realBase, realTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── 写目标判定（围栏 ∩ 权限层共用同一套判据）──────────────────────

/** 一次写入的落点判定 */
export type WriteTargetVerdict =
  /** 落在 .git 内 —— 硬红线，**永不可授权**（git hook 跨会话存活） */
  | 'git'
  /** 在工作区（∪额外可写根）之外 —— **可经用户确认后放行** */
  | 'outside'
  /** 合规 */
  | 'inside';

/**
 * 判定一次写入的落点。
 *
 * **围栏与权限层必须共用本函数**——两处各写一套判据会漂移，
 * 典型症状是「围栏拒了、权限层却以为合规」这类静默不一致（2026-10-13 统一）。
 */
export function classifyWriteTarget(
  workspaceRoot: string,
  extraWritableRoots: readonly string[],
  filePath: string,
): WriteTargetVerdict {
  const resolved = path.resolve(workspaceRoot, filePath);
  // 用真实路径（跟随符号链接）判界，防 symlink 逃逸
  const realTarget = resolveRealPathSync(resolved);
  // ⚠️ `.git` 检查必须**同时**看逻辑路径与真实路径（2026-10-13 审计 B1，已实测可绕过）：
  // 只查 `resolved` 时，工作区里放一个指向 `.git` 的 junction/symlink 就能绕过 ——
  // 逻辑路径不含 `.git` 段（红线检查放行），真实路径却仍落在工作区内（判 inside）⇒ 直写 `.git`。
  // 实测：`mklink /J _git_probe .git` + write `_git_probe\x.txt` ⇒ 成功落入 `.git`（78B）。
  // 红线是"**永不可授权**"的底线（git hook 跨会话存活 = 持久执行），必须用真实路径兜死。
  if (isInsideGitDir(resolved) || isInsideGitDir(realTarget)) return 'git';
  if (isInsideReal(resolveRealPathSync(workspaceRoot), realTarget)) return 'inside';
  if (extraWritableRoots.some((r) => isInsideReal(resolveRealPathSync(r), realTarget))) return 'inside';
  return 'outside';
}

/**
 * 「已批准根」集合中是否涵盖该目标（用户确认后由权限层写入）。
 * 与 classifyWriteTarget 同用 isInsideReal ⇒ 判据不漂移。
 */
export function isApprovedWriteTarget(approvedRoots: Iterable<string>, target: string): boolean {
  const realTarget = resolveRealPathSync(target);
  for (const r of approvedRoots) {
    if (isInsideReal(resolveRealPathSync(r), realTarget)) return true;
  }
  return false;
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
 * ## 与权限层（onPermissionRequest）的分工 —— 2026-10-13「统一」
 *
 * 旧实现把「越界」**硬拒在 tool.execute 内部**，于是永远走不到权限确认通道：
 * bash 的危险命令可弹确认放行，write 的越界却只能撞墙 —— 两套语义。
 * 现在把边界统一成**一条规则**：
 *   · `.git`  → 硬红线，永不可授权（git hook 跨会话存活）
 *   · 越界    → **可确认**：权限层（loop-tools 的两条路径）弹确认，
 *               批准后把该目录的**父目录**写入 approvedWriteRoots ⇒ 本围栏据此放行
 *   · 越界且仍未获授权 → 仍拒（兜底：权限通道不可用/被拒时不留缺口）
 *
 * 返回实际包装的工具数。重复调用幂等（同名同源覆盖允许，内核 env 已在
 * registry.register 的 overwriteGuard 规则内）。
 */
export function applyWorkspaceFence(
  registry: { getAll(): Tool[]; register(tool: Tool): void },
  workspaceRoot: string,
  /**
   * 额外可写根（白名单，默认空 ⇒ 与不传时完全一致 ✓）。
   *
   * 为什么需要它（2026-09-19 用户裁定）：~/.agent/prompts/persona/ 是 agent 自维护区
   * （memory.md 的头注释就写着 "Managed by Agent. Edit directly"，Zone 5 临时记事本也在那里），
   * 但围栏只认 workspaceRoot ⇒ 记事本无法用 edit 工具写 ✗。
   * 放行面只增不减：这些根内部仍然拒 .git（不给出绕过 .git 的后门 ✓）。
   */
  extraWritableRoots: readonly string[] = [],
  /**
   * 经用户确认放行的根（**会话级**；由装配层创建，同时交给 loop 的 ToolExecContext，
   * 权限层在 onPermissionRequest 返回 yes/always 时写入，本围栏读取）。
   * 不传 ⇒ 越界一律拒（仅错误消息改为提示"可确认"）。
   */
  approvedWriteRoots?: Iterable<string>,
): number {
  const normalizedRoot = path.resolve(workspaceRoot);
  let wrapped = 0;
  for (const tool of registry.getAll()) {
    if (!isWriteTool(tool.name)) continue;
    registry.register(createWriteFencedTool(tool, normalizedRoot, extraWritableRoots, approvedWriteRoots));
    wrapped++;
  }
  return wrapped;
}

/** 为写类工具创建围栏包装：按 classifyWriteTarget 放行/拒绝（.git 恒拒） */
function createWriteFencedTool(
  tool: Tool,
  root: string,
  extraWritableRoots: readonly string[] = [],
  approvedWriteRoots?: Iterable<string>,
): Tool {
  const pathParam = tool.name === 'insert' ? 'file_path' : (PATH_PARAMS[tool.name]?.[0] ?? 'file_path');
  const fenced: Tool & { __rawTool?: Tool } = {
    ...tool,
    async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
      const value = args[pathParam];
      if (typeof value === 'string' && value.length > 0) {
        const verdict = classifyWriteTarget(root, extraWritableRoots, value);

        if (verdict === 'git') {
          return `Error: writing to ".git" is blocked by the workspace fence (git hooks outlive the session). Target: ${path.resolve(root, value)}`;
        }

        if (verdict === 'outside') {
          const target = path.resolve(root, value);
          // 已批准 ⇒ 放行；否则拒（正常路径下权限层已先弹确认，批准后才会有记录）
          if (!approvedWriteRoots || !isApprovedWriteTarget(approvedWriteRoots, target)) {
            return (
              `Error: path "${value}" resolves to "${target}" which is outside the workspace root "${root}". ` +
              'Writes outside the workspace require user confirmation; this call did not obtain it ' +
              '(the permission channel is unavailable, or the request was declined). ' +
              'Approve the request (yes / always) to allow writes under that directory.'
            );
          }
        }
      }
      return tool.execute(args, signal);
    },
  };
  // 保留围栏包装前的裸工具引用：automation runner 是**设计时确定的机械写入**（路径在 create 规则时
  // 已明确指定），不受会话级工作区围栏约束 ⇒ 装配层 currentInvokeTool 用 __rawTool 绕过围栏。
  // 模型盲写拿的是 registry 里的围栏代理、不消费 __rawTool ⇒ 仍受围栏保护。
  fenced.__rawTool = tool;
  return fenced;
}
