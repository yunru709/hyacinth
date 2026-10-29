/**
 * port probe（2026-10-29）
 *
 * 指纹语义（达成式）：
 *   expect='open'  ：能连上 → 'met'，连不上 → 'pending'
 *   expect='closed'：连不上 → 'met'，能连上 → 'pending'
 *
 * 安全：走 security.assertHostAllowed（默认拒绝内网字面量）。
 * 注意本 probe 与 http probe 合起来构成端口扫描能力，白名单不是可选项。
 */

import { connect } from 'node:net';

import type { PortSpec, Probe, ProbeInstance, ProbeSample } from '../types.js';
import { assertHostAllowed } from './security.js';

const DEFAULT_TIMEOUT_MS = 2_000;

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

class PortProbeInstance implements ProbeInstance {
  private readonly host: string;

  constructor(private readonly spec: PortSpec) {
    this.host = spec.host ?? '127.0.0.1';
    assertHostAllowed(this.host, spec.allowPrivateHost);
  }

  async sample(signal?: AbortSignal): Promise<ProbeSample> {
    if (signal?.aborted) return { ok: false, value: '', error: 'aborted' };

    const open = await tryConnect(this.host, this.spec.port, this.spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const met = this.spec.expect === 'closed' ? !open : open;
    return { ok: true, value: met ? 'met' : 'pending', raw: { open } };
  }
}

export const portProbe: Probe = {
  kind: 'port',
  description: '等待端口可连接或关闭（host 默认 127.0.0.1）',
  create(spec) {
    if (spec.kind !== 'port') throw new Error('portProbe received mismatched spec');
    if (typeof spec.port !== 'number' || !Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      throw new Error('port probe requires an integer port within 1..65535');
    }
    if (spec.expect !== 'open' && spec.expect !== 'closed') {
      throw new Error("port probe: expect must be 'open' or 'closed'");
    }
    return new PortProbeInstance(spec);
  },
};
