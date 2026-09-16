// ============================================================
// Feishu 渠道插件 — 导出入口
// ============================================================
//
// 使用方式：
//   import { createFeishuChannel } from './channels/plugins/feishu/index.js';
//   channelManager.register(createFeishuChannel(), feishuConfig);
// ============================================================

import { FeishuChannel, FEISHU_SESSION_PREFIX } from './feishu-channel.js';
import { registerChannelPrefixes } from '../../../session-channel.js';
import type { ChannelPlugin } from '../../auto-detect.js';
import type { ChannelManager } from '../../manager.js';
import type { ChannelsInfo } from '../../../env/index.js';
import type { FeishuChannelConfigEntry } from '../../../setup/config.js';
import { createLogger } from '../../../logging/logger.js';
import { installSDKLogSuppressor } from './feishu-log-suppressor.js';

const logger = createLogger('feishu-plugin');

export { FeishuChannel } from './feishu-channel.js';
export { FeishuTransport } from './feishu-transport.js';
export {
  resolveFeishuConfig,
  validateFeishuConfig,
  type FeishuChannelConfig,
  type FeishuConnectionMode,
  type FeishuDmPolicy,
  type FeishuGroupPolicy,
} from './feishu-config.js';
export {
  parseFeishuMessageEvent,
  parseMessageContent,
  checkBotMentioned,
  checkMessageDedupe,
  FeishuDedupeStore,
  checkDmAccess,
  checkGroupAccess,
  type FeishuMessageEvent,
  type FeishuMessageContext,
} from './feishu-event.js';
export { installSDKLogSuppressor } from './feishu-log-suppressor.js';
export {
  createFeishuClient,
  createFeishuWSClient,
  createEventDispatcher,
  getCachedClient,
  clearClientCache,
  FeishuClientFactory,
} from './feishu-client.js';
export {
  sendText,
  sendCard,
  patchCard,
  buildMarkdownCard,
  getSenderInfo,
  type FeishuSendResult,
} from './feishu-send.js';
export { FeishuStreamingCard } from './feishu-streaming.js';
export {
  ChannelSessionPool,
  createCollectHandler,
  type CollectHandler,
  type SessionRunner,
  type SessionEntry,
  type SessionMode,
} from './feishu-session.js';

/**
 * 创建飞书渠道实例（便捷工厂函数）
 */
export function createFeishuChannel(): FeishuChannel {
  return new FeishuChannel();
}

/**
 * 飞书渠道自动注册插件
 */
export const feishuChannelPlugin: ChannelPlugin = {
  configKey: 'feishu',

  onGatewayInit(): () => void {
    return installSDKLogSuppressor();
  },

  async autoRegister(
    channelManager: ChannelManager,
    config: unknown,
    channelsInfo: ChannelsInfo[],
  ): Promise<void> {
    // ── session 前缀登记（**必须在 enabled/appId 判断之前**）──
    // 飞书未启用时渠道不注册，但存量 feishu_xxx 会话仍要能推断出渠道归属，
    // 故此处无条件登记。本钩子对每个已发现插件都会执行，与 enabled 无关。
    registerChannelPrefixes(FEISHU_SESSION_PREFIX, 'feishu');

    const feishuConfig = config as FeishuChannelConfigEntry | undefined;
    const shouldRun = feishuConfig?.enabled !== false && feishuConfig?.appId && feishuConfig?.appSecret;

    if (!shouldRun || !feishuConfig) {
      return;
    }

    logger.info('auto-detected feishu channel, registering...');

    channelManager.register(createFeishuChannel(), {
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      domain: feishuConfig.domain,
      dmPolicy: feishuConfig.dmPolicy,
      allowFrom: feishuConfig.allowFrom,
      groupPolicy: feishuConfig.groupPolicy,
      groupAllowFrom: feishuConfig.groupAllowFrom,
      requireMention: feishuConfig.requireMention,
      resolveSenderNames: feishuConfig.resolveSenderNames,
      tuiSync: feishuConfig.tuiSync,
      sessionMode: feishuConfig.sessionMode,
    });

    channelsInfo.push({
      name: 'feishu',
      displayName: '飞书',
      connectionMode: 'websocket',
      dmPolicy: feishuConfig.dmPolicy ?? 'allowlist',
      groupPolicy: feishuConfig.groupPolicy ?? 'allowlist',
      requireMention: feishuConfig.requireMention ?? true,
    });
  },
};

/** 插件自动发现约定的导出名 */
export { feishuChannelPlugin as channelPlugin };