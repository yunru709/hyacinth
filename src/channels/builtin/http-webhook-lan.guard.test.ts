/**
 * 对外开放的**安全守卫**测试（2026-09-20 新增，随"WebUI 可开局域网"一起）。
 *
 * 守的是什么（这是本次改动里唯一"做错会真伤到用户"的地方）：
 *   · 对外开放（监听地址不是本机）**且没配钥匙** ⇒ 必须**拒绝启动** ✓
 *     （老行为是"照常启动、所有请求 401" ⇒ 门开着但没人知道该配钥匙 ✗）
 *   · 默认（不指定地址）仍等于"只对本机" ⇒ 老行为不变 ✓
 *   · 可达网址列表形状正确（多网卡时全列，供启动提示用 ✓）
 *
 * 为什么值得测：这条一旦被调宽（例如有人把默认改成对外），
 * 同网任何人都能让这台电脑执行命令、改文件 ✗。
 *
 * 注意：故意**不真起监听**（免端口抖动 ✗）—— 守卫在"进入监听之前"就会抛，
 * 所以断言抛错本身就足以覆盖它 ✓。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HttpWebhookChannel, isLoopbackHost, listLanUrls } from './http-webhook.js';

const SAVED = {
  hy: process.env.HYACINTH_API_KEY,
  ag: process.env.AGENT_API_KEY,
};

afterEach(() => {
  // 还原环境变量（下面会临时清空，才能稳定测"没配钥匙"那条）
  if (SAVED.hy === undefined) delete process.env.HYACINTH_API_KEY; else process.env.HYACINTH_API_KEY = SAVED.hy;
  if (SAVED.ag === undefined) delete process.env.AGENT_API_KEY; else process.env.AGENT_API_KEY = SAVED.ag;
});

describe('对外开放的安全守卫（fail-closed）', () => {
  it('地址未知 ⇒ **当作不安全**（fail-closed 语义 ✓）', () => {
    // ⚠️ 这条不是"笔误"：语义是"拿不准就当对外开放" ⇒ 需要钥匙 ✓。
    // 生产路径不会走到这里（start() 里 host 有 '127.0.0.1' 的默认值 ✓）；
    // 守的是"将来有人直接调它" —— 那时宁可多要一把钥匙，也不要静默放开 ✗。
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  it('默认不指定地址 ⇒ 视为"只对本机"（老行为不变 ✓）', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('对外开放的地址 ⇒ 判为"不是只对本机"', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('172.16.3.4')).toBe(false);
  });

  it('可达网址列表：形状正确且带端口（启动提示用 ✓）', () => {
    const urls = listLanUrls(3100);
    expect(Array.isArray(urls)).toBe(true);
    for (const u of urls) {
      expect(u).toContain('http://');
      expect(u).toContain(':3100/');
    }
  });

  it('【核心】对外开放 + 没配钥匙 ⇒ 拒绝启动（不是"启动后一律 401"）', async () => {
    delete process.env.HYACINTH_API_KEY;
    delete process.env.AGENT_API_KEY;

    const channel = new HttpWebhookChannel();
    const provider = { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never;

    await expect(
      channel.start({ port: 0, host: '0.0.0.0', provider, cwd: process.cwd() } as never),
    ).rejects.toThrow(/拒绝启动/);
  });

  it('【对照】对外开放 + 配了钥匙 ⇒ 不受该守卫影响（不会因这条被误拒）', async () => {
    // 只断言"不是被守卫拒绝" —— 真起监听交给既有测试（免端口抖动 ✓）
    const channel = new HttpWebhookChannel();
    const provider = { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never;

    let err: unknown = null;
    try {
      await channel.start({ port: 0, host: '0.0.0.0', provider, cwd: process.cwd(), apiKey: 'test-key-1234' } as never);
    } catch (e) {
      err = e;
    }
    // 若抛错，必须**不是**守卫那条（可能是缺 sessionManager 之类的其它原因 ⇒ 这里只排除守卫 ✓）
    if (err) expect(String(err)).not.toMatch(/拒绝启动/);
    // 起得来就立刻收摊，避免留监听
    if (!err) {
      const anyCh = channel as unknown as { stop?: () => Promise<void> };
      if (typeof anyCh.stop === 'function') await anyCh.stop();
    }
  });

  it('【早期测试】对外开放 + noAuth ⇒ 守卫放行（不因缺钥匙被拒）', async () => {
    delete process.env.HYACINTH_API_KEY;
    delete process.env.AGENT_API_KEY;

    const channel = new HttpWebhookChannel();
    const provider = { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never;

    let err: unknown = null;
    try {
      await channel.start({ port: 0, host: '0.0.0.0', provider, cwd: process.cwd(), noAuth: true } as never);
    } catch (e) {
      err = e;
    }
    // 只排除守卫那条（其它原因允许 —— 本例测的就是"守卫不再拦它" ✓）
    if (err) expect(String(err)).not.toMatch(/拒绝启动/);
    if (!err) {
      const anyCh = channel as unknown as { stop?: () => Promise<void> };
      if (typeof anyCh.stop === 'function') await anyCh.stop();
    }
  });

  it('【默认不变】不带 noAuth 时，对外开放 + 无钥匙 ⇒ 仍然拒绝启动', async () => {
    delete process.env.HYACINTH_API_KEY;
    delete process.env.AGENT_API_KEY;

    const channel = new HttpWebhookChannel();
    const provider = { getProviderType: () => 'anthropic', getModel: () => 'claude-sonnet-5' } as never;

    await expect(
      channel.start({ port: 0, host: '0.0.0.0', provider, cwd: process.cwd() } as never),
    ).rejects.toThrow(/拒绝启动/);
  });
});
