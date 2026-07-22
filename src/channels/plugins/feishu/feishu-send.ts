// ============================================================
// Feishu 消息发送
// ============================================================
//
// 封装飞书消息发送 API：
//   - sendText: 发送文本（使用 post 格式支持富文本）
//   - sendCard: 发送交互式卡片
//   - replyInThread: 话题回复
// ============================================================

import type * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuClient } from './feishu-client.js';
import type { FeishuChannelConfig } from './feishu-config.js';

// ── 发送结果 ──

export interface FeishuSendResult {
  messageId: string;
  chatId: string;
}

// ── 发送目标解析 ──

interface SendTarget {
  receiveId: string;
  receiveIdType: 'open_id' | 'chat_id' | 'user_id';
}

/**
 * 解析发送目标
 * 支持格式：user:open_id, chat:chat_id, open_id, chat_id
 */
function resolveSendTarget(to: string): SendTarget {
  const trimmed = to.trim();

  // 去掉前缀（user: / chat: / open_id:），只保留裸 ID
  let id = trimmed;
  if (trimmed.startsWith('user:')) id = trimmed.slice(5);
  else if (trimmed.startsWith('chat:')) id = trimmed.slice(5);
  else if (trimmed.startsWith('open_id:')) id = trimmed.slice(8);

  // 根据 ID 前缀推断正确的 receive_id_type
  // 飞书：ou_ → open_id, oc_ → chat_id
  if (id.startsWith('oc_')) {
    return { receiveId: id, receiveIdType: 'chat_id' };
  }
  if (id.startsWith('ou_')) {
    return { receiveId: id, receiveIdType: 'open_id' };
  }

  // 有显式前缀时按前缀语义处理
  if (trimmed.startsWith('chat:')) {
    return { receiveId: id, receiveIdType: 'chat_id' };
  }
  if (trimmed.startsWith('open_id:') || trimmed.startsWith('user:')) {
    return { receiveId: id, receiveIdType: 'open_id' };
  }

  // 无法推断，默认按 open_id 处理
  return { receiveId: id, receiveIdType: 'open_id' };
}

// ── 构建 Post 消息体 ──

/**
 * 构建 Feishu Post 格式消息（支持 Markdown 子集）
 */
function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [
        [
          {
            tag: 'md',
            text,
          },
        ],
      ],
    },
  });
}

// ── 发送消息 ──

/**
 * 发送文本消息
 */
export async function sendText(
  config: FeishuChannelConfig,
  params: {
    to: string;
    text: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
  },
): Promise<FeishuSendResult> {
  const client = await createFeishuClient(config);
  const { receiveId, receiveIdType } = resolveSendTarget(params.to);
  const content = buildPostContent(params.text);

  // 如果有回复目标，使用 reply 接口
  if (params.replyToMessageId) {
    try {
      const res = await client.im.message.reply({
        path: { message_id: params.replyToMessageId },
        data: {
          content,
          msg_type: 'post',
          ...(params.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      if (res.code !== 0) {
        throw new Error(`Feishu reply failed: ${res.msg || `code ${res.code}`}`);
      }
      return {
        messageId: res.data?.message_id ?? '',
        chatId: receiveId,
      };
    } catch (err) {
      enrichFeishuError(err, { api: 'reply', receiveId, receiveIdType });
      throw err;
    }
  }

  // 直接发送
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content,
        msg_type: 'post',
      },
    });
    if (res.code !== 0) {
      throw new Error(`Feishu send failed: ${res.msg || `code ${res.code}`}`);
    }
    return {
      messageId: res.data?.message_id ?? '',
      chatId: receiveId,
    };
  } catch (err) {
    enrichFeishuError(err, { api: 'send', receiveId, receiveIdType });
    throw err;
  }
}

/** 将飞书请求上下文注入到错误对象上，便于上层日志记录 */
function enrichFeishuError(
  err: unknown,
  ctx: { api: string; receiveId: string; receiveIdType: string },
): void {
  if (err instanceof Error) {
    const enriched = err as Error & { feishuContext?: unknown; feishuResponse?: unknown };
    enriched.feishuContext = ctx;
    // 尝试从 SDK 错误对象上提取响应体
    const sdkErr = err as any;
    if (sdkErr.response?.data) {
      enriched.feishuResponse = sdkErr.response.data;
    } else if (sdkErr.data) {
      enriched.feishuResponse = sdkErr.data;
    }
  }
}

/**
 * 发送交互式卡片消息
 */
export async function sendCard(
  config: FeishuChannelConfig,
  params: {
    to: string;
    card: Record<string, unknown>;
    replyToMessageId?: string;
    replyInThread?: boolean;
  },
): Promise<FeishuSendResult> {
  const client = await createFeishuClient(config);
  const { receiveId, receiveIdType } = resolveSendTarget(params.to);
  const content = JSON.stringify(params.card);

  if (params.replyToMessageId) {
    const res = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: {
        content,
        msg_type: 'interactive',
        ...(params.replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    if (res.code !== 0) {
      throw new Error(`Feishu card reply failed: ${res.msg || `code ${res.code}`}`);
    }
    return {
      messageId: res.data?.message_id ?? '',
      chatId: receiveId,
    };
  }

  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: 'interactive',
    },
  });

  if (res.code !== 0) {
    throw new Error(`Feishu card send failed: ${res.msg || `code ${res.code}`}`);
  }

  return {
    messageId: res.data?.message_id ?? '',
    chatId: receiveId,
  };
}

/**
 * 构建简单的 Markdown 卡片
 * 用于 Markdown 渲染（代码块、表格、链接等）
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * 更新已发送的卡片消息
 * 用于流式输出：先发送占位卡片，然后不断更新内容
 */
export async function patchCard(
  config: FeishuChannelConfig,
  params: {
    messageId: string;
    card: Record<string, unknown>;
  },
): Promise<void> {
  const client = await createFeishuClient(config);
  const content = JSON.stringify(params.card);

  const res = await client.im.message.patch({
    path: { message_id: params.messageId },
    data: {
      content: JSON.stringify({
        type: 'interactive',
        content,
      }),
    },
  });

  if (res.code !== 0) {
    throw new Error(`Feishu card patch failed: ${res.msg || `code ${res.code}`}`);
  }
}

/**
 * 获取发送者信息
 */
export async function getSenderInfo(
  config: FeishuChannelConfig,
  userId: string,
  userIdType: 'open_id' | 'user_id' = 'open_id',
): Promise<{ name?: string; avatar?: string } | null> {
  try {
    const client = await createFeishuClient(config);
    const res = await client.contact.user.get({
      path: { user_id: userId },
      params: { user_id_type: userIdType },
    });

    if (res.code !== 0) return null;

    return {
      name: res.data?.user?.name || undefined,
      avatar: res.data?.user?.avatar?.avatar_72 || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 发送图片消息（需先通过上传 API 获取 image_key）。
 */
export async function sendImage(
  config: FeishuChannelConfig,
  params: { to: string; imageKey: string },
): Promise<FeishuSendResult> {
  const client = await createFeishuClient(config);
  const { receiveId, receiveIdType } = resolveSendTarget(params.to);
  const content = JSON.stringify({ image_key: params.imageKey });

  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: 'image',
    },
  });

  if (res.code !== 0) {
    throw new Error(`飞书图片发送失败: ${res.msg || `code ${res.code}`}`);
  }

  return {
    messageId: res.data?.message_id ?? '',
    chatId: receiveId,
  };
}