/**
 * IO 守卫（guards）—— 在进程 IO 边界包装 node 内建 API。
 *
 * 关键语义（保住现有行为）：
 * - 只做"创建前检查 + env 改写"，**透传全部参数、返回真实 ChildProcess/ClientRequest**
 *   ——bash 的后台句柄、超时 kill 树、AbortSignal、输出截断语义全部不变。
 * - 参数手术按各函数签名逐个处理（exec 的 callback 可能出现在第 2/3 位等）。
 * - 守卫自身绝不 import 被守卫的模块（由 bootstrap 经 createRequire 传入原引用）。
 *
 * 标记：所有守卫函数带 `Symbol.for('hyacinth.security.guarded')`，供 canary 校验。
 */

import { currentAttribution } from './attribution.js';
import { scrubEnv } from './env-guard.js';
import { resolveSecurityMode } from './config.js';
import { checkNetwork, checkProcess } from './policy.js';
import { appendAudit } from './audit.js';
import { getSecurityStatus } from './integrity.js';
import type { ToolAttribution } from './types.js';

export const GUARD_MARK = Symbol.for('hyacinth.security.guarded');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function mark<T extends AnyFn>(fn: T, name: string): T {
  Object.defineProperty(fn, GUARD_MARK, { value: name, enumerable: false });
  return fn;
}

/** canary 用：判断一个函数是否带守卫标记 */
export function isGuarded(fn: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof fn === 'function' && !!(fn as any)?.[GUARD_MARK];
}

// ── 参数手术工具 ──────────────────────────────────────────────────

/** exec(command[, options][, callback]) / execSync(command[, options]) 的 (options, callback) 分离 */
function splitOptsCallback(a: unknown, b: unknown): { options: Record<string, unknown> | undefined; callback: unknown } {
  if (typeof a === 'function') return { options: undefined, callback: a };
  return { options: (a && typeof a === 'object' ? a : undefined) as Record<string, unknown> | undefined, callback: typeof b === 'function' ? b : undefined };
}

/** 按守卫规则改写 options.env（其余字段原样保留） */
function withGuardedEnv(options: Record<string, unknown> | undefined, attributed: ToolAttribution | undefined): Record<string, unknown> {
  const mode = resolveSecurityMode();
  const env = (options?.env as NodeJS.ProcessEnv | undefined) ?? process.env;
  const scrubbed = scrubEnv(env, { attributed: !!attributed, mode });
  return { ...(options ?? {}), env: scrubbed };
}

function securityError(reason: string): Error {
  return new Error(`[security-kernel] blocked: ${reason}`);
}

// ── 进程域守卫 ────────────────────────────────────────────────────

function preCheckProcess(command: unknown, args: readonly unknown[]): void {
  const attributed = currentAttribution();
  const argv = args.map((a) => (a === undefined || a === null ? '' : String(a)));
  const decision = checkProcess(String(command), argv);
  if (!decision.allowed) {
    throw securityError(`进程创建（${String(command).slice(0, 120)}）: ${decision.reason}`);
  }
  void attributed;
}

/** spawn(command[, args][, options]) 与 fork 同形 */
function guardSpawnLike(orig: AnyFn, name: string): AnyFn {
  return mark(function (this: unknown, command: unknown, a?: unknown, b?: unknown) {
    preCheckProcess(command, Array.isArray(a) ? a : []);
    const hasArgs = Array.isArray(a);
    const options = (hasArgs ? b : a) as Record<string, unknown> | undefined;
    const merged = withGuardedEnv(options, currentAttribution());
    return hasArgs ? orig.call(this, command, a, merged) : orig.call(this, command, merged);
  }, name);
}

/** exec(command[, options][, callback]) */
function guardExec(orig: AnyFn, name: string): AnyFn {
  return mark(function (this: unknown, command: unknown, a?: unknown, b?: unknown) {
    preCheckProcess(command, []);
    const { options, callback } = splitOptsCallback(a, b);
    const merged = withGuardedEnv(options, currentAttribution());
    return callback !== undefined ? orig.call(this, command, merged, callback) : orig.call(this, command, merged);
  }, name);
}

/** execFile(file[, args][, options][, callback]) 与 execFileSync（sync=true）同族 */
function guardExecFileLike(orig: AnyFn, name: string, sync: boolean): AnyFn {
  return mark(function (this: unknown, file: unknown, a?: unknown, b?: unknown, c?: unknown) {
    const hasArgs = Array.isArray(a);
    preCheckProcess(file, hasArgs ? (a as unknown[]) : []);
    if (hasArgs) {
      // (file, args[, options][, callback])
      const options = (b && typeof b === 'object' ? b : undefined) as Record<string, unknown> | undefined;
      const callback = typeof b === 'function' ? b : (typeof c === 'function' ? c : undefined);
      const merged = withGuardedEnv(options, currentAttribution());
      if (!sync && callback) return orig.call(this, file, a, merged, callback);
      return orig.call(this, file, a, merged);
    }
    // (file[, options][, callback])
    const options = (a && typeof a === 'object' ? a : undefined) as Record<string, unknown> | undefined;
    const callback = typeof a === 'function' ? a : (typeof b === 'function' ? b : undefined);
    const merged = withGuardedEnv(options, currentAttribution());
    if (!sync && callback) return orig.call(this, file, merged, callback);
    return orig.call(this, file, merged);
  }, name);
}

/** 原地变异 child_process 模块对象的全部进程创建入口 */
export function guardChildProcess(cp: Record<string, unknown>): void {
  if (typeof cp.spawn === 'function') cp.spawn = guardSpawnLike(cp.spawn as AnyFn, 'child_process.spawn');
  if (typeof cp.fork === 'function') cp.fork = guardSpawnLike(cp.fork as AnyFn, 'child_process.fork');
  if (typeof cp.spawnSync === 'function') cp.spawnSync = guardSpawnLike(cp.spawnSync as AnyFn, 'child_process.spawnSync');
  if (typeof cp.exec === 'function') cp.exec = guardExec(cp.exec as AnyFn, 'child_process.exec');
  if (typeof cp.execSync === 'function') cp.execSync = guardExec(cp.execSync as AnyFn, 'child_process.execSync');
  if (typeof cp.execFile === 'function') cp.execFile = guardExecFileLike(cp.execFile as AnyFn, 'child_process.execFile', false);
  if (typeof cp.execFileSync === 'function') cp.execFileSync = guardExecFileLike(cp.execFileSync as AnyFn, 'child_process.execFileSync', true);
}

// ── 网络域守卫 ────────────────────────────────────────────────────

/** 从 request/get/fetch 的参数中提取 URL 字符串（尽力而为） */
function extractUrl(input: unknown): string | null {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (input && typeof input === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const o = input as any;
      if (typeof o.href === 'string') return o.href;          // URL / Request
      if (typeof o.url === 'string') return o.url;            // fetch 的 Request 旧形态
      if (o.hostname || o.host) {                             // http.request 的 options 形态
        const proto = o.protocol ?? 'http:';
        return `${proto}//${o.host ?? o.hostname}${o.path ?? '/'}`;
      }
    }
  } catch { /* 尽力而为 */ }
  return null;
}

function preCheckNetwork(input: unknown): void {
  const url = extractUrl(input);
  if (!url) return;
  const decision = checkNetwork(url);
  if (!decision.allowed) {
    appendAudit({ type: 'network.throw', url: url.slice(0, 300) });
    throw securityError(`网络请求（${url.slice(0, 120)}）: ${decision.reason}`);
  }
}

/** request(url[, options][, callback]) 与 get 同形 */
function guardRequestLike(orig: AnyFn, name: string): AnyFn {
  return mark(function (this: unknown, a?: unknown, b?: unknown, c?: unknown) {
    preCheckNetwork(a);
    const { options, callback } = splitOptsCallback(b, c);
    if (callback !== undefined) return orig.call(this, a, options, callback);
    if (options !== undefined) return orig.call(this, a, options);
    return orig.call(this, a);
  }, name);
}

/** 原地变异 http/https 模块的出站客户端入口（Server/Agent 等原样保留） */
export function guardHttpModule(mod: Record<string, unknown>): void {
  if (typeof mod.request === 'function') mod.request = guardRequestLike(mod.request as AnyFn, 'http.request');
  if (typeof mod.get === 'function') mod.get = guardRequestLike(mod.get as AnyFn, 'http.get');
}

/** 替换并冻结 globalThis.fetch（严格模式下覆写将抛 TypeError） */
export function guardGlobalFetch(): void {
  const orig = globalThis.fetch;
  if (typeof orig !== 'function' || isGuarded(orig)) return;
  const guarded = mark(async function fetch(input: unknown, init?: unknown) {
    preCheckNetwork(input);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as AnyFn)(input as any, init as any);
  }, 'globalThis.fetch');
  Object.defineProperty(globalThis, 'fetch', {
    value: guarded,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

// ── canary 输入 ───────────────────────────────────────────────────

/** canary 校验点清单：bootstrap 后定期/关键路径前核验 */
export function collectGuardProbes(require: NodeRequire): Array<{ name: string; ok: boolean }> {
  const probes: Array<{ name: string; ok: boolean }> = [];
  try {
    const cp = require('node:child_process') as Record<string, unknown>;
    probes.push({ name: 'child_process.spawn', ok: isGuarded(cp.spawn) });
    probes.push({ name: 'child_process.execSync', ok: isGuarded(cp.execSync) });
  } catch { probes.push({ name: 'child_process', ok: false }); }
  try {
    const http = require('node:http') as Record<string, unknown>;
    probes.push({ name: 'http.request', ok: isGuarded(http.request) });
  } catch { probes.push({ name: 'http', ok: false }); }
  probes.push({ name: 'globalThis.fetch', ok: isGuarded(globalThis.fetch) });
  return probes;
}

// getSecurityStatus 供守卫内部判断（避免循环依赖：此处只做透出）
export { getSecurityStatus };
