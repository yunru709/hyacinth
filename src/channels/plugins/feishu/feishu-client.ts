// ============================================================
// Feishu 客户端封装
// ============================================================
//
// 封装 @larksuiteoapi/node-sdk 的 Client、WSClient、EventDispatcher
// 复用 OpenClaw 的缓存策略和超时处理思路。
// ============================================================

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuChannelConfig } from './feishu-config.js';

// ── 域名解析 ──

/**
 * SDK 的 Domain 枚举: Feishu=0, Lark=1
 * 也可以传完整 URL 字符串（如 "https://open.feishu.cn"）
 * 不能传 "feishu" / "lark" 这种短字符串——SDK 会原样拼接导致 Invalid URL
 */
function resolveDomain(config: FeishuChannelConfig): number {
  if (config.domain === 'lark') return 1; // Domain.Lark
  return 0; // Domain.Feishu
}

// ── Client 缓存 ──

interface CachedClient {
  client: Lark.Client;
  configHash: string;
}

function configHash(config: FeishuChannelConfig): string {
  return `${config.appId}:${config.appSecret}:${config.domain}`;
}

// ── FeishuClientFactory ──

export class FeishuClientFactory {
  private larkSDK: typeof Lark | null = null;
  private clientCache = new Map<string, CachedClient>();

  private async getSDK(): Promise<typeof Lark> {
    if (!this.larkSDK) {
      this.larkSDK = await import('@larksuiteoapi/node-sdk');
    }
    return this.larkSDK;
  }

  async createClient(config: FeishuChannelConfig): Promise<Lark.Client> {
    const lark = await this.getSDK();
    const hash = configHash(config);
    const cached = this.clientCache.get('default');
    if (cached && cached.configHash === hash) {
      return cached.client;
    }
    const client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: resolveDomain(config),
    });
    this.clientCache.set('default', { client, configHash: hash });
    return client;
  }

  async createWSClient(
    config: FeishuChannelConfig,
    callbacks: {
      onError?: (error: Error) => void;
      onReady?: () => void;
      onReconnected?: () => void;
      onReconnecting?: () => void;
    } = {},
  ): Promise<Lark.WSClient> {
    const lark = await this.getSDK();
    return new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config),
      loggerLevel: lark.LoggerLevel.warn,
      ...callbacks,
    });
  }

  async createDispatcher(): Promise<Lark.EventDispatcher> {
    const lark = await this.getSDK();
    return new lark.EventDispatcher({});
  }

  getCachedClient(): Lark.Client | null {
    return this.clientCache.get('default')?.client ?? null;
  }

  clearCache(): void {
    this.clientCache.clear();
  }
}

// ── 模块级便捷函数（向后兼容） ──

const defaultFactory = new FeishuClientFactory();

export async function createFeishuClient(config: FeishuChannelConfig): Promise<Lark.Client> {
  return defaultFactory.createClient(config);
}

export function getCachedClient(): Lark.Client | null {
  return defaultFactory.getCachedClient();
}

export function clearClientCache(): void {
  defaultFactory.clearCache();
}

export async function createFeishuWSClient(
  config: FeishuChannelConfig,
  callbacks: Parameters<FeishuClientFactory['createWSClient']>[1] = {},
): Promise<Lark.WSClient> {
  return defaultFactory.createWSClient(config, callbacks);
}

export async function createEventDispatcher(): Promise<Lark.EventDispatcher> {
  return defaultFactory.createDispatcher();
}
