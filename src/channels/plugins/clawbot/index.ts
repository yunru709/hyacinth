// ============================================================
// ClawBot 渠道插件 — 导出入口
// ============================================================
//
// 使用方式：
//   import { createClawbotChannel } from './channels/plugins/clawbot/index.js';
//   channelManager.register(createClawbotChannel(), clawbotConfig);
//
// 自动发现：
//   框架会在启动时扫描 channels/plugins/ 下的子目录，
//   自动加载导出 channelPlugin 的模块。
// ============================================================

import type { ChannelPlugin } from '../../auto-detect.js';
import type { ChannelManager } from '../../manager.js';
import type { ChannelsInfo } from '../../../env/index.js';
import type { ClawbotChannelConfigEntry } from '../../../setup/config.js';
import { createClawbotChannel, ClawbotChannel } from './clawbot-channel.js';
import { createLogger } from '../../../logging/logger.js';

const logger = createLogger('clawbot-plugin');

export { ClawbotChannel, createClawbotChannel } from './clawbot-channel.js';
export { ClawbotClient, ClawbotAPIError } from './clawbot-client.js';
export type {
  QRCodeResult,
  QRCodeStatus,
  QRCodeStatusResult,
  MessageItemType,
  MessageType,
  MessageState,
  TextItem,
  ImageItem,
  MessageItem,
  ClawbotIncomingMessage,
  ClawbotOutgoingMessage,
  GetUpdatesResponse,
} from './clawbot-client.js';
export { ClawbotAuthManager } from './clawbot-auth.js';
export type { AuthCallbacks } from './clawbot-auth.js';
export {
  resolveClawbotConfig,
  validateClawbotConfig,
  type ClawbotChannelConfig,
} from './clawbot-config.js';
export { ClawbotMessageQueue } from './clawbot-message-queue.js';
export { createCollectHandler } from './clawbot-session.js';
export type { CollectHandler, SessionRunner } from './clawbot-session.js';

/**
 * ClawBot 渠道自动注册插件
 */
export const clawbotChannelPlugin: ChannelPlugin = {
  configKey: 'clawbot',

  async autoRegister(
    channelManager: ChannelManager,
    config: unknown,
    channelsInfo: ChannelsInfo[],
  ): Promise<void> {
    const clawbotConfig = config as ClawbotChannelConfigEntry | undefined;
    const shouldRun = clawbotConfig?.enabled !== false;

    if (!shouldRun) {
      return;
    }

    logger.info('auto-detected clawbot channel, registering...');

    channelManager.register(createClawbotChannel(), {
      botToken: clawbotConfig?.botToken ?? '',
      botId: clawbotConfig?.botId ?? '',
      userId: clawbotConfig?.userId ?? '',
      baseUrl: clawbotConfig?.baseUrl ?? 'https://ilinkai.weixin.qq.com',
      tuiSync: clawbotConfig?.tuiSync ?? false,
      textChunkLimit: clawbotConfig?.textChunkLimit ?? 2000,
      autoRefreshToken: clawbotConfig?.autoRefreshToken ?? true,
      httpTimeoutMs: clawbotConfig?.httpTimeoutMs ?? 30_000,
      pollTimeoutSec: clawbotConfig?.pollTimeoutSec ?? 28,
      pollRetryIntervalMs: clawbotConfig?.pollRetryIntervalMs ?? 3000,
    });

    channelsInfo.push({
      name: 'clawbot',
      displayName: '微信 ClawBot',
      connectionMode: 'http-polling',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      requireMention: false,
    });
  },
};

/** 插件自动发现约定的导出名 */
export { clawbotChannelPlugin as channelPlugin };
