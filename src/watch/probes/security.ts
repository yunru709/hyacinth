/**
 * Probe 侧安全校验（2026-10-29）
 *
 * 背景：`http` / `port` 两个 probe 合起来就是一个端口扫描器。这个工具最终
 * 是给模型用的，而模型会被内容注入了什么我们控制不了 —— 所以白名单必须
 * 在**代码里**默认拒绝内网，而不是靠提示词里写"请不要扫描内网"。
 *
 * 默认策略：
 *   - localhost / 127.0.0.0/8 / ::1  → 允许（本地服务调试是刚需）
 *   - 私有网段 10/8、172.16/12、192.168/16、169.254/16、100.64/10 → 拒绝
 *   - 其余（公网）→ 允许
 * 需要打内网时，调用方必须显式传 `allowPrivateHost: true`。
 */

/** 判断是否私有 / 链路本地 / CGNAT 地址（只看 IPv4 字面量与常见别名） */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return false; // 本地放行
  if (h === 'metadata.google.internal') return true; // 云元数据端点，绝不允许探测

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false; // 域名交给 DNS 解析，不在这里判（解析后再判成本太高，见下）

  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return false; // 回环放行
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 校验目标是否允许访问。
 * @param host     主机名或 IP
 * @param allowPrivate 调用方是否显式放行内网
 */
export function assertHostAllowed(host: string, allowPrivate: boolean | undefined): void {
  if (allowPrivate) return;
  if (isPrivateHost(host)) {
    throw new Error(
      `refusing to probe private address '${host}'. ` +
        'Pass allowPrivateHost=true explicitly if this is intended (watch tool defaults to public/localhost only).',
    );
  }
}

/** 仅允许 http/https —— 挡掉 file: / gopher: 之类的协议滥用 */
export function assertHttpUrlAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol '${parsed.protocol}'; only http/https are allowed`);
  }
  return parsed;
}
