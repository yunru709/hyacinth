/**
 * Provider 错误分类守卫（2026-11-08 新增「失败可分类」职责）。
 *
 * 背景：四个适配器此前在 catch 里把所有错误拍扁成字符串，状态码只活在文本里；
 * 下游 context/compressor.ts、mcp/client.ts、tools/result-buffer.ts 只能靠匹配
 * "Model is unavailable" 猜是不是上下文超限 —— 换一家措辞就失效。
 *
 * 本文件锁两件事：
 *   ① 分类正确（尤其 400 的两种语义要能分开：超窗 vs 请求体非法）；
 *   ② **message 一字不变** —— 下游字符串匹配仍在服役，接入不能破坏它们；
 *   ③ 中断不被包装（否则 isAbortError 认不出，等于打回 P0-2 的修复）。
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  toProviderError,
  ProviderError,
  extractStatus,
  type ProviderErrorKind,
} from './errors.js';

describe('classifyProviderError：状态码优先', () => {
  const cases: Array<[string, number | undefined, ProviderErrorKind]> = [
    ['unauthorized', 401, 'auth'],
    ['forbidden', 403, 'auth'],
    ['too many requests', 429, 'rate_limit'],
    ['payload too large', 413, 'context_overflow'],
    ['internal error', 500, 'server'],
    ['bad gateway', 502, 'server'],
    ['overloaded', 529, 'server'],
    ['bad params', 422, 'invalid_request'],
  ];

  for (const [message, status, expected] of cases) {
    it(`${status} → ${expected}`, () => {
      expect(classifyProviderError({ message, status })).toBe(expected);
    });
  }
});

describe('classifyProviderError：400 的两种语义必须分开', () => {
  it('400 + "Model is unavailable"（opencode 的超窗粗报）→ context_overflow', () => {
    expect(classifyProviderError({ message: '400 Model is unavailable', status: 400 })).toBe(
      'context_overflow',
    );
  });

  it('400 + context_length_exceeded → context_overflow', () => {
    expect(
      classifyProviderError({ message: 'context_length_exceeded: too many tokens', status: 400 }),
    ).toBe('context_overflow');
  });

  it('400 + 其他语义（如 tool schema 非法）→ invalid_request，不得误判成超窗', () => {
    expect(classifyProviderError({ message: 'invalid tool schema', status: 400 })).toBe(
      'invalid_request',
    );
  });
});

describe('classifyProviderError：无状态码时靠错误码/文本', () => {
  it('ECONNREFUSED（在 cause 链里）→ network', () => {
    expect(classifyProviderError({ message: 'fetch failed', codes: ['ECONNREFUSED'] })).toBe(
      'network',
    );
  });

  it('"fetch failed" 文本 → network', () => {
    expect(classifyProviderError({ message: 'fetch failed' })).toBe('network');
  });

  it('网关措辞 → server', () => {
    expect(classifyProviderError({ message: 'Bad Gateway' })).toBe('server');
  });

  it('无法判断 → unknown', () => {
    expect(classifyProviderError({ message: 'something weird happened' })).toBe('unknown');
  });
});

describe('toProviderError：包装但不改变对外可见信息', () => {
  it('message 原样保留（下游字符串匹配依赖它）', () => {
    const original = Object.assign(new Error('400 Model is unavailable'), { status: 400 });
    const wrapped = toProviderError(`opencode API error (400): ${original.message}`, original, {
      providerType: 'opencode',
    });
    expect(wrapped.message).toBe('opencode API error (400): 400 Model is unavailable');
    // 下游仍能用原来的字符串匹配命中
    expect(wrapped.message).toContain('Model is unavailable');
    expect(wrapped.kind).toBe('context_overflow');
    expect(wrapped.isContextOverflow()).toBe(true);
    expect(wrapped.status).toBe(400);
    expect(wrapped.providerType).toBe('opencode');
  });

  it('retryable 与 kind 一致（限流/服务端/网络才可重试）', () => {
    const server = toProviderError('boom', Object.assign(new Error('x'), { status: 503 }));
    expect(server.kind).toBe('server');
    expect(server.retryable).toBe(true);

    const auth = toProviderError('boom', Object.assign(new Error('x'), { status: 401 }));
    expect(auth.kind).toBe('auth');
    expect(auth.retryable).toBe(false);
  });

  it('保留原始错误对象（cause 链可继续深挖）', () => {
    const original = new Error('orig');
    const wrapped = toProviderError('wrapped', original);
    expect(wrapped.original).toBe(original);
  });

  it('**中断必须原样上抛**，不得包装（否则 isAbortError 认不出）', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(() => toProviderError('should not wrap', abort)).toThrow(abort);

    class APIUserAbortError extends Error {}
    const sdkAbort = new APIUserAbortError('Request was aborted.');
    expect(() => toProviderError('should not wrap', sdkAbort)).toThrow(sdkAbort);
  });
});

describe('ProviderError 实例语义', () => {
  it('是 Error 的子类，可被 instanceof 捕获', () => {
    const e = toProviderError('x', new Error('y'));
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.name).toBe('ProviderError');
  });

  it('extractStatus 兼容 status / statusCode 两种字段名', () => {
    expect(extractStatus({ status: 429 })).toBe(429);
    expect(extractStatus({ statusCode: 503 })).toBe(503);
    expect(extractStatus(new Error('none'))).toBeUndefined();
  });
});
