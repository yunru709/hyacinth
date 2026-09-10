/**
 * 图片回收（B5 拆出至 loop-image.ts）—— 按族拆出模式（同 loop-provider/cluster）。
 *
 * 把已消费的图片从会话历史替换为可回溯的文本占位符：仅保留最后一条 user
 * 消息中的图片，其余图片 base64 存入 ImageStore 并回填模型描述，避免历史中
 * 累积大体积 base64 撑爆上下文。
 */
import type { ConversationStore } from '../memory/conversation.js';
import type { ImageStore } from '../multimodal/index.js';

/** loop 注入的依赖（惰性 getter，保持"每轮取当前值"语义） */
export interface ImageRecycleDeps {
  getConversationStore: () => ConversationStore;
  getSessionDir: () => string;
  getImageStore: () => ImageStore;
}

/**
 * 回收已处理的图片（与旧 loop.recycleProcessedImages 逐位等价）。
 * 失败不影响主流程（catch 静默）。
 */
export async function recycleProcessedImages(deps: ImageRecycleDeps): Promise<void> {
  try {
    const conversationStore = deps.getConversationStore();
    const sessionDir = deps.getSessionDir();
    const imageStore = deps.getImageStore();
    const history = await conversationStore.readAll(sessionDir);
    if (history.length === 0) return;

    // 找到最后一条真正的 user 消息（跳过 tool_result，它们 role 也是 user）
    let lastUserIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      if (m.role === 'user') {
        const items = Array.isArray(m.content) ? m.content : [m.content];
        // 跳过纯 tool_result 消息
        if (items.every(c => c.type === 'tool_result')) continue;
        lastUserIdx = i; break;
      }
    }
    if (lastUserIdx < 0) return;

    let modified = false;
    const cleaned = history.map((msg, idx) => {
      // 保留最后一条 user 消息中的图片
      if (idx === lastUserIdx) return msg;

      const items = Array.isArray(msg.content) ? msg.content : [msg.content];
      let changed = false;
      const newItems = items.map((item, itemIdx) => {
        if (item.type !== 'image') return item;
        changed = true;
        modified = true;

        // 1) 从相邻 text 块提取 img_id
        let imgId = '';
        if (itemIdx + 1 < items.length && items[itemIdx + 1]!.type === 'text') {
          const m = (items[itemIdx + 1] as any).text.match(/\[Image indexed as #(img_\d{3})/);
          if (m) imgId = m[1];
        }
        if (!imgId) {
          for (const ti of items) {
            if (ti.type !== 'text') continue;
            const m = (ti as any).text.match(/\[Image indexed as #(img_\d{3})/);
            if (m) { imgId = m[1]; break; }
          }
        }
        // 无已有索引 → 存入 ImageStore
        const src = item.source as { type: string; media_type?: string; data?: string; url?: string };
        if (!imgId && src.type === 'base64' && src.data) {
          imgId = imageStore.store(
            src.data, src.media_type || 'image/png', '',
          );
        }

        // 2) 从后续 assistant 回复中提取模型对图片的描述
        let description = '';
        for (let j = idx + 1; j < Math.min(history.length, idx + 4); j++) {
          const nextMsg = history[j];
          if (nextMsg?.role !== 'assistant') continue;
          const nextItems = Array.isArray(nextMsg.content) ? nextMsg.content : [nextMsg.content];
          for (const ni of nextItems) {
            if (ni.type === 'text' && ni.text.trim().length > 10) {
              description = ni.text.replace(/^#{1,4}\s+/gm, '').trim().slice(0, 250);
              break;
            }
          }
          if (description) break;
        }

        // 3) 回存描述到 ImageStore
        if (description && imgId) {
          imageStore.setDescription(imgId, description);
        }

        // 4) 返回占位符
        if (description) {
          return { type: 'text' as const, text: `[Image #${imgId}: ${description} — view_image("${imgId}") to re-examine]` };
        }
        // fallback: 元信息
        const mime = src.media_type || 'image/unknown';
        const ext = mime.split('/')[1] || 'unknown';
        const decodedBytes = src.data ? Math.ceil(src.data.length * 0.75) : 0;
        const sizeStr = decodedBytes < 1024 ? `${decodedBytes}B` : `${(decodedBytes / 1024).toFixed(1)}KB`;
        return { type: 'text' as const, text: `[Image #${imgId || '?'}: ${ext.toUpperCase()}, ${sizeStr} — view_image("${imgId || '?'}") to re-examine]` };
      });

      if (!changed) return msg;
      // 过滤冗余的 [Image indexed as #...] 文本块
      const filtered = newItems.filter(it => {
        if (it.type === 'text' && /^\[Image indexed as #img_\d{3}:/.test((it as any).text)) return false;
        return true;
      });
      return { ...msg, content: filtered.length === 1 ? filtered[0] : filtered };
    });

    if (modified) {
      await conversationStore.replace(sessionDir, cleaned);
    }
  } catch {
    // 回收失败不影响主流程
  }
}
