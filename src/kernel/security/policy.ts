/**
 * 安全策略（policy）—— 裁决规则集与判定函数。
 *
 * 进程域：硬拒绝清单（参照 Codex shell-command/is_dangerous_command 的
 * 规则集思想，只收"灾难级"模式，避免误杀 taskkill/git 等合法命令）。
 * 网络域：LLM 归因的请求做私网/SSRF 拦截（参照 opencode 的 webfetch 域权限；
 * 回环默认放行——本地开发是常态；169.254.169.254 元数据地址即使放行回环也拦）。
 */

import { getSecurityConfig, resolveSecurityMode } from './config.js';
import { currentAttribution } from './attribution.js';
import { appendAudit } from './audit.js';
import { getSecurityStatus } from './integrity.js';
import { hardDenyCheck } from './command-policy.js';
import type { CommandVerdict, ProcessDecision, SecurityMode } from './types.js';

// ── 灾难级命令判定（进程域硬拒绝）────────────────────────────────
// 词法级结构化规则（P2-1，command-policy.ts）：按段切分 + flag-aware 位置参数，
// 穿透 shell 包装（bash -c / powershell -Command / cmd /c），
// 修复 `rm -r -- /`、`rm -rf //`、`del /f/s/q C:\`、`bash -c 'rm -rf /'` 等绕过形态。
// 命中即拒绝：这些模式没有合法的自动化使用场景。

/** 审查级模式（工具层 bash 用：命中记入 review，由既有审批链兜底） */
export const REVIEW_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /(?:^|[\s|;&])iex\b|\binvoke-expression\b/i, label: 'IEX/Invoke-Expression（表达式执行）' },
  { re: /-e(?:ncodedcommand|nc)\b/i, label: '-EncodedCommand（编码执行）' },
  { re: /\bfrombase64string\b/i, label: 'FromBase64String（解码执行常见前置）' },
  { re: /\b(?:downloadstring|downloadfile|webclient)\b/i, label: 'DownloadString/File（远程载荷下载）' },
  { re: /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(?:iex|iwr|bash|sh|powershell)\b/i, label: '下载管道执行（curl|sh 形态）' },
  { re: /`[^`]*\$/, label: '反引号子命令替换' },
  { re: /\$\([^)]*\)/, label: '$() 子命令替换' },
  { re: /(?:^|\s)&&\s*\S/, label: '&& 命令链接' },
  { re: /(?:^|\s)\|\|\s*\S/, label: '|| 命令链接' },
  { re: /;\s+\S/, label: '; 命令链接' },
];

/** 工具层命令分类（bash.ts 在黑名单 backstop 之上调用） */
export function classifyCommand(command: string): CommandVerdict {
  const reasons = hardDenyCheck(command);
  if (reasons.length > 0) return { level: 'blocked', reasons };
  for (const { re, label } of REVIEW_PATTERNS) {
    if (re.test(command)) reasons.push(label);
  }
  return { level: reasons.length > 0 ? 'review' : 'ok', reasons };
}

// ── 进程域裁决 ────────────────────────────────────────────────────

/**
 * 进程创建裁决。硬拒绝清单对"所有"调用生效（灾难级模式没有合法自动化场景）；
 * observe 模式只审计不拦（排障用）；degraded 状态对 LLM 归因调用 fail-closed。
 */
export function checkProcess(command: string, args: readonly string[]): ProcessDecision {
  const status = getSecurityStatus();
  if (status === 'off') return { allowed: true };

  const mode = resolveSecurityMode();
  const attributed = currentAttribution();
  const full = [command, ...args].join(' ');

  const denyReasons = hardDenyCheck(full);
  for (const reason of denyReasons) {
    appendAudit({
      type: 'process.deny',
      command: full.slice(0, 500),
      attributed: attributed ? `${attributed.kind}:${attributed.name}` : 'framework',
      reason,
      mode,
    });
    if (mode === 'observe') return { allowed: true, reason: `observe-only: ${reason}` };
    return { allowed: false, reason };
  }

  // degraded fail-closed：守卫被拆后，LLM 归因的进程创建一律拒绝
  if (status === 'degraded' && attributed && mode === 'enforce') {
    appendAudit({
      type: 'process.deny',
      command: full.slice(0, 500),
      attributed: `${attributed.kind}:${attributed.name}`,
      reason: 'kernel degraded — fail-closed',
      mode,
    });
    return { allowed: false, reason: '安全内核守卫完整性校验失败（degraded），LLM 归因的进程创建已 fail-closed' };
  }

  return { allowed: true };
}

// ── 网络域裁决 ────────────────────────────────────────────────────

/** IPv4 私网/链路本地判定 */
/** IPv4 私网/链路本地判定（a/b 为第一、第二字节） */
function ipv4Private(a: number, b: number, allowLoopback: boolean): boolean {
  if (a === 127) return !allowLoopback;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // 链路本地/云元数据，即使放行回环也拦
  if (a === 0) return true;
  return false;
}

export function isPrivateHost(hostname: string, opts?: { allowLoopback?: boolean }): boolean {
  const allowLoopback = opts?.allowLoopback ?? getSecurityConfig('network.allowLoopback', true);
  let host = hostname.toLowerCase().trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // IPv6
  if (host.includes(':')) {
    // IPv4-mapped IPv6（::ffff:a.b.c.d）—— 提取内嵌 IPv4 递归判定，防云元数据地址绕过
    const v4mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mapped) return isPrivateHost(v4mapped[1], opts);
    if (host === '::1') return !allowLoopback;
    if (host === '::') return true; // 未指定地址按私网处理
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
    return false;
  }

  if (host === 'localhost') return allowLoopback ? false : true;

  // 非常规 IPv4 字面量：纯十进制整数（如 2130706433 = 127.0.0.1、2852039166 = 169.254.169.254）
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) {
      return ipv4Private((n >>> 24) & 0xff, (n >>> 16) & 0xff, allowLoopback);
    }
    return false;
  }

  // 十六进制/八进制/混合 IPv4 字面量（如 0x7f.0.0.1、0xa9.0xfe.0xa9.0xfe）
  const altParts = host.split('.');
  if (altParts.length === 4 && altParts.every((p) => /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(p))) {
    const parts = altParts.map((p) => (/^0[xX]/.test(p) ? parseInt(p, 16) : parseInt(p, 10)));
    if (parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      return ipv4Private(parts[0], parts[1], allowLoopback);
    }
    return false;
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return ipv4Private(Number(m[1]), Number(m[2]), allowLoopback);
}

/**
 * 网络请求裁决：只对归因调用生效（框架自身的 provider/渠道/本地模型调用不受限）。
 * kind=channel 默认只审计不拦（避免破坏局域网媒体地址）。
 */
export function checkNetwork(url: string): ProcessDecision {
  const status = getSecurityStatus();
  if (status === 'off') return { allowed: true };

  const attributed = currentAttribution();
  if (!attributed) return { allowed: true };
  if (attributed.kind === 'channel') return { allowed: true };

  const blockPrivate = getSecurityConfig('network.blockPrivate', true);
  if (!blockPrivate) return { allowed: true };

  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: true }; // 非 URL 形态交给后续校验
  }
  if (!isPrivateHost(host)) return { allowed: true };

  const mode = resolveSecurityMode();
  appendAudit({
    type: 'network.deny',
    url: url.slice(0, 500),
    attributed: `${attributed.kind}:${attributed.name}`,
    host,
    mode,
  });
  if (mode === 'observe') return { allowed: true, reason: 'observe-only: private network' };
  return { allowed: false, reason: `私网地址请求被安全内核拦截（${host}）` };
}

/** 供日志/UI 的当前模式（诊断用） */
export function currentMode(): SecurityMode {
  return resolveSecurityMode();
}
