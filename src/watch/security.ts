/**
 * Watch 模块的安全边界（2026-10-29）
 *
 * ⚠️ 为什么这个文件必须先于功能落地：
 * `http` 与 `port` 两种 Probe 本质是「向外发一次探测」。如果不设限，
 * 这个工具就是一台**内网扫描器** —— 模型可以拿着它遍历 192.168.0.0/16，
 * 而且从日志上看只是「监控了个端口」。
 *
 * 因此默认策略是**白名单式**：
 *   ✅ localhost / 127.0.0.1 / ::1   —— 本地服务是最常见用例，放行
 *   ✅ 公网 HTTP(S)                  —— 读公开页面，风险可控
 *   ❌ 私有网段 10/172.16-31/192.168 —— 必须显式 allowPrivateHost=true 才放行
 *   ❌ 链路本地 169.254.x（含云厂商元数据 169.254.169.254） —— **永不放行**
 *      这是 SSRF 拿云凭证的经典路径，无论如何都不加开关。
 */

/** 私有网段（需显式放行） */
const PRIVATE_PATTERNS: RegExp[] = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/** 链路本地 / 云元数据：永不放行，没有开关 */
const NEVER_ALLOWED_PATTERNS: RegExp[] = [
  /^169\.254\./,
];

/** 本机回环：默认放行 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export class WatchSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchSecurityError';
  }
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return PRIVATE_PATTERNS.some((re) => re.test(h));
}

/**
 * 校验 host 是否允许被探测；不允许则抛 WatchSecurityError。
 *
 * @param host          已从 URL / spec 中取出的裸主机名或 IP
 * @param allowPrivate  调用方是否显式放行私有网段
 */
export function assertHostAllowed(host: string, allowPrivate = false): void {
  const h = (host || '').toLowerCase().trim();
  if (!h) throw new WatchSecurityError('empty host');

  // 永不放行：链路本地 / 云元数据
  if (NEVER_ALLOWED_PATTERNS.some((re) => re.test(h))) {
    throw new WatchSecurityError(
      `host "${h}" is link-local / cloud-metadata and is never allowed`,
    );
  }

  // 回环：默认允许（本地服务是主要用例）
  if (isLoopback(h)) return;

  // 私有网段：需显式放行
  if (isPrivateHost(h) && !allowPrivate) {
    throw new WatchSecurityError(
      `host "${h}" is a private address; pass allowPrivateHost=true to watch it explicitly`,
    );
  }
}

/** 从 URL 中取出 hostname 并校验（协议只允许 http/https） */
export function assertUrlAllowed(rawUrl: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WatchSecurityError(`invalid url: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WatchSecurityError(`unsupported protocol: ${url.protocol}`);
  }
  assertHostAllowed(url.hostname, allowPrivate);
  return url;
}
