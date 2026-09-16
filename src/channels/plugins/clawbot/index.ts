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
import { createClawbotChannel, ClawbotChannel, CLAWBOT_SESSION_PREFIX } from './clawbot-channel.js';
import { registerChannelPrefixes } from '../../../session-channel.js';
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
    // ── session 前缀登记（**必须在 enabled 判断之前**）──
    // 插件被禁用时渠道不注册，但存量 clawbot_xxx 会话仍要能推断出渠道归属，
    // 故此处无条件登记。本钩子对每个已发现插件都会执行，与 enabled 无关。
    registerChannelPrefixes(CLAWBOT_SESSION_PREFIX, 'clawbot');

    const clawbotConfig = config as ClawbotChannelConfigEntry | undefined;
    const shouldRun = clawbotConfig?.enabled !== false;

    // ── 无条件注册（注册 ≠ 连接）──
    // 早先 `enabled: false` 直接 return，渠道不进注册表 → `/clawbot/login` 分派不到
    // （通道分派要 channelManager.get('clawbot')）→ 报 Unknown sub-command。而登录
    // 命令恰恰是「从零授权」的入口，于是构成鸡生蛋死结：不先启用就登不进去，可登录
    // 本身又不需要事先启用。
    // 现在始终注册并交 ChannelManager 托管启动 —— 注意这里的 `enabled: true` 指
    // **是否纳入生命周期管理**，不是用户配置里的那个 enabled。是否真正连接微信由
    // `autoConnect` 决定：shouldRun=false → 只建好扫码授权通道，不恢复 token、
    // 不连接、不轮询。于是 /clawbot login 恒定可达，用户显式登录后即直接接入。
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
      // 纳入生命周期管理（始终启动），连接与否见 autoConnect
      enabled: true,
      // 用户配置的 enabled 直通渠道：false 时 start() 只备授权通道、不连接
      autoConnect: shouldRun,
    });

    // 未启用时不对外宣告该渠道（channelsInfo 会注入 System Prompt，避免误导模型
    // 以为微信已可用）
    if (shouldRun) {
      channelsInfo.push({
        name: 'clawbot',
        displayName: '微信 ClawBot',
        connectionMode: 'http-polling',
        dmPolicy: 'open',
        groupPolicy: 'disabled',
        requireMention: false,
      });
    }
  },
};

/** 插件自动发现约定的导出名 */
export { clawbotChannelPlugin as channelPlugin };
