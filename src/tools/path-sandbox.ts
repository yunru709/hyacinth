import path from 'node:path';
import type { Tool } from './interface.js';

/** 各工具类型对应的路径参数名 */
const PATH_PARAMS: Record<string, string[]> = {
  read: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  grep: ['path'],
  glob: ['path'],
};

/**
 * 为工具创建路径沙箱包装。
 * 对 read/write/edit/grep/glob: 校验并解析路径参数到 sandboxRoot 下。
 * 对 bash: 直接拒绝（沙箱模式下不允许执行任意命令）。
 * 其他工具: 原样透传。
 */
export function createSandboxedTool(tool: Tool, sandboxRoot: string): Tool {
  const normalizedRoot = path.resolve(sandboxRoot);
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
          // 检查是否在 sandboxRoot 内
          const rel = path.relative(normalizedRoot, resolved);
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
