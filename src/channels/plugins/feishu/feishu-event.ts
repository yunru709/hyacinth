// ============================================================
// Feishu 事件解析
// ============================================================
//
// 解析飞书消息事件，包括：
//   - 消息内容提取（text/post/interactive 格式）
//   - 提及检测（@bot 判断）
//   - 消息去重
// ============================================================

// ── 飞书消息事件原始类型 ──

export interface FeishuMessageEvent {
  /** SDK 事件 ID（来自 header.event_id，用于去重） */
  _eventId?: string;
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string; // 'p2p' | 'group' | 'topic_group' | 'private'
    message_type: string; // 'text' | 'post' | 'interactive' | ...
    content: string; // JSON 字符串
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string };
      name: string;
    }>;
    create_time?: string; // 毫秒时间戳字符串
  };
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
}

// ── 解析后的消息上下文 ──

export interface FeishuMessageContext {
  messageId: string;
  chatId: string;
  chatType: string;
  isGroup: boolean;
  senderOpenId: string;
  senderUserId?: string;
  content: string;
  contentType: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentionedBot: boolean;
  /** 发送者显示名称（后续解析） */
  senderName?: string;
  /** 消息创建时间（毫秒） */
  createTimeMs?: number;
}

// ── 内容解析 ──

/**
 * 解析文本消息内容
 */
function parseTextContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return rawContent;
  }
}

/**
 * 解析富文本（post）消息内容
 */
function parsePostContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    // post 格式: { "zh_cn": { "content": [[{ "tag": "text", "text": "..." }]] } }
    const content = parsed?.zh_cn?.content || parsed?.content;
    if (!Array.isArray(content)) return '';

    const lines: string[] = [];
    for (const paragraph of content) {
      if (!Array.isArray(paragraph)) continue;
      const lineParts: string[] = [];
      for (const element of paragraph) {
        if (element?.tag === 'text' && typeof element.text === 'string') {
          lineParts.push(element.text);
        } else if (element?.tag === 'a' && typeof element.text === 'string') {
          lineParts.push(element.text);
        } else if (element?.tag === 'at' && typeof element.user_name === 'string') {
          lineParts.push(`@${element.user_name}`);
        }
      }
      if (lineParts.length > 0) lines.push(lineParts.join(''));
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 解析交互式卡片（interactive）消息内容
 */
function parseInteractiveContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    // 从卡片元素中提取文本
    const elements = parsed?.body?.elements || parsed?.elements;
    if (!Array.isArray(elements)) return '[Interactive Card]';

    const texts: string[] = [];
    for (const el of elements) {
      if (el?.tag === 'markdown' || el?.tag === 'lark_md') {
        if (typeof el.content === 'string') texts.push(el.content);
      } else if (el?.tag === 'plain_text') {
        if (typeof el.content === 'string') texts.push(el.content);
      } else if (el?.tag === 'div' && el?.text && typeof el.text.content === 'string') {
        texts.push(el.text.content);
      }
    }
    return texts.length > 0 ? texts.join('\n') : '[Interactive Card]';
  } catch {
    return '[Interactive Card]';
  }
}

/**
 * 解析飞书消息内容
 */
export function parseMessageContent(rawContent: string, msgType: string): string {
  if (!rawContent) return '';

  switch (msgType) {
    case 'text':
      return parseTextContent(rawContent);
    case 'post':
      return parsePostContent(rawContent);
    case 'interactive':
      return parseInteractiveContent(rawContent);
    default:
      // 尝试作为 JSON 解析
      try {
        const parsed = JSON.parse(rawContent);
        if (typeof parsed === 'string') return parsed;
        if (parsed?.text && typeof parsed.text === 'string') return parsed.text;
        return `[${msgType} message]`;
      } catch {
        return rawContent;
      }
  }
}

// ── 提及检测 ──

/**
 * 检查消息中是否 @提到了 bot
 * @param event 原始消息事件
 * @param botOpenId bot 的 open_id（可选，如果提供则精确匹配）
 */
export function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions;
  if (!mentions || mentions.length === 0) return false;

  if (botOpenId) {
    return mentions.some((m) => m.id.open_id === botOpenId);
  }
  // 如果没有 botOpenId，只要有提及就算（保守策略）
  return mentions.length > 0;
}

/**
 * 检查是否有任何提及
 */
export function hasAnyMention(event: FeishuMessageEvent): boolean {
  return (event.message.mentions?.length ?? 0) > 0;
}

// ── 消息去重 ──

export class FeishuDedupeStore {
  private recentMessages = new Map<string, number>();
  private lastCleanup = Date.now();

  constructor(
    private readonly dedupeWindowMs: number = 600_000,     // 10 分钟（覆盖飞书重传间隔）
    private readonly cleanupIntervalMs: number = 300_000,   // 5 分钟清理一次
  ) {}

  /**
   * 检查消息是否重复。返回 true 表示新消息，false 表示已处理过。
   */
  check(messageId: string): boolean {
    const now = Date.now();
    if (now - this.lastCleanup > this.cleanupIntervalMs) {
      for (const [id, timestamp] of this.recentMessages) {
        if (now - timestamp > this.dedupeWindowMs) {
          this.recentMessages.delete(id);
        }
      }
      this.lastCleanup = now;
    }
    if (this.recentMessages.has(messageId)) {
      return false;
    }
    this.recentMessages.set(messageId, now);
    return true;
  }

  /**
   * 清理所有去重记录
   */
  clear(): void {
    this.recentMessages.clear();
    this.lastCleanup = Date.now();
  }
}

const defaultDedupeStore = new FeishuDedupeStore();

/**
 * 检查消息是否重复（基于 message_id）
 * 返回 true 表示是新消息，false 表示已处理过
 */
export function checkMessageDedupe(messageId: string): boolean {
  return defaultDedupeStore.check(messageId);
}

// ── 事件解析入口 ──

/**
 * 解析飞书消息事件为标准化上下文
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const chatType = event.message.chat_type;
  const isGroup = chatType === 'group' || chatType === 'topic_group';
  const rawContent = event.message.content;
  const msgType = event.message.message_type;
  const content = parseMessageContent(rawContent, msgType);

  const senderOpenId = event.sender.sender_id.open_id?.trim() ?? '';
  const senderUserId = event.sender.sender_id.user_id?.trim();

  return {
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType,
    isGroup,
    senderOpenId: senderOpenId || senderUserId || '',
    senderUserId: senderUserId || undefined,
    content,
    contentType: msgType,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    mentionedBot: checkBotMentioned(event, botOpenId),
    createTimeMs: event.message.create_time
      ? Number(event.message.create_time)
      : undefined,
  };
}

// ── 访问控制 ──

/**
 * 检查 DM 访问权限
 */
export function checkDmAccess(
  senderOpenId: string,
  dmPolicy: 'open' | 'allowlist' | 'disabled',
  allowFrom: string[],
): boolean {
  if (dmPolicy === 'disabled') return false;
  if (dmPolicy === 'open') return true;
  // allowlist 模式
  if (allowFrom.length === 0) return true; // 未配置白名单时默认允许
  if (allowFrom.includes('*')) return true;
  return allowFrom.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    return (
      normalized === senderOpenId.toLowerCase() ||
      normalized === `user:${senderOpenId.toLowerCase()}` ||
      normalized === `open_id:${senderOpenId.toLowerCase()}`
    );
  });
}

/**
 * 检查群组访问权限
 */
export function checkGroupAccess(
  chatId: string,
  groupPolicy: 'open' | 'allowlist' | 'disabled',
  groupAllowFrom: string[],
): boolean {
  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;
  // allowlist 模式
  if (groupAllowFrom.length === 0) return true;
  return groupAllowFrom.some((entry) => {
    const normalized = entry.toLowerCase().trim();
    return (
      normalized === chatId.toLowerCase() ||
      normalized === `chat:${chatId.toLowerCase()}`
    );
  });
}