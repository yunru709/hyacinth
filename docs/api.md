# HTTP API 参考

`hyacinth serve` 启动 REST API 服务器（Fastify），默认绑定 `127.0.0.1:3000`。WebUI 模式（`hyacinth webui`）复用同一服务器并附带静态资源。

## 启动

```bash
hyacinth serve --port 3000 --api-key <key> --webui --webui-port 3100
```

| 选项 | 默认 | 说明 |
|------|---------|-------------|
| `--port` | `3000` | API 端口（占用即退出，单实例守卫） |
| `--api-key` | 无 | Bearer 认证密钥；也可用环境变量 `HYACINTH_API_KEY` / `AGENT_API_KEY` |
| `--cors-origin` | 无 | CORS 来源 |
| `--provider` | auto | Provider 类型（anthropic/openai/deepseek/local/... 共 16 种） |
| `--model` | auto | 模型名 |
| `--max-turns` | `100` | 单次 chat 请求最大轮数 |
| `--max-context` | `200000` | 最大上下文 token |
| `--webui` | 关 | 同时挂载 WebUI 静态资源 |
| `--webui-port` | `3100` | WebUI 端口 |

## 认证

除豁免路由外，所有端点要求 `Authorization: Bearer <key>`（timingSafeEqual 常量时间比较）。**未配置 key 时非豁免路由一律 401**（fail-closed）。

豁免路由：`/api/health`、媒体/场景/语音只读 GET、WebUI 静态资源（`/`、`/app.js`、`/vendor/*` 等）。

**权限说明**：HTTP/WS 渠道没有交互式审批 UI，危险工具（bash/write 等）按 fail-closed 原则自动拒绝，见 [http-webhook.ts](../src/channels/builtin/http-webhook.ts) 的 `onPermissionRequest`。

---

## 健康检查

```
GET /api/health
```

```json
{ "status": "ok", "version": "1.0.0", "auth": true }
```

`auth` 表示是否已配置 API key。

---

## 对话

```
POST /api/chat
```

同步 request-response 模式：执行完整 agent loop（含工具调用）后返回汇总结果。

**请求体：**

```json
{
  "message": "帮我重构数据库连接池",
  "sessionId": "20260524-182358-c11f",
  "images": [ { "data": "<base64>", "media_type": "image/png" } ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|-------|------|----------|-------------|
| `message` | string | 是 | 提示词 |
| `sessionId` | string | 否 | 恢复既有会话；省略则新建 |
| `images` | array | 否 | 图片输入（base64 + media_type），走多模态管线 |

**响应：**

```json
{
  "sessionId": "20260524-192358-a1b2",
  "content": "这是重构后的连接池...",
  "turns": 3,
  "toolCalls": [
    { "name": "read", "input": "src/db/pool.ts" },
    { "name": "edit", "input": "src/db/pool.ts" }
  ]
}
```

---

## 会话

| 端点 | 说明 |
|---|---|
| `GET /api/sessions` | 列出当前项目全部会话（按创建时间倒序） |
| `POST /api/sessions` | 创建新会话并返回 ID |
| `GET /api/sessions/:id` | 会话元数据 |
| `DELETE /api/sessions/:id` | 删除会话及其全部数据 |

---

## 工具与技能

```
GET /api/tools    → [{ name, description }, ...]   // 内置 + MCP + 插件
GET /api/skills   → [{ name, description, source }, ...]
```

---

## 媒体库 / 陪伴场景（只读，供 WebUI）

| 端点 | 说明 |
|---|---|
| `GET /api/media?type=&source=&character=&limit=` | 媒体记录列表（图片/视频/音频，含文件 URL） |
| `GET /api/media/:id/file` | 媒体文件字节（ETag / 304 协商，流式返回） |
| `GET /api/companion/:character/scene` | 陪伴场景元数据（scene.json） |
| `GET /api/companion/:character/scene.png` | 陪伴场景图 |
| `GET /api/companion/voice/list?character=&limit=` | 已生成语音列表（character 必填） |
| `GET /api/companion/voice/:id/file` | 语音文件（audio/mpeg 或 audio/wav，304 协商） |

---

## WebSocket（ui-protocol）

`/tui`、`/desktop`、`/ui` 三个路径升级为统一 ui-protocol 会话（19 个业务域：session/model/config/tool/bundle/mcp/kb/companion/process/schedule/permission/arch/...）。WS upgrade 与 HTTP 共用同一 Bearer 校验（fail-closed）。协议细节见 [docs/architecture.md](architecture.md)。

---

## 错误响应

| 状态码 | 含义 |
|--------|---------|
| 200 | 成功 |
| 304 | 资源未变（ETag 协商，媒体/语音端点） |
| 400 | 请求错误（如缺 `message` 字段、voice 缺 `character` 参数） |
| 401 | 未配置或错误的 API key |
| 404 | 资源不存在（如无效 sessionId） |
| 500 | 内部错误 |

```json
{ "error": "message is required" }
```
