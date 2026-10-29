/**
 * Watch 模块单测（2026-10-29）
 *
 * 原则：不碰真实屏幕、不发外网请求。HTTP/端口测试用本地临时服务，
 * 文件测试用临时目录，wait 核心用假时钟 —— 整个文件应在 1s 内跑完。
 */

import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDefaultProbeRegistry } from './probes/index.js';
import { ProbeRegistry } from './probes/registry.js';
import { assertHostAllowed, assertHttpUrlAllowed, isPrivateAddress } from './probes/security.js';
import type { ProbeInstance, ProbeSample } from './types.js';
import { waitForChange } from './wait.js';

// ── 安全校验 ────────────────────────────────────────────────────────

describe('probe security', () => {
  it('放行回环，拒绝私有网段', () => {
    expect(isPrivateAddress('localhost')).toBe(false);
    expect(isPrivateAddress('127.0.0.1')).toBe(false);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.0.5')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // 172.16~31 之外是公网
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // 云元数据
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('未显式放行时拒绝内网', () => {
    expect(() => assertHostAllowed('192.168.1.1', undefined)).toThrow(/private address/);
    expect(() => assertHostAllowed('192.168.1.1', true)).not.toThrow();
    expect(() => assertHostAllowed('example.com', undefined)).not.toThrow();
  });

  it('只允许 http/https', () => {
    expect(assertHttpUrlAllowed('https://example.com').protocol).toBe('https:');
    expect(() => assertHttpUrlAllowed('file:///etc/passwd')).toThrow(/unsupported protocol/);
    expect(() => assertHttpUrlAllowed('not-a-url')).toThrow(/invalid url/);
  });
});

// ── 注册表 ──────────────────────────────────────────────────────────

describe('probe registry', () => {
  it('默认注册表包含 5 种 kind', () => {
    const r = createDefaultProbeRegistry();
    expect(r.kinds()).toEqual(['file', 'http', 'port', 'process', 'ui_region']);
    expect(r.describe().every((d) => d.description.length > 0)).toBe(true);
  });

  it('未知 kind 抛错而不是静默失败', () => {
    const r = new ProbeRegistry();
    expect(() => r.create({ kind: 'file', path: 'x' })).toThrow(/unknown watch kind/);
  });
});

// ── file probe ──────────────────────────────────────────────────────

describe('file probe', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'watch-file-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不存在时返回 missing（是合法状态，不是错误）', async () => {
    const probe = createDefaultProbeRegistry().create({ kind: 'file', path: path.join(dir, 'nope.txt') });
    const s = await probe.sample();
    expect(s.ok).toBe(true);
    expect(s.value).toBe('missing');
  });

  it('文件出现后指纹变化', async () => {
    const target = path.join(dir, 'appear.txt');
    const probe = createDefaultProbeRegistry().create({ kind: 'file', path: target });
    const before = await probe.sample();
    await writeFile(target, 'hello');
    const after = await probe.sample();
    expect(before.value).toBe('missing');
    expect(after.value).not.toBe('missing');
    expect(after.value).not.toBe(before.value);
  });

  it('内容变化被检出，且同内容稳定', async () => {
    const target = path.join(dir, 'content.txt');
    await writeFile(target, 'v1');
    const probe = createDefaultProbeRegistry().create({ kind: 'file', path: target });
    const s1 = await probe.sample();
    const s2 = await probe.sample();
    expect(s2.value).toBe(s1.value); // 同内容 → 同指纹
    await appendFile(target, 'v2');
    const s3 = await probe.sample();
    expect(s3.value).not.toBe(s1.value);
  });

  it('mtime 模式可工作', async () => {
    const target = path.join(dir, 'mtime.txt');
    await writeFile(target, 'abc');
    const probe = createDefaultProbeRegistry().create({ kind: 'file', path: target, watch: 'mtime' });
    const s = await probe.sample();
    expect(s.ok).toBe(true);
    expect(s.value).toMatch(/^\d+:\d+$/);
  });
});

// ── port probe ──────────────────────────────────────────────────────

describe('port probe', () => {
  it('端口开放时 met，关闭时 pending', async () => {
    const server = createNetServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    try {
      const openProbe = createDefaultProbeRegistry().create({
        kind: 'port',
        host: '127.0.0.1',
        port,
        expect: 'open',
      });
      const openSample = await openProbe.sample();
      expect(openSample.ok).toBe(true);
      expect(openSample.value).toBe('met');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    // 关闭后同一个端口应变成 pending
    const closedProbe = createDefaultProbeRegistry().create({
      kind: 'port',
      host: '127.0.0.1',
      port,
      expect: 'open',
    });
    const closedSample = await closedProbe.sample();
    expect(closedSample.value).toBe('pending');
  });
});

// ── process probe ───────────────────────────────────────────────────

describe('process probe', () => {
  it('自身进程在运行时 running 期望达成', async () => {
    const probe = createDefaultProbeRegistry().create({
      kind: 'process',
      pid: process.pid,
      expect: 'running',
    });
    const s = await probe.sample();
    expect(s.ok).toBe(true);
    expect(s.value).toBe('met');
  });

  it('不存在的 pid 对 running 期望为 pending', async () => {
    const probe = createDefaultProbeRegistry().create({
      kind: 'process',
      pid: 999_999,
      expect: 'running',
    });
    const s = await probe.sample();
    expect(s.value).toBe('pending');
  });

  it('参数互斥校验', () => {
    const r = createDefaultProbeRegistry();
    expect(() => r.create({ kind: 'process', expect: 'running' })).toThrow(/pid or name/);
    expect(() =>
      r.create({ kind: 'process', pid: 1, name: 'x', expect: 'running' }),
    ).toThrow(/only one of pid \/ name/);
  });
});

// ── http probe ──────────────────────────────────────────────────────

describe('http probe', () => {
  let server: ReturnType<typeof createHttpServer>;
  let baseUrl = '';

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ready-flag');
        return;
      }
      res.writeHead(404);
      res.end('nope');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('expectStatus 命中时 met', async () => {
    const probe = createDefaultProbeRegistry().create({
      kind: 'http',
      url: `${baseUrl}/ok`,
      expectStatus: 200,
    });
    const s = await probe.sample();
    expect(s.ok).toBe(true);
    expect(s.value).toBe('met');
  });

  it('期望不满足时 pending', async () => {
    const probe = createDefaultProbeRegistry().create({
      kind: 'http',
      url: `${baseUrl}/ok`,
      expectStatus: 404,
    });
    const s = await probe.sample();
    expect(s.value).toBe('pending');
  });

  it('expectContains 生效', async () => {
    const hit = createDefaultProbeRegistry().create({
      kind: 'http',
      url: `${baseUrl}/ok`,
      expectContains: 'ready-flag',
    });
    expect((await hit.sample()).value).toBe('met');

    const miss = createDefaultProbeRegistry().create({
      kind: 'http',
      url: `${baseUrl}/ok`,
      expectContains: 'absent-text',
    });
    expect((await miss.sample()).value).toBe('pending');
  });

  it('无期望值时按内容指纹比较', async () => {
    const probe = createDefaultProbeRegistry().create({ kind: 'http', url: `${baseUrl}/ok` });
    const s = await probe.sample();
    expect(s.ok).toBe(true);
    expect(s.value).toMatch(/^200:[0-9a-f]{16}$/);
  });
});

// ── wait 核心（假时钟 + 假 probe）────────────────────────────────────

function scriptedProbe(values: string[]): ProbeInstance {
  let i = 0;
  return {
    async sample(): Promise<ProbeSample> {
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      return { ok: true, value: v };
    },
  };
}

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('waitForChange', () => {
  it('指纹变化时立即返回 changed', async () => {
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'file',
      probe: scriptedProbe(['a', 'a', 'b']),
      timeoutMs: 5_000,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.distance).toBeGreaterThan(0);
  });

  it('始终不变则超时返回 changed=false', async () => {
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'file',
      probe: scriptedProbe(['same']),
      timeoutMs: 1_000,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.elapsedMs).toBeLessThanOrEqual(1_200);
  });

  it('threshold 抬高后小变化不再命中', async () => {
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'ui_region',
      probe: {
        async sample(): Promise<ProbeSample> {
          return { ok: true, value: '1' };
        },
        distance: () => 5,
      },
      timeoutMs: 500,
      intervalMs: 100,
      threshold: 6,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.changed).toBe(false);
    expect(res.maxDistance).toBe(5);
  });

  it('settleFrames 压掉单帧抖动', async () => {
    const c = fakeClock();
    let n = 0;
    const res = await waitForChange({
      kind: 'file',
      probe: {
        async sample(): Promise<ProbeSample> {
          n += 1;
          return { ok: true, value: n === 2 ? 'flash' : 'base' };
        },
      },
      timeoutMs: 800,
      intervalMs: 100,
      settleFrames: 3,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.changed).toBe(false);
  });

  it('采样失败不算变化', async () => {
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'http',
      probe: {
        async sample(): Promise<ProbeSample> {
          return { ok: false, value: '', error: 'boom' };
        },
      },
      timeoutMs: 500,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.changed).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/failed/);
  });

  it('达成式 probe 首帧即满足时立即返回，不等超时', async () => {
    // 回归 2026-10-29 验收暴露的缺陷：explorer 一直在跑，但 wait 返回 changed=false。
    // 原因：首帧基准=met，之后一直 met ⇒ 距离恒 0。修法 = isSatisfied 首帧短路。
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'process',
      probe: {
        async sample(): Promise<ProbeSample> {
          return { ok: true, value: 'met' };
        },
        isSatisfied: (s) => s.ok && s.value === 'met',
      },
      timeoutMs: 5_000,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.samples).toBe(1); // 只采了一帧就返回
    expect(res.elapsedMs).toBe(0);
  });

  it('真实 process probe：等待已运行的进程立即命中', async () => {
    // 上一版会让这条用例超时 3 秒仍返回 false —— 用真实 probe 再钉一次
    const c = fakeClock();
    const probe = createDefaultProbeRegistry().create({
      kind: 'process',
      pid: process.pid,
      expect: 'running',
    });
    const res = await waitForChange({
      kind: 'process',
      probe,
      timeoutMs: 3_000,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.changed).toBe(true);
    expect(res.samples).toBe(1);
  });

  it('达成式 probe 未满足时仍然等（不能一律短路）', async () => {
    const c = fakeClock();
    const res = await waitForChange({
      kind: 'process',
      probe: {
        async sample(): Promise<ProbeSample> {
          return { ok: true, value: 'pending' };
        },
        isSatisfied: (s) => s.value === 'met',
      },
      timeoutMs: 600,
      intervalMs: 100,
      clock: c.now,
      sleep: c.sleep,
    });
    expect(res.changed).toBe(false);
    expect(res.samples).toBeGreaterThan(1);
  });
});
