/**
 * 环境守卫（env-guard）—— 参照 dsh "凭据永不物化进子进程环境"。
 *
 * 背景：bash.ts 与 lifecycle/manager.ts 曾把含 API key 的完整 process.env
 * 原样传给子进程（npm postinstall、MCP server 均可读走全部密钥）。
 * 内核在 spawn/exec 边界统一改写 env：
 *   - registered 键（boot 时注册的 ~/.agent/.env 注入键）→ **始终剥离**
 *   - 秘密命名模式（API_KEY/SECRET/PASSWORD/CREDENTIAL/PRIVATE_KEY）→ 仅 LLM 归因时剥离
 *   - TOKEN 不做模式剥离（GITHUB_TOKEN 等是 MCP 配置 env 的合法常见键）
 *   - observe 模式只审计不改环境（保证排障时行为与旧版一致）
 */

import type { SecurityMode } from './types.js';

const SECRET_NAME_RE = /(API_?KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)/i;

/** boot 时注册的秘密键（来自 ~/.agent/.env 与项目 .env 的全部键名） */
const registeredSecretKeys = new Set<string>();

/** 注册秘密键名（gateway/boot 在 loadEnvKeys 后调用；值永不经过本模块） */
export function registerSecretKeys(keys: readonly string[]): void {
  for (const k of keys) registeredSecretKeys.add(k);
}

export function isSecretKeyName(key: string): boolean {
  return SECRET_NAME_RE.test(key);
}

/** 测试/诊断用：已注册的秘密键数量 */
export function registeredSecretKeyCount(): number {
  return registeredSecretKeys.size;
}

/**
 * 剥离子进程环境中的秘密。
 * 只按键名过滤，绝不读取/记录值。
 */
export function scrubEnv(
  env: NodeJS.ProcessEnv | undefined,
  opts: { attributed: boolean; mode: SecurityMode },
): NodeJS.ProcessEnv {
  if (!env || opts.mode !== 'enforce') return env as NodeJS.ProcessEnv;

  const toStrip: string[] = [];
  for (const key of Object.keys(env)) {
    if (registeredSecretKeys.has(key)) { toStrip.push(key); continue; }
    if (opts.attributed && isSecretKeyName(key)) toStrip.push(key);
  }
  if (toStrip.length === 0) return env;

  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of toStrip) delete out[key];
  return out;
}
