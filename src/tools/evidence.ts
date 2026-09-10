/**
 * 验证证据（P1-B，hermes 轻量版）—— 判定一次工具执行是否构成"验证证据"。
 *
 * 语义：修改文件（write/edit）之后，只有跑过测试/编译/lint/check 才算产生了
 * 可证明"没改坏"的证据。turn-end 证据门（repair.evidenceGate）据此拦截
 * "改了却不验证就结束"的回合。
 *
 * 纯函数、零运行时依赖，独立可测、跨项目可移植。
 */

/** 验证类命令模式（bash 的 command 匹配） */
export const VERIFY_COMMAND_PATTERNS: RegExp[] = [
  // 测试框架
  /(^|\s)(pytest|vitest|jest|mocha|ava|tapioca)(\s|$)/i,
  /(^|\s)(npm|yarn|pnpm|bun)\s+(test|run\s+test)(\s|$)/i,
  /(^|\s)(cargo|go)\s+test(\s|$)/i,
  // 编译 / 类型检查
  /(^|\s)(tsc|tsc\s+--noEmit|tsc\s+-p)(\s|$)/i,
  /(^|\s)(npm|yarn|pnpm|bun)\s+(run\s+)?(build|typecheck)(\s|$)/i,
  /(^|\s)cargo\s+(build|check)(\s|$)/i,
  /(^|\s)go\s+(build|vet)(\s|$)/i,
  // lint / 静态检查
  /(^|\s)(eslint|prettier\s+--check|ruff|mypy|flake8|golangci-lint)(\s|$)/i,
  /(^|\s)(npm|yarn|pnpm|bun)\s+(run\s+)?lint(\s|$)/i,
];

/**
 * 判定一次工具执行是否构成验证证据。
 * 目前只认 bash 中的验证类命令；其他工具（read/write/edit…）不构成验证证据。
 */
export function isVerificationEvidence(
  toolName: string,
  input?: Record<string, unknown>,
): boolean {
  if (toolName !== 'bash') return false;
  const command = input?.command;
  if (typeof command !== 'string' || command.length === 0) return false;
  return VERIFY_COMMAND_PATTERNS.some((re) => re.test(command));
}
