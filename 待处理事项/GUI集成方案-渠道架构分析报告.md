# Agent 渠道架构分析与 GUI 集成方案

> 编写时间：2026-06-16
> 作者：风信子 🪻
> 源码位置：`C:\Users\74689\Desktop\Agent\agent`

---

## 一、现状：渠道架构总览

### 1.1 三层模型

```
┌──────────────────────────────────────────────────┐
│  前端层                                           │
│  TUI（终端）/ 飞书 / HTTP Webhook                 │
│  (未来: GUI 桌面应用 / WebUI / VSCode 插件)       │
├──────────────────────────────────────────────────┤
│  渠道层 (src/channels/)                           │
│  ChannelManager → ChannelHandler 接口             │
│  统一消息格式：sessionId + channel + content       │
├──────────────────────────────────────────────────┤
│  Agent 核心                                       │
│  模型路由 / 工具链 / 知识库 / 会话管理 / Gateway   │
└──────────────────────────────────────────────────┘
```

### 1.2 核心接口

每个渠道实现 `ChannelHandler` 接口（`src/channels/interface.ts`）：

```typescript
interface ChannelHandler {
  id: string;                    // 唯一标识，如 "feishu"、"tui"
  name: string;                  // 显示名称
  start(config): Promise<void>;  // 启动渠道（建连、监听）
  stop(): Promise<void>;         // 停止渠道
  onEvent(handler): void;        // 订阅消息事件
  reply(sessionId, reply): void; // 发送回复
  handleMessage(event, replyFn, agentFactory): void; // 处理消息
  getStatus(): ChannelStatus;    // 获取状态
}
```

### 1.3 现有渠道

| 渠道 | 位置 | 启动方式 | 说明 |
|------|------|----------|------|
| **TUI** | `src/channels/builtin/tui-channel.ts` | `runTui()` | 终端交互，同步显示飞书消息 |
| **HTTP Webhook** | `src/channels/builtin/http-webhook.ts` | `startServer()` | 纯后端模式，供外部调用 |
| **飞书** | `src/channels/plugins/`（插件注册） | `registerConfigChannels()` | 从 `.agent/config.json` 读取配置 |
| **其他插件渠道** | `src/channels/plugins/` | `registerConfigChannels()` | 同上 |

### 1.4 启动流程

**TUI 模式**（`runTui()`）：
```
1. new TuiChannel()
2. ChannelManager.register(tuiChannel)
3. registerConfigChannels()  → 同时注册飞书等
4. ChannelManager.startAll() → 所有渠道一起启动
5. TUI 渠道监听终端输入
6. 飞书渠道同步显示到 TUI 界面
```

**纯后端模式**（`startServer()`）：
```
1. new HttpWebhookChannel()
2. ChannelManager.register(httpWebhook)
3. registerConfigChannels()  → 注册飞书等
4. ChannelManager.startAll()
5. 监听 HTTP 端口
```

### 1.5 Session 隔离

每个消息携带 `channel` 字段，session 按渠道隔离：
- 飞书 session 前缀：`feishu_dm_*`
- TUI session：独立命名
- 不同渠道互不感知，各自管理自己的 AgentLoop

---

## 二、GUI 集成方案

### 2.1 架构设计

```
┌─ 后端服务（纯 Node.js，`--server` 模式）────┐
│  server.ts                                    │
│    ├── HTTP Server (端口: configurable)        │
│    ├── WebSocket Server (实时双向通信)          │
│    ├── ChannelManager                         │
│    │   ├── TuiChannel (可选)                   │
│    │   ├── FeishuChannel (自动)               │
│    │   └── WebUIChannel ★ 新增               │
│    └── Agent 核心                              │
└──────────────┬────────────────────────────────┘
               │ WebSocket / HTTP
               ▼
┌─ GUI 前端 ──────────────────────────────────┐
│  三个入口，同一个 Web 应用                     │
│                                              │
│  ├── 桌面应用 (Tauri) — .exe 安装包          │
│  ├── WebUI — 浏览器直接打开                  │
│  └── VSCode 插件 — WebView 嵌入             │
└──────────────────────────────────────────────┘
```

### 2.2 新增：WebUI 渠道

新建 `src/channels/builtin/webui-channel.ts`，实现 `ChannelHandler`：

```typescript
class WebUIChannel implements ChannelHandler {
  id = 'webui';
  name = 'Web UI';

  async start(config) {
    // 启动 WebSocket 服务（或挂载到已有 HTTP Server）
    // 监听客户端连接
  }

  async handleMessage(event, replyFn, agentFactory) {
    // 创建 AgentLoop 处理消息
    // 流式回复通过 WebSocket 实时推送
  }

  async reply(sessionId, reply) {
    // 通过 WebSocket 发送给对应客户端
  }
}
```

**关键设计点：**
- **WebSocket 实时通信** — Agent 的流式输出（`onText`、`onToolUse`、`onStatus`）实时推送到前端
- **复用 AgentFactory** — 与 TUI、飞书共用同一个 `createAgent()`，无需额外代码
- **Session 管理** — 每个 WebSocket 连接对应一个 session，与渠道隔离机制一致

### 2.3 启动方式

**方案一：`--server` 模式 + GUI 客户端**

```bash
# 终端 1：启动后端（含飞书等所有渠道）
node dist/index.js --server --port 3000

# 终端 2：启动 GUI
# 浏览器访问 http://localhost:3000
# 或打开 Tauri 桌面应用
```

**方案二：整合到 TUI 模式**

TUI 模式下自动启动 WebUI 服务（类似于现在 TUI 同时启动飞书渠道），终端和 GUI 可并存。

### 2.4 前端技术选型

| 方案 | 优点 | 缺点 | 推荐场景 |
|------|------|------|----------|
| **Tauri + React/Vue** | 体积小 (~5MB)，性能好，内存低，Windows 原生支持好 | 需要 Rust 环境 | ✅ 桌面应用首选 |
| Electron | 生态成熟，社区大 | 体积大 (~150MB)，内存高 | 快速原型 |
| 纯 Web | 零安装，浏览器打开即用 | 无系统托盘/快捷键 | WebUI |
| VSCode WebView | 编辑器深度集成 | 功能受限 | 开发者专用 |

**推荐：Tauri + React**
- Windows 上表现优秀
- 前端代码可复用为 WebUI 和 VSCode 插件
- Rust 后端可做系统集成（文件访问、进程管理）

### 2.5 前端功能规划（MVP）

**Phase 1 — 基础聊天（核心）**
- [ ] 消息列表（显示历史对话）
- [ ] 输入框 + 发送
- [ ] 流式输出（打字机效果）
- [ ] 会话管理（新建/切换 session）
- [ ] 渠道状态指示（飞书在线/离线等）

**Phase 2 — 配置管理**
- [ ] 模型选择 / 切换
- [ ] 渠道启停控制
- [ ] 知识库状态
- [ ] Token 用量显示

**Phase 3 — 高级功能**
- [ ] 文件上传（拖拽）
- [ ] 图片显示（多模态）
- [ ] 系统命令面板
- [ ] 多会话 Tab

---

## 三、关键集成点

### 3.1 渠道连带启动

GUI 模式下，后端启动顺序：

```
1. startServer(port)
2.   ├── ChannelManager 初始化
3.   ├── register(WebUIChannel)    ← GUI 自己的渠道
4.   ├── registerConfigChannels()  ← 自动注册飞书等配置渠道
5.   └── startAll()
6.         ├── WebUIChannel.start()   → 开 WebSocket
7.         ├── FeishuChannel.start()  → 连接飞书
8.         └── (其他渠道)
```

**不需要用户手动操作** — 飞书渠道跟现在一样自动启动，GUI 只管连 WebSocket。

### 3.2 流式回复

Agent 的 `OutputHandler` 提供实时回调：

```typescript
interface OutputHandler {
  onText(content: string): void;        // 文本增量
  onToolUse(name: string, input: string): void;  // 工具调用
  onStatus(message: string, level?: string): void; // 状态更新
  onTurnStart(): void;                  // 新轮次
  onFlush(): void;                      // 刷新缓冲区
  onInterrupt(): void;                  // 被中断
}
```

这些通过 WebSocket 实时推送到 GUI，实现打字机效果。

### 3.3 多端同步

TUI 已经有一个模式：飞书消息同步显示到终端。GUI 同理：

- **飞书消息 → GUI 通知栏**（可开关）
- **GUI 操作 → 不影响飞书 session**（session 隔离，互不干扰）
- **状态同步**（模型切换、渠道状态变更实时更新）

---

## 四、实施建议

### 4.1 优先级

1. **先做 WebUI 渠道** — 给后端加 WebSocket，让任意浏览器能访问
2. **再做前端界面** — React 单页应用，基础聊天功能
3. **最后包装** — Tauri 桌面壳 / VSCode 插件
4. **可选** — 系统托盘、通知、快捷键

### 4.2 改造量评估

| 模块 | 改造量 | 说明 |
|------|--------|------|
| `src/channels/` | **新增 1 个文件** | `webui-channel.ts` ~200 行 |
| `src/gateway/server.ts` | **小改** | 集成 WebSocket 或挂载静态文件 |
| `src/gateway/tui.ts` | **不改** | 独立，TUI 和 GUI 可并存 |
| `src/gateway/cli.ts` | **小改** | 加 `--webui` 参数 |
| Agent 核心 | **不改** | 通过 AgentFactory 复用 |
| 前端代码 | **新建项目** | 独立仓库或 monorepo |

### 4.3 风险

- **WebSocket 鉴权** — 如果 GUI 暴露到公网，需要鉴权机制（当前 HTTP Webhook 已有 apiKey 参数，可复用）
- **桌面壳子打包** — Tauri 需要 Rust 编译环境，初次搭建需要配置
- **VSCode 插件** — 需要了解 VSCode Extension API，学习成本中等

---

## 五、总结

**当前系统已经准备好迎接 GUI。** 渠道抽象层设计良好，GUI 只需要：

1. 写一个 `WebUIChannel`（~200 行代码）
2. 前端写一个 React 聊天界面
3. 选一个壳子打包（推荐 Tauri）

飞书等其他渠道自动连带启动，不需要额外配置。整套架构不改核心，只在渠道层加一个入口。

---

*本报告基于源码分析编写。如需更深度的代码级方案，可以进一步展开。*
