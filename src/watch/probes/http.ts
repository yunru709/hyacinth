/**
 * http probe（2026-10-29）
 *
 * 两种用法，靠有没有 expect* 区分：
 *   1) 有 expectStatus / expectContains → 条件达成检测
 *      value = 'met' | 'pending'，于是「等到 200」就是 pending → met
 *   2) 都没有 → 内容变化检测
 *      value = `${status}:${sha1(body).slice(0,16)}`，页面内容变了才算变化
 *
 * 网络错误：ok=false（不当成"变化"），但 value 固定为 'error'，
 * 这样"服务从挂掉恢复"也能被识别（error → 200）。
 */

import { createHash } from 'node:crypto';

import type { HttpSpec, Probe, ProbeInstance, ProbeSample } from '../types.js';
import { assertHostAllowed, assertHttpUrlAllowed } from './security.js';

const DEFAULT_TIMEOUT_MS = 10_000;

class HttpProbeInstance implements ProbeInstance {
  private readonly url: URL;
  /** 是否带期望条件（决定它是"达成式"还是"内容变化式"） */
  private readonly hasCondition: boolean;

  constructor(private readonly spec: HttpSpec) {
    this.url = assertHttpUrlAllowed(spec.url);
    assertHostAllowed(this.url.hostname, spec.allowPrivateHost);
    this.hasCondition =
      typeof spec.expectStatus === 'number' || typeof spec.expectContains === 'string';
  }

  /**
   * 只有"达成式"（带 expectStatus / expectContains）才有"已满足"概念。
   * 不带期望值时是纯内容变化检测，首帧不能算满足（否则会立刻误触发）。
   */
  isSatisfied(sample: ProbeSample): boolean {
    if (!this.hasCondition) return false;
    return sample.ok && sample.value === 'met';
  }

  async sample(signal?: AbortSignal): Promise<ProbeSample> {
    if (signal?.aborted) return { ok: false, value: '', error: 'aborted' };

    const timeoutMs = this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(this.url, {
        method: this.spec.method ?? 'GET',
        headers: this.spec.headers,
        signal: controller.signal,
        redirect: 'follow',
      });

      const hasCondition =
        typeof this.spec.expectStatus === 'number' || typeof this.spec.expectContains === 'string';

      const bodyText =
        this.spec.method === 'HEAD' || !hasCondition ? '' : await res.text();

      if (hasCondition) {
        const statusOk =
          typeof this.spec.expectStatus !== 'number' || res.status === this.spec.expectStatus;
        const containsOk =
          typeof this.spec.expectContains !== 'string' || bodyText.includes(this.spec.expectContains);
        const met = statusOk && containsOk;
        return {
          ok: true,
          value: met ? 'met' : 'pending',
          raw: { status: res.status, matched: met },
        };
      }

      const bodyHash = createHash('sha1').update(bodyText).digest('hex').slice(0, 16);
      return { ok: true, value: `${res.status}:${bodyHash}`, raw: { status: res.status } };
    } catch (err) {
      const msg = (err as Error).message;
      // 请求失败本身也是可观测状态：服务恢复时从 'error' 变走，能触发变化
      return { ok: false, value: 'error', error: msg };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export const httpProbe: Probe = {
  kind: 'http',
  description: 'HTTP 端点状态变化 / 等到指定状态码或响应包含指定文本',
  create(spec) {
    if (spec.kind !== 'http') throw new Error('httpProbe received mismatched spec');
    if (!spec.url) throw new Error('http probe requires a url');
    if (spec.expectStatus !== undefined && (spec.expectStatus < 100 || spec.expectStatus > 599)) {
      throw new Error('http probe: expectStatus must be within 100..599');
    }
    return new HttpProbeInstance(spec);
  },
};
