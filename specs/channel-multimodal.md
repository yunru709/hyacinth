# 渠道多模态支持方案

## 改动范围

### 1. 接口层 — `src/channels/interface.ts`

`ChannelMessageEvent` 加 `images` 字段：

```typescript
export interface ChannelMessageEvent {
  type: 'message';
  sessionId: string;
  userId: string;
  content: string;
  channel: string;
  /** 预取好的图片数据（base64），各渠道自行下载后填入 */
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}
```

`ChannelReply` 加 `images`：

```typescript
export interface ChannelReply {
  sessionId: string;
  content: string;
  images?: Array<{ data: string; media_type: string }>;
  metadata?: Record<string, unknown>;
}
```

### 2. 管线层 — `src/multimodal/index.ts`

新增 `buildUserContentWithInlineImages`：

```typescript
export async function buildUserContentWithInlineImages(
  userInput: string,
  images: Array<{ data: string; media_type: string }>,
  imageStore: ImageStore,
): Promise<MessageContent | MessageContent[]> {
  // 与 buildUserContentWithImages 逻辑相同，但 images 是预取好的 base64
  // 直接构造 ImageContent 块，跳过路径检测和文件读取
}
```

### 3. Agent 循环 — `src/orchestrator/loop.ts`

`_runInternal` 中，收到渠道消息时优先用 inline images：

```typescript
// 当前：
const userContent = hasVision
  ? await buildUserContentWithImages(userInput, this.imageStore)
  : { type: 'text' as const, text: userInput };

// 改为：
const userContent = hasVision && channelImages?.length
  ? await buildUserContentWithInlineImages(userInput, channelImages, this.imageStore)
  : hasVision
    ? await buildUserContentWithImages(userInput, this.imageStore)
    : { type: 'text' as const, text: userInput };
```

### 4. 飞书渠道 — `src/channels/plugins/feishu/`

**feishu-event.ts** — 解析 `message_type: 'image'`：

```typescript
// 新加 case:
case 'image':
  const imgContent = JSON.parse(content);
  return {
    text: '[图片消息]',
    images: [{ image_key: imgContent.image_key }],  // 延迟下载
    contentType: 'image',
  };
```

**feishu-channel.ts** — 下载图片并填入 event：

```typescript
// 在 handleRawMessage 中，检测 contentType === 'image'
// 调用 Feishu API im/v1/messages/{message_id}/resources/{image_key}
// 获取二进制 → base64 → 填入 ChannelMessageEvent.images
```

**feishu-send.ts** — 新增 `sendImage`：

```typescript
// POST /im/v1/images 上传图片 → 获取 image_key
// POST /im/v1/messages 发送 image 消息
```

### 5. HTTP 渠道 — `src/channels/builtin/http-webhook.ts`

`/api/chat` body 扩展：

```typescript
const body = req.body as {
  message?: string;
  sessionId?: string;
  images?: Array<{ data: string; media_type: string }>;  // 新增
};
```

### 6. 渠道管理层 — `src/channels/manager.ts`

`handleMessage` 将 `images` 透传给 `AgentLoop.run()`（通过扩展 `run()` 签名或 event 中转）。

---

## 执行顺序

1. 接口层加字段（无破坏性变更）
2. `buildUserContentWithInlineImages`（纯新增函数）
3. `_runInternal` 接入
4. 飞书解析 + 下载 + 发送（需 Feishu API 测试）
5. HTTP API body 扩展

## 不改的部分

- TUI 渠道：继续用文件路径检测，不影响
- ImageStore/recycleProcessedImages：通用，无变化
- 图片压缩/Provider 转换：通用，无变化
