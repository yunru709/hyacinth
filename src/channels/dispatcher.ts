// ============================================================
// MessageDispatcher — 跨渠道消息分发层
// ============================================================
//
// 设计意图：
//   Hyacinth 的渠道系统原本是"请求-回复"模式——用户在某个渠道发消息，
//   Agent 通过同一个渠道的 reply() 回复。但这限制了 Agent 的能力：
//   TUI 会话中的 Agent 无法通过飞书发图片，飞书会话中的 Agent 也无法
//   通过微信传文件。每个渠道的发送能力被封闭在自己的生命周期里。
//
//   MessageDispatcher 打破了这个封闭——它让 Agent 可以从任意会话
//   借用任意已连接渠道的发送能力。这是"跨渠道"而非"跨会话"——
//   借用的是渠道的 API 能力，不影响任何渠道的对话状态。
//
// 核心语义（"纯借用"）：
//   1. 不创建 session —— 消息是一次性的，不关联 AgentLoop
//   2. 不写 conversation.jsonl —— 不污染任何渠道的对话历史
//   3. 不影响 ChannelHandler 内部状态 —— sessionMap、消息队列等完全不变
//   4. 被借用渠道对"谁借的"完全无感 —— 不记录调用来源
//
// 调用链：
//   Agent → send_channel_message({channel:'feishu', to:'ou_xxx', text:'...'})
//        → MessageDispatcher.send()
//          → ChannelManager.get('feishu') → handler.send(target, content)
//            → 渠道 API → 用户收到消息
//
// 扩展新渠道时：
//   只需实现 ChannelHandler.send?() 方法（可选），MessageDispatcher 自动发现。
//   不实现 send() 的渠道返回 "不支持主动发送"，不影响其他功能。
// ============================================================

import type { Tool } from '../tools/interface.js';
import type { ChannelManager } from './manager.js';
import type { ChannelTarget } from './interface.js';

/**
 * MessageDispatcher — 跨渠道统一分发层。
 *
 * 持有 ChannelManager 引用，按渠道 ID 查找目标渠道并调用其 send() 方法。
 * 本身无状态——每次调用都是独立的、一次性的。
 */
export class MessageDispatcher {
  constructor(private channelManager: ChannelManager) {}

  /**
   * 借用指定渠道发送消息。
   *
   * @returns 发送结果描述字符串，失败时包含错误原因（不抛异常，始终返回字符串）
   */
  async send(args: {
    /** 目标渠道 ID（如 'feishu'、'clawbot'） */
    channel: string;
    /** 目标用户 ID 或群聊 ID */
    to: string;
    /** 目标类型，默认 user */
    targetType?: 'user' | 'chat';
    /** 文本内容（可选，与 images 至少有一项有意义） */
    text?: string;
    /** 图片列表（base64 + MIME 类型） */
    images?: Array<{ data: string; media_type: string }>;
  }): Promise<string> {
    // ① 查找目标渠道
    const state = this.channelManager.get(args.channel);
    if (!state || state.status !== 'active') {
      return `渠道 "${args.channel}" 未连接或未启动。可用渠道: ${this.channelManager.getStatusSummary().map(s => s.id).join(', ') || '无'}`;
    }

    const handler = state.handler;

    // ② 检查渠道是否支持主动发送
    if (!handler.send) {
      return `渠道 "${args.channel}" (${handler.name}) 不支持主动发送。`;
    }

    // ③ 构造标准目标并委托给渠道的 send()
    const target: ChannelTarget = {
      type: args.targetType ?? 'user',
      id: args.to,
    };

    try {
      return await handler.send(target, {
        content: args.text ?? '',
        images: args.images,
      });
    } catch (err) {
      // 异常兜底——渠道 send() 应该自己 catch，这里防止未预期的异常泄漏
      return `发送失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * send_channel_message 工具 —— 暴露给 Agent 的跨渠道发送入口。
 *
 * Agent 在任何渠道的任意会话中都可以调用此工具，借用其他已连接渠道
 * 的发送能力。典型场景：TUI 会话中的 Agent 通过飞书发图片给用户，
 * 或者定时任务触发后通过微信推送通知。
 *
 * 此工具注册在 TUI/Server 的网关层（gateway/tui.ts、gateway/server.ts），
 * 在 channelManager.startAll() 之后注册，确保所有渠道已启动。
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
