// ============================================================
// MessageDispatcher — 跨渠道消息分发层
// ============================================================
//
// 允许 Agent 从任意会话借用其他渠道的发送能力。
// 消息是一次性的——不创建 session、不写 conversation、不影响任何渠道的对话状态。
// 被借用的渠道对"谁借了道"完全无感。
// ============================================================

import type { Tool } from '../tools/interface.js';
import type { ChannelManager } from './manager.js';
import type { ChannelTarget } from './interface.js';

/**
 * MessageDispatcher — 统一分发层。
 * 查目标渠道 → 调其 send() → 返回结果。
 */
export class MessageDispatcher {
  constructor(private channelManager: ChannelManager) {}

  async send(args: {
    channel: string;
    to: string;
    targetType?: 'user' | 'chat';
    text?: string;
    images?: Array<{ data: string; media_type: string }>;
  }): Promise<string> {
    const state = this.channelManager.get(args.channel);
    if (!state || state.status !== 'active') {
      return `渠道 "${args.channel}" 未连接或未启动。可用渠道: ${this.channelManager.getStatusSummary().map(s => s.id).join(', ') || '无'}`;
    }

    const handler = state.handler;
    if (!handler.send) {
      return `渠道 "${args.channel}" (${handler.name}) 不支持主动发送。`;
    }

    const target: ChannelTarget = {
      type: args.targetType ?? 'user',
      id: args.to,
    };

    try {
      const result = await handler.send(target, {
        content: args.text ?? '',
        images: args.images,
      });
      return result;
    } catch (err) {
      return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * send_channel_message 工具——暴露给 Agent 的跨渠道发送能力。
 */
export function createSendChannelMessageTool(dispatcher: MessageDispatcher): Tool {
  return {
    name: 'send_channel_message',
    description:
      '借用指定渠道发送消息到目标用户或群聊。纯借用渠道能力——不创建会话、不写入对话记录、不影响其他渠道。' +
      '适用于从当前渠道（如 TUI）通过飞书/微信等渠道向用户发送通知、图片或文件。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: '目标渠道 ID。可用 channel_info 查看已连接渠道。如 "feishu"、"clawbot"。',
        },
        to: {
          type: 'string',
          description: '目标用户 ID 或群聊 ID。飞书为 open_id 或 chat_id，微信为 wxid。',
        },
        target_type: {
          type: 'string',
          enum: ['user', 'chat'],
          description: '目标类型。user=私聊，chat=群聊。默认 user。',
        },
        text: {
          type: 'string',
          description: '要发送的文本内容。',
        },
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              data: { type: 'string', description: '图片的 base64 数据' },
              media_type: { type: 'string', description: 'MIME 类型，如 image/png' },
            },
          },
          description: '要发送的图片列表（base64 + MIME 类型）。',
        },
      },
      required: ['channel', 'to'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      return dispatcher.send({
        channel: args.channel as string,
        to: args.to as string,
        targetType: (args.target_type as 'user' | 'chat') ?? 'user',
        text: (args.text as string) || undefined,
        images: args.images as Array<{ data: string; media_type: string }> | undefined,
      });
    },
  };
}
