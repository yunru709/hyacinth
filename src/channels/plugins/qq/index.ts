// ============================================================
// QQ 渠道插件 — 导出入口
// ============================================================
//
// 自动发现：框架启动时扫描 channels/plugins/ 下的子目录，
// 自动加载导出 `channelPlugin` 的模块（见 auto-detect.ts:discoverPlugins）。
//
// 配置位置：~/.agent/config.json 的 channels.qq
// ============================================================

import type { ChannelPlugin } from '../../auto-detect.js';
import type { ChannelManager } from '../../manager.js';
import type { ChannelsInfo } from '../../../env/index.js';
import type { QqChannelConfigEntry } from '../../../setup/config.js';
import { createQqChannel, QqChannel, QQ_SESSION_PREFIX } from './qq-channel.js';
import { registerChannelPrefixes } from '../../../session-channel.js';
import { createLogger } from '../../../logging/logger.js';

const logger = createLogger('qq-plugin');

export { QqChannel, createQqChannel, QQ_SESSION_PREFIX } from './qq-channel.js';
export { QqClient, extractText, isMentioned, chunkText } from './qq-client.js';
export type { Ob11MessageEvent, Ob11AnyEvent, Ob11MessageSegment } from './qq-client.js';
export {
  resolveQqConfig,
  validateQqConfig,
  isAllowedUser,
  isAllowedGroup,
  type QqChannelConfig,
} from './qq-config.js';

/**
 * QQ 渠道自动注册插件
 *
 * ⚠️ session 前缀登记必须在 enabled 判断之前 —— 与 feishu/clawbot 同理：
 * 渠道禁用时存量 qq_xxx 会话仍要能推断出渠道归属，否则会话列表里归属丢失。
 */
export const qqChannelPlugin: ChannelPlugin = {
  configKey: 'qq',

  async autoRegister(
    channelManager: ChannelManager,
    config: unknown,
    channelsInfo: ChannelsInfo[],
  ): Promise<void> {
    registerChannelPrefixes(QQ_SESSION_PREFIX, 'qq');

    const qqConfig = config as QqChannelConfigEntry | undefined;
    const enabled = qqConfig?.enabled === true;
    const allowFrom = qqConfig?.allowFrom ?? [];

    if (!enabled) {
      logger.info('QQ channel configured but disabled (channels.qq.enabled != true)');
      return;
    }

    if (allowFrom.length === 0) {
      // 启用了但白名单空 = 配置事故（所有消息都会被拒）。不启动，但大声喊。
      logger.error('QQ channel enabled but allowFrom is EMPTY — all messages would be rejected. Add your QQ number to channels.qq.allowFrom.');
      return;
    }

    logger.info(`auto-detected QQ channel, registering (allowFrom=${allowFrom.join(',')})`);

    channelManager.register(createQqChannel(), {
      enabled: true,
      httpUrl: qqConfig?.httpUrl ?? 'http://127.0.0.1:3000',
      wsUrl: qqConfig?.wsUrl ?? 'ws://127.0.0.1:3001',
      accessToken: qqConfig?.accessToken ?? '',
      allowFrom,
      groupAllowFrom: qqConfig?.groupAllowFrom ?? [],
      requireMention: qqConfig?.requireMention ?? true,
      selfId: qqConfig?.selfId ?? '',
      tuiSync: qqConfig?.tuiSync ?? false,
      textChunkLimit: qqConfig?.textChunkLimit ?? 4000,
      httpTimeoutMs: qqConfig?.httpTimeoutMs ?? 15_000,
      reconnectIntervalMs: qqConfig?.reconnectIntervalMs ?? 3_000,
    });

    channelsInfo.push({
      name: 'qq',
      displayName: 'QQ',
      connectionMode: 'websocket',
      dmPolicy: 'allowlist',
      groupPolicy: (qqConfig?.groupAllowFrom ?? []).length > 0 ? 'allowlist' : 'disabled',
      requireMention: qqConfig?.requireMention ?? true,
    });
  },
};

/** 插件自动发现约定的导出名 */
export { qqChannelPlugin as channelPlugin };
