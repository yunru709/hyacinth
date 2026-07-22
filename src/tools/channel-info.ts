import type { Tool } from './interface.js';
import type { ChannelsInfo } from '../env/env-collector.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('channel-info');

/** 渠道信息缓存（由 factory.ts 在启动时注入） */
let cachedChannels: ChannelsInfo[] = [];

export function setChannelsInfo(channels: ChannelsInfo[]): void {
  cachedChannels = channels;
}

function formatChannelsInfo(channels: ChannelsInfo[]): string {
  if (channels.length === 0) {
    return 'No external channels connected. Only the built-in TUI/HTTP API channels are active.';
  }

  const lines: string[] = ['Connected channels:'];

  for (const ch of channels) {
    const connInfo = ch.isGroup ? 'group' : 'DM';
    lines.push(`- ${ch.displayName} (${ch.name}) [${connInfo}]:`);
    lines.push(`  Connection mode: ${ch.connectionMode}`);
    lines.push(`  DM policy: ${ch.dmPolicy} | Group policy: ${ch.groupPolicy}`);
    lines.push(`  Require @mention: ${ch.requireMention ? 'yes' : 'no'}`);
    if (ch.sessionId) {
      lines.push(`  Current session: ${ch.sessionId}`);
    }
  }

  return lines.join('\n');
}

export function createChannelInfoTool(): Tool {
  return {
    name: 'channel_info',
    description:
      '查询当前外部渠道配置：已连接的渠道列表、连接模式、私聊/群聊策略、是否需要 @提及。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      return formatChannelsInfo(cachedChannels);
    },
  };
}
