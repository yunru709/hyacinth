// ============================================================
// Feishu WebSocket 传输管理
// ============================================================
//
// 管理 WebSocket 连接生命周期：
//   - 连接建立（SDK 内置自动重连）
//   - 事件注册与分发
// ============================================================

import type * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuWSClient, createEventDispatcher } from './feishu-client.js';
import type { FeishuChannelConfig } from './feishu-config.js';
import type { FeishuMessageEvent } from './feishu-event.js';

// ── 日志 ──

type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

function defaultLogger(): Logger {
  return {
    info: (msg) => process.stderr.write(`[feishu-ws] ${msg}\n`),
    error: (msg) => process.stderr.write(`[feishu-ws] ${msg}\n`),
  };
}

// ── 传输管理器 ──

export class FeishuTransport {
  private config: FeishuChannelConfig;
  private logger: Logger;
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private messageHandler: ((event: FeishuMessageEvent) => Promise<void>) | null = null;

  constructor(config: FeishuChannelConfig, log?: Logger) {
    this.config = config;
    this.logger = log ?? defaultLogger();
  }

  // ── 生命周期 ──

  /**
   * 启动 WebSocket 连接。
   * SDK 内置 autoReconnect（默认 true），断开后会自动重连，无需外层循环。
   */
  async start(): Promise<void> {
    this.logger.info('starting WebSocket connection...');

    // 创建事件分发器
    this.eventDispatcher = await createEventDispatcher();

    // 注册消息事件
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        // SDK RequestHandle.parse() 将 header 字段展平到顶层
        const flatData = data as Record<string, unknown>;
        const event = (flatData as unknown) as FeishuMessageEvent;
        // 从顶层提取 event_id（SDK 展平后不再有嵌套 header）
        const eventId = flatData.event_id as string | undefined;
        if (event && typeof event === 'object' && eventId) {
          (event as unknown as Record<string, unknown>)._eventId = eventId;
        }
        if (this.messageHandler) {
          this.messageHandler(event).catch((err) => {
            this.logger.error(`message handler error: ${String(err)}`);
          });
        } else {
          this.logger.error('message received but no handler registered');
        }
      },
    });

    // 创建 WSClient（SDK 自动处理重连）
    this.wsClient = await createFeishuWSClient(this.config, {
      onError: (err) => {
        this.logger.error(`WebSocket error: ${err.message}`);
      },
      onReady: () => {
        this.logger.info('WebSocket connected');
      },
      onReconnecting: () => {
        this.logger.info('WebSocket reconnecting...');
      },
      onReconnected: () => {
        this.logger.info('WebSocket reconnected');
      },
    });

    // 启动连接（SDK 后台保持，断开后自动重连）
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.logger.info('WebSocket client started');
  }

  /**
   * 停止 WebSocket 连接
   */
  async stop(): Promise<void> {
    this.logger.info('stopping WebSocket...');
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // 忽略关闭错误
      }
      this.wsClient = null;
    }
    this.messageHandler = null;
  }

  /**
   * 注册消息处理回调
   */
  onMessage(handler: (event: FeishuMessageEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }
}