# WebUI 渠道层架构设计

> 从 Channel 抽象层出发，设计 DeepThink 的 Web 前端。
> WebUI 不是独立的应用——它只是框架的又一个 **Channel**，与 TUI、HTTP Webhook、飞书平级。

---

## 1. 架构总览

```
┌────────────────────────────────────────────────────────────┐
│                      Gateway (gateway/)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │   TUI    │  │  HTTP    │  │  Feishu  │  │  WebUI    │  │
│  │ Channel  │  │ Webhook  │  │ Channel  │  │ Channel   │  │
│  │ (blessed)│  │ (fastify)│  │ (lark)   │  │ (fastify  │  │
│  │          │  │          │  │          │  │ + WS)     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       │             │             │              │         │
│       └─────────────┴─────────────┴──────────────┘         │
│                         │                                   │
│                  ChannelManager                             │
│                         │                                   │
│                   AgentFactory                              │
│                         │                                   │
│                    AgentLoop                                │
└────────────────────────────────────────────────────────────┘
```

**核心原则：**

1. **WebUI 是一个 Channel，不是独立应用。** 实现 `ChannelHandler` 接口，通过 `ChannelManager` 管理生命周期。
2. **WebSocket 是主力传输层。** LLM 输出是流式的——不能用 HTTP request-response（那是 HTTP Webhook 的局限），必须用 WebSocket 做双向流。
3. **前端无状态，服务端有状态。** Session、AgentLoop、Turn 全部由服务端管理，前端只负责渲染和输入。
4. **OutputHandler → WebSocket 消息是一一映射。** 每个 `OutputHandler` 回调对应一个 WebSocket 消息类型。

---

## 2. WebUIChannel — 渠道实现

### 2.1 接口实现

```typescript
// src/channels/builtin/webui-channel.ts

export class WebuiChannel implements ChannelHandler {
  readonly id = 'webui';
  readonly name = 'Web UI';
  readonly description = '内建 Web 前端，通过浏览器访问，支持 WebSocket 实时流式输出';
  readonly pluginId = undefined;

  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private status: ChannelStatus = 'registered';
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;

  // 每个 WebSocket 连接对应一个 AgentLoop 会话
  private connections = new Map<string, WebSocketSession>();

  async start(config: ChannelConfig): Promise<void> { ... }
  async stop(): Promise<void> { ... }
  onEvent(handler: (event: ChannelEvent) => Promise<void>): void { ... }
  reply(sessionId: string, reply: ChannelReply): Promise<void> { ... }
  handleMessage(event: ChannelMessageEvent, replyFn: ReplyFn, agentFactory: AgentFactory): Promise<void> { ... }
  getStatus(): ChannelStatus { ... }
}
```

### 2.2 生命周期

```
start()
  ├── 创建 Fastify 实例
  ├── 注册 REST API 路由（/api/*）
  ├── 挂载 WebSocket（/ws）
  ├── 配置静态文件服务（前端构建产物）
  └── 监听端口（默认 3100）

stop()
  ├── 关闭所有 WebSocket 连接
  ├── 关闭 Fastify
  └── 清理 connections Map
```

### 2.3 WebSocket 会话模型

```typescript
interface WebSocketSession {
  ws: WebSocket;
  loop: ChannelSessionRunner;    // AgentLoop 实例
  outputHandler: WebUIOutputHandler;  // 桥接 OutputHandler → WS 消息
  sessionId: string;
  createdAt: number;
}
```

每个浏览器标签页 = 一个 WebSocket 连接 = 一个 AgentLoop 实例。这与 TUI 的模型一致（一个终端窗口 = 一个 AgentLoop）。

### 2.4 静态文件服务

前端构建产物目录：`.agent/webui/dist/`（开发时可由 Vite dev server 独立运行）

```
生产模式：Fastify 直接 serve dist/
开发模式：Fastify 代理到 Vite dev server (localhost:5173)
```

通过 config 控制：
```json
{
  "channels": {
    "webui": {
      "enabled": true,
      "port": 3100,
      "host": "0.0.0.0",
      "devMode": false,
      "devServerUrl": "http://localhost:5173"
    }
  }
}
```

---

## 3. WebSocket 协议

### 3.1 消息类型定义

```
Client → Server:
┌──────────────┬──────────────────────────────────────────┐
│ type         │ payload                                  │
├──────────────┼──────────────────────────────────────────┤
│ chat         │ { content: string, images?: [...] }      │
│ stop         │ {}                                       │
│ permission   │ { result: "yes" | "no" | "always" }      │
│ set_mode     │ { mode: "normal" | "precise" }           │
└──────────────┴──────────────────────────────────────────┘

Server → Client:
┌──────────────┬──────────────────────────────────────────┐
│ type         │ payload                                  │
├──────────────┼──────────────────────────────────────────┤
│ text         │ { content: string }                      │
│ thinking     │ { content: string }                      │
│ tool_use     │ { id, name, inputSummary: string }       │
│ tool_result  │ { id, content, isError: bool }           │
│ diff         │ { id, filePath, diffLines }              │
│ status       │ { message, level: "info"|"warn"|"error" }│
│ turn_start   │ {}                                       │
│ flush        │ {}                                       │
│ interrupt    │ {}                                       │
│ turn_info    │ { turnCount, maxTurns, tokensUsed, ... } │
│ permission   │ { toolName, input }                      │
│ error        │ { message: string }                      │
│ connected    │ { sessionId, config: SessionConfig }     │
└──────────────┴──────────────────────────────────────────┘
```

### 3.2 OutputHandler → WS 消息映射

```typescript
class WebUIOutputHandler implements OutputHandler {
  constructor(private ws: WebSocket) {}

  onText(content: string) {
    this.send({ type: 'text', content });
  }

  onThinking(content: string) {
    this.send({ type: 'thinking', content });
  }

  onToolUse(name: string, inputSummary: string, toolId?: string) {
    this.send({ type: 'tool_use', id: toolId, name, inputSummary });
  }

  onToolResult(content: string, isError: boolean, toolId?: string) {
    this.send({ type: 'tool_result', id: toolId, content, isError });
  }

  onDiff(toolId: string, filePath: string, diffLines: Array<{ kind: string; text: string }>) {
    this.send({ type: 'diff', id: toolId, filePath, diffLines });
  }

  onStatus(message: string, level: 'info' | 'warn' | 'error') {
    this.send({ type: 'status', message, level });
  }

  onTurnStart() {
    this.send({ type: 'turn_start' });
  }

  onFlush() {
    this.send({ type: 'flush' });
  }

  onInterrupt() {
    this.send({ type: 'interrupt' });
  }

  async onPermissionRequest(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always'> {
    // 发送权限请求 → 等待用户响应
    this.send({ type: 'permission', toolName, input });
    return new Promise(resolve => {
      this.permissionResolve = resolve;
    });
  }

  // 额外的 WebUI 专属方法
  sendTurnInfo(info: TurnInfo) {
    this.send({ type: 'turn_info', ...info });
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
```

### 3.3 时序示例

```
Client                    Server (WebUIChannel)              AgentLoop
  │                              │                              │
  │── chat {content:"写一个"}────▶│                              │
  │                              │── run("写一个")──────────────▶│
  │                              │                              │── compose context
  │                              │◀── onTurnStart() ────────────│
  │◀── turn_start ──────────────│                              │
  │                              │                              │── call LLM (streaming)
  │◀── thinking "让我想想..." ───│◀── onThinking() ─────────────│
  │◀── text "好的，我来写..." ───│◀── onText() ──────────────────│
  │◀── tool_use {write,...} ────│◀── onToolUse() ──────────────│
  │                              │                              │── execute tool
  │                              │                              │── recordPreState
  │◀── tool_result {ok} ────────│◀── onToolResult() ───────────│
  │◀── diff {file,lines} ───────│◀── onDiff() ─────────────────│
  │◀── text "完成了！" ─────────│◀── onText() ──────────────────│
  │◀── flush ──────────────────│◀── onFlush() ────────────────│
  │◀── turn_info {...} ────────│                              │
  │                              │                              │── endTurn → save record
```

### 3.4 权限请求流

```
Client                              Server
  │                                    │
  │◀── permission {toolName, input} ──│  (AgentLoop 阻塞等待)
  │                                    │
  │  [用户点击 Yes / Always / No]      │
  │                                    │
  │── permission {result:"yes"} ──────▶│
  │                                    │── resolve("yes") → AgentLoop 继续
```

与 TUI 的 `permissionQueue` 机制等价——但 WebUI 用 popup modal 代替终端内联选择。

---

## 4. REST API 表面

这些端点在 `start()` 中注册到 Fastify，用于前端查询数据（非流式）。

### 4.1 基础设施

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 + 版本 |
| GET | `/api/status` | Agent 运行状态（当前 session、turn、provider、context 用量等） |

### 4.2 Session 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 列出所有 session |
| POST | `/api/sessions` | 创建新 session |
| GET | `/api/sessions/:id` | 获取 session 详情 |
| DELETE | `/api/sessions/:id` | 删除 session |
| POST | `/api/sessions/:id/switch` | 切换到指定 session |

### 4.3 能力发现

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tools` | 列出所有工具（name + description + schema） |
| GET | `/api/skills` | 列出所有 Skill |
| GET | `/api/agents` | 列出所有子 Agent |
| GET | `/api/workflows` | 列出所有 Workflow |
| GET | `/api/channels` | 列出所有渠道及状态 |

### 4.4 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/config` | 读取当前配置（脱敏） |
| PATCH | `/api/config` | 部分更新配置 |

### 4.5 回滚 & 知识库

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rollback/status` | 可回滚的回合列表 |
| POST | `/api/rollback` | 执行回滚 `{ turns: N }` |
| GET | `/api/kb/query?q=...` | 知识库搜索 |
| GET | `/api/kb/stats` | 知识库统计 |

### 4.6 后台进程 & 事件

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/processes` | 后台进程列表 |
| POST | `/api/processes/:id/kill` | 终止后台进程 |
| GET | `/api/sessions/:id/events` | 获取 session 的历史事件（用于重放） |

---

## 5. 前端组件架构

### 5.1 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 框架 | **React 18** + TypeScript | 生态最大，流式 UI 更新模式成熟 |
| 构建 | **Vite** | 快速 HMR，开发体验好 |
| 样式 | **Tailwind CSS** | 零运行时，组件级样式隔离 |
| 状态 | **Zustand** | 轻量，适合 WebSocket 事件驱动 |
| 编辑器 | **CodeMirror 6** | 支持语法高亮 + slash-command 补全 |
| Diff 展示 | **react-diff-viewer** 或自研 | 与 TUI 的 diff-component 对齐 |

### 5.2 组件树

```
<App>
  <WebSocketProvider>          ← WebSocket 连接管理
    <Layout>
      <Sidebar>
        <SessionList />         ← 会话列表 + 切换 + 新建
        <ChannelStatusBar />    ← 各渠道状态指示灯
        <ModelInfo />           ← 当前 Provider / Model
        <WorkflowPanel />       ← 当前工作流 + 进度
      </Sidebar>

      <MainPanel>
        <Header>
          <Breadcrumb />        ← Session > Turn #N
          <TurnCounter />       ← Turns: 3/20
          <ProviderBadge />     ← deepseek / claude-opus-4-8
          <ModeIndicator />     ← 普通 / 精确 / Workflow
          <ContextBar />        ← ████░░ 45% (45K / 100K)  Cache: 78%
        </Header>

        <ChatLog>               ← 虚拟滚动（支持大量历史）
          <MessageGroup>        ← 一组连续的 user/assistant 消息
            <UserBubble />
            <AssistantSection>
              <ThinkingBlock />   ← 可折叠的 thinking 内容
              <TextBlock />       ← Markdown 渲染
              <ToolCallCard>      ← 可展开/折叠
                <ToolHeader />     ← name + input summary
                <ToolResult />     ← 输出内容
                <DiffView />       ← 代码 diff（side-by-side 或 unified）
              </ToolCallCard>
            </AssistantSection>
          </MessageGroup>
        </ChatLog>

        <PermissionModal />     ← 危险工具确认弹窗

        <InputArea>
          <ContextIndicator />  ← 当前已附着文件/图片
          <ImageUpload />
          <SlashCommandPopup /> ← / 触发命令补全
          <CodeEditor />        ← 主输入区（支持多行）
          <SendButton />
          <StopButton />        ← 仅在 processing 时显示
        </InputArea>
      </MainPanel>

      <StatusBar>
        <ConnectionDot />      ← 🟢 WebSocket 已连接
        <BgProcessCount />     ← ⚙ 2 bg
        <TokenEstimate />      ← ~256 tokens
      </StatusBar>
    </Layout>
  </WebSocketProvider>
</App>
```

### 5.3 状态管理（Zustand Store）

```typescript
interface WebUIState {
  // ── 连接 ──
  connected: boolean;
  sessionId: string | null;

  // ── 消息流 ──
  messages: MessageNode[];        // 完整消息树（含 thinking / tool / diff）
  currentText: string;            // 正在流式输出的文本
  currentThinking: string;        // 正在流式输出的 thinking

  // ── 工具状态 ──
  activeToolCalls: Map<string, ToolCallState>;  // 进行中的工具调用

  // ── 回合状态 ──
  isProcessing: boolean;
  turnCount: number;
  maxTurns: number;
  tokensUsed: number;
  maxTokens: number;
  cacheHitRate: number | null;

  // ── 权限 ──
  permissionRequest: PermissionRequest | null;

  // ── Session 列表 ──
  sessions: SessionInfo[];

  // ── 能力注册表 ──
  tools: ToolInfo[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  workflows: WorkflowInfo[];

  // ── Actions ──
  sendChat: (content: string, images?: ImageInput[]) => void;
  sendStop: () => void;
  respondPermission: (result: 'yes' | 'no' | 'always') => void;
  loadSessions: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  createSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}
```

### 5.4 WebSocket 事件 → Store 更新

```typescript
// useWebSocket.ts — 核心 hook
function useWebSocket(url: string) {
  const store = useStore();

  useEffect(() => {
    const ws = new WebSocket(url);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case 'connected':
          store.setConnected(msg.sessionId, msg.config);
          store.loadSessions();
          break;

        case 'text':
          store.appendText(msg.content);
          break;

        case 'thinking':
          store.appendThinking(msg.content);
          break;

        case 'tool_use':
          store.addToolCall(msg.id, msg.name, msg.inputSummary);
          break;

        case 'tool_result':
          store.completeToolCall(msg.id, msg.content, msg.isError);
          break;

        case 'diff':
          store.showDiff(msg.id, msg.filePath, msg.diffLines);
          break;

        case 'status':
          store.addStatusMessage(msg.message, msg.level);
          break;

        case 'turn_start':
          store.startTurn();
          break;

        case 'flush':
          store.flushCurrentMessage();
          break;

        case 'turn_info':
          store.updateTurnInfo(msg);
          break;

        case 'permission':
          store.showPermission(msg.toolName, msg.input);
          break;

        case 'error':
          store.showError(msg.message);
          break;
      }
    };

    return () => ws.close();
  }, [url]);
}
```

---

## 6. 数据流

### 6.1 完整对话流程

```
1. 用户打开浏览器 → http://localhost:3100
2. Fastify 返回 index.html → React SPA 加载
3. React 建立 WebSocket 连接 → ws://localhost:3100/ws
4. WebUIChannel 接受连接 → 创建 AgentLoop → 创建 WebUIOutputHandler
5. Server → Client: { type: "connected", sessionId, config }
6. Client 调用 GET /api/sessions, GET /api/tools, GET /api/skills 等初始化
7. ── 用户输入消息 ──
8. Client → Server: { type: "chat", content: "写一个 React 组件" }
9. Server → AgentLoop.run("写一个 React 组件")
10. AgentLoop 调用 LLM → 流式输出
11. OutputHandler 回调 → WebSocket 消息 → Client 渲染
12. 回合结束 → turn_info 更新 header/context bar
```

### 6.2 Session 切换

```
1. Client: POST /api/sessions/{id}/switch
2. Server: 保存旧 session → 创建新 AgentLoop → 切换
3. Server → Client: { type: "connected", sessionId: newId, config }
4. Client: 清空 ChatLog → GET /api/sessions/{id}/events 重放历史
```

### 6.3 多标签页

每个标签页维护独立的 WebSocket 连接和 AgentLoop。服务端通过 `connections` Map 管理：

```typescript
// 标签页 ID = sessionId（浏览器端生成或服务端分配）
// 关闭标签页 → ws.onclose → 清理 AgentLoop
```

---

## 7. 与其他渠道的关系

```
                    ┌──────────┐
                    │  Feishu  │  ← 企业微信消息
                    └────┬─────┘
                         │
┌──────────┐       ┌────┴─────┐       ┌──────────┐
│   TUI    │───────│ Channel  │───────│  WebUI   │
│ (终端)   │       │ Manager  │       │ (浏览器) │
└──────────┘       └────┬─────┘       └──────────┘
                         │
                    ┌────┴─────┐
                    │   HTTP   │  ← REST API（第三方集成）
                    │ Webhook  │
                    └──────────┘
```

**关键规则：**
- 每个渠道可以独立启用/禁用（`config.json` 中的 `channels.<id>.enabled`）
- 多个渠道可以同时运行（TUI + WebUI + 飞书）
- **每个渠道创建自己的 AgentLoop 实例**（不同的 session，互不干扰）
- 如果用户想让 WebUI 和 TUI 共享 session，需要实现 session 级别的消息同步（v2 考虑）

---

## 8. 与现有系统的集成点

### 8.1 需要修改的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/channels/builtin/webui-channel.ts` | **新建** | WebUIChannel 主体 |
| `src/channels/builtin/webui-ws-session.ts` | **新建** | WebSocket 会话管理 |
| `src/channels/builtin/webui-output-handler.ts` | **新建** | OutputHandler → WS 适配器 |
| `src/channels/index.ts` | 修改 | 导出 WebUIChannel |
| `src/gateway/server.ts` | 修改 | 注册 WebUIChannel，配置驱动启用 |
| `src/gateway/factory.ts` | 修改 | 导出更多组件供 REST API 使用（toolRegistry, skillRegistry, turnStore 等） |
| `webui/` | **新建目录** | 前端项目（React + Vite + Tailwind） |

### 8.2 依赖新增

```json
{
  "dependencies": {
    "ws": "^8.x",           // WebSocket 服务端
    "@fastify/websocket": "^x.x",  // 或直接用 ws
    "@fastify/static": "^x.x"      // 静态文件服务
  }
}
```

前端依赖独立管理（`webui/package.json`）。

### 8.3 配置扩展

```json
{
  "channels": {
    "webui": {
      "enabled": true,
      "port": 3100,
      "host": "0.0.0.0",
      "devMode": false,
      "devServerUrl": "http://localhost:5173",
      "auth": {
        "enabled": false,
        "password": ""
      }
    }
  }
}
```

### 8.4 与 TurnRecorder 集成

WebUIChannel 的 AgentLoop 同样会被 TurnRecorder 追踪——回滚机制开箱即用，无需额外开发。

### 8.5 与 Workflow 集成

`WebUIOutputHandler.sendTurnInfo()` 包含 workflow 状态（active workflow name, step progress），前端在 Header 中展示工作流进度条。

---

## 9. 前端路由

```
/                    → 主界面（需 WebSocket 连接）
/sessions            → 会话管理
/settings            → 配置面板
/workflows           → 工作流列表 + 创建
/logs                → 历史日志查看
```

前端使用 React Router（hash 模式，因为 Fastify 只 serve 一个 index.html）。

---

## 10. 安全考虑

| 层面 | 措施 |
|------|------|
| 传输 | 生产环境建议反代到 Nginx + TLS |
| 认证 | 可选密码认证（与 HTTP Webhook 的 Bearer Token 机制对齐） |
| CORS | 默认 `*`，可通过配置收紧 |
| 工具权限 | 通过 WebSocket 的 `permission` 流实现——与 TUI 完全相同的安全检查 |
| 路径隔离 | WebUI 只能访问 `cwd` 指定的项目目录 |
| 速率限制 | WebSocket 消息速率限制（防止刷屏） |

---

## 11. 实施阶段

### Phase 1：最小可用（1-2 周）

- [ ] 创建 `WebUIChannel` 骨架（start/stop/onEvent/handleMessage）
- [ ] 实现 `WebUIOutputHandler`（OutputHandler → JSON 序列化）
- [ ] 实现 WebSocket 服务端（`ws` 库，挂载到 Fastify）
- [ ] 实现基础 REST API（health, sessions CRUD, tools/skills list）
- [ ] 创建前端骨架（Vite + React + Tailwind + Zustand）
- [ ] 实现基础 ChatLog（user message + assistant text）
- [ ] 实现 InputArea（发送消息）

### Phase 2：流式体验（1 周）

- [ ] thinking 流式渲染 + 折叠
- [ ] 工具调用卡片（展开/折叠）
- [ ] Diff 展示
- [ ] Header（turn counter, context bar, provider badge）
- [ ] Permission 弹窗
- [ ] 停止按钮

### Phase 3：完整功能（1-2 周）

- [ ] Session 管理 UI（列表、切换、新建、删除）
- [ ] Slash 命令补全（复用 CommandRegistry）
- [ ] 配置面板
- [ ] 工作流面板
- [ ] 回滚操作 UI
- [ ] 知识库查询 UI
- [ ] 后台进程管理
- [ ] 移动端响应式

### Phase 4：进阶（后续）

- [ ] 多标签页 session 同步
- [ ] 会话历史搜索
- [ ] 暗色/亮色主题
- [ ] 国际化
- [ ] 快捷键系统（vim 模式？）
- [ ] 插件扩展 API

---

## 12. 与前端的通信效率

### 12.1 消息粒度

| OutputHandler 回调 | 频率 | WS 消息大小 |
|---------------------|------|-------------|
| onThinking | 极高（每 token） | ~50B |
| onText | 高（每 chunk） | ~200B |
| onToolUse | 低（每工具调用 1 次） | ~300B |
| onToolResult | 中（每工具调用 1 次） | 1KB-50KB |
| onDiff | 低 | 1-10KB |
| onStatus | 低 | ~200B |
| onTurnStart/Flush | 极低 | ~50B |

总带宽估计：一轮典型对话 ~100KB-500KB（主要来自 tool result）。

### 12.2 优化措施

- **虚拟滚动**：ChatLog 超过 1000 条消息时启用，只渲染可视区域
- **工具结果截断**：与 TUI 一致，大结果截断 + "Show more" 按钮
- **历史重放分页**：`GET /api/sessions/:id/events?offset=N&limit=50`
- **WebSocket 消息合并**：高频的 onThinking/onText 可在服务端合并（每 16ms flush 一次）

---

## 13. 关键设计决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| WebSocket vs SSE | WebSocket | 需要双向通信（chat + stop + permission） |
| Fastify vs Express | Fastify | 与 HTTP Webhook 统一技术栈 |
| React vs Vue | React | 生态更大，流式 UI 模式更成熟 |
| 每个标签页独立 AgentLoop vs 共享 | 独立 | 与 TUI 模型一致，避免状态竞争 |
| 前端构建产物位置 | `.agent/webui/dist/` | 不污染项目目录 |
| 配置文件方式 vs 命令行参数 | 配置文件 | 与现有渠道配置体系一致 |

---

## 附录 A：与 TUI 的功能对等表

| 功能 | TUI | WebUI |
|------|-----|-------|
| 流式文本输出 | ✅ blessed Text | ✅ WebSocket text |
| Thinking 显示 | ✅ 可折叠 | ✅ 可折叠 |
| 工具调用展示 | ✅ 行内卡片 | ✅ 可展开卡片 |
| Diff 展示 | ✅ unified diff | ✅ side-by-side + unified |
| 权限确认 | ✅ 终端内联选择 | ✅ Modal 弹窗 |
| Session 管理 | ✅ /session 命令 | ✅ REST API + Sidebar |
| Provider 切换 | ✅ /model provider | ✅ 下拉菜单 + API |
| 上下文用量 | ✅ ContextBar | ✅ ContextBar (同) |
| 工作流进度 | ✅ Header | ✅ Header + 面板 |
| 回滚 | ✅ /rollback 命令 | ✅ REST API + UI 按钮 |
| 命令补全 | ✅ SlashSubPanel | ✅ 下拉菜单 |
| 图片粘贴 | ✅ 终端不支持 | ✅ 剪贴板粘贴 + 拖拽 |
| 多行输入 | ✅ | ✅ |
| 历史重放 | ✅ 启动时 | ✅ Session 切换时 |

## 附录 B：消息类型 TypeScript 定义

```typescript
// 共享类型定义（可放在 src/channels/builtin/webui-types.ts）

// Client → Server
export type WebUIClientMessage =
  | { type: 'chat'; content: string; images?: Array<{ data: string; media_type: string }> }
  | { type: 'stop' }
  | { type: 'permission'; result: 'yes' | 'no' | 'always' }
  | { type: 'set_mode'; mode: 'normal' | 'precise' };

// Server → Client
export type WebUIServerMessage =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; inputSummary: string }
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  | { type: 'diff'; id: string; filePath: string; diffLines: Array<{ kind: string; text: string }> }
  | { type: 'status'; message: string; level: 'info' | 'warn' | 'error' }
  | { type: 'turn_start' }
  | { type: 'flush' }
  | { type: 'interrupt' }
  | { type: 'turn_info'; turnCount: number; maxTurns: number; tokensUsed: number; /* ... more */ }
  | { type: 'permission'; toolName: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'connected'; sessionId: string; config: SessionConfig };
```
