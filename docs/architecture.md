# Hyacinth（风信子）架构文档

> 本文档基于对 `src/` 全量源码的逐模块阅读整理，聚焦**结构**与**关系**，不含实现代码。
> 本文档分两部分：**第一部分**总览（§0-§12，章节级）；**第二部分**逐模块详细拆解（8 篇，逐文件级）。
>
> 版本基线：v0.9.43 · 语言：TypeScript（ESM）· 运行：Node.js 22.5+（依赖 `node:sqlite`）· 模块数：44 个目录、98K 行 TS（含测试）。2026-09-04 增补：supervisor/ 进程监督层、evolution/auto-git、协议 19 域、bypass/orchestrator 与 shims//diagnostics/ 改名（见各章节）。

---

## 0. 一句话架构

Hyacinth 是一个**运行在本地的多 Provider AI Agent 框架**：用户经多种渠道（终端 TUI / CLI / HTTP+WebSocket / 飞书 / 微信）输入，由 **AgentLoop 主循环** 每一轮走完「输入 → 旁路注入 → 上下文组装 → LLM 调用 → 工具执行 → 回合收尾」六个阶段，期间调用 LLM 供应商（12+ 在线 + 本地模型）、按需执行工具，最后把结果流式送回 UI。

三条贯穿全项目的设计主线（来自项目自我约束）：

1. **单一职责 + 单向依赖**：接口层 / 核心执行层 / Provider 层 / 工具层 / 基础设施层，依赖方向严格单向、零环形依赖（DAG）。
2. **零侵入可插拔**：模块通过"注册表 / 插件 / 贡献批 / 内核槽位"接入，而非硬编码分支；任何实现约定接口的对象都可替换实现。
3. **外部配置化**：行为开关、阈值、路径、装配顺序全部可在运行时配置中心 / 配置文件 / Manifest 中声明，改即生效（14 个热重载 watcher）。

---

## 1. 分层视图

```
┌──────────────────────────────────────────────────────────────────────┐
│  ① 入口 & 组装层   gateway/（factory·assembly-graph·boot ·cli·tui·server）│
├──────────────────────────────────────────────────────────────────────┤
│  ② 核心执行层     orchestrator/（AgentLoop·planner·6 stages）          │
│                   kernel/（pipeline·plugin-host·hook-bus 原语）        │
├──────────────────────────────────────────────────────────────────────┤
│  ③ 元认知层       bypass/（旁路智能体）·agents/（子Agent）·             │
│                   world-engine/（世界）·companion/（表达）              │
├──────────────────────────────────────────────────────────────────────┤
│  ④ 功能服务层     context/ memory/ knowledge/ tools/ mcp/ skills/     │
│                   machine/(Flow) schedule/ hot-reload/                │
├──────────────────────────────────────────────────────────────────────┤
│  ⑤ 渠道 & UI      channels/ ui/ ui-protocol/ webui/                   │
├──────────────────────────────────────────────────────────────────────┤
│  ⑥ 接入层         provider/(LLM) generation/(媒体) local-model/ lifecycle/│
├──────────────────────────────────────────────────────────────────────┤
│  ⑦ 基础设施层     registry/ rollback/ repair/ evolution/ dependency/  │
│                   multimodal/ media/ setup/ cli(doctor) env/ runtime/ │
├──────────────────────────────────────────────────────────────────────┤
│  ⑧ 零依赖底层     logging/ prompts/ utils/ types.ts/ events.ts/        │
└──────────────────────────────────────────────────────────────────────┘
```

依赖方向：从**上到下**单向；越靠下依赖越少。⑧ 全部为零内部依赖（除 `prompts` 用 Node 内置 API、`utils` 仅依赖 `types`）。

---

## 2. 核心执行链（gateway → orchestrator → kernel）

### 2.1 入口与组装（`gateway/`，约 36 文件）

入口层把"60+ 步顺序装配"改造成**声明式、可 diff、可拓扑校验**的装配体系，分三族：

- **装配声明与执行**：`agent-assembly.ts`（组装主体，产出 `AgentComponents`）、`assembly-graph.ts`（约 30 条 `AssemblyEntry` 的"施工图"，含 needs/provides/anchor/phase + 守卫测试）、`assembly-runner.ts`（用 **Kahn 拓扑排序**执行贡献，缺依赖/成环即 fail-fast）。
- **贡献批 `*-contributions.ts`**（每批 = 一次 runner.run）：`base`（git/turn/flow）→ `core`（store×4/skill）→ `infra`（memory/scheduler/mcp）→ `channel`（ModelRouter）→ `context-chain`（压缩链）→ `orchestrator`（loop 依赖族）→ `plugin-manager` → `plugin`（knowledge/xref/generation）→ `runtime`。装配分 6 相（P-A 配置基础 → P-B 核心服务 → P-C 构造 AgentLoop → P-D 插件回填 → P-E 收敛 → P-F 热重载）。
- **接线族**：`boot.ts`（ConfigManager 加载 + 会话恢复三选）、六类 `*-wiring`（config/runtime/bypass/bootstrap/工具注册/context-source）、**11 个 ContextSource** 注册点。
- **运行入口**：`cli.ts`（commander 命令分发）、`tui.ts`（全屏终端 + 斜杠命令族）、`server.ts`（Fastify HTTP + WebSocket 服务）。

核心机制：装配用 `loopRefBox`（懒求值容器）、`kbStateRef`、`pendingAsyncResults` 等共享可变引用原位回填，避免"先有蛋还是先有鸡"。

### 2.2 主循环（`orchestrator/`，约 22 文件）

`AgentLoop`（`loop.ts`）是执行链枢纽，由内核管道（Pipeline）驱动，每轮 `runTurn()` 依次跑 **6 个槽位**：

```
input → bypass → context → llm → tools → finalize
```

- **状态传递**：阶段间用 `TurnState` 显式搬运（按阶段分区：input/bypass/context/llm/tools/finalize）；会话级状态用 `SessionState`。
- **服务获取**：阶段通过 `ctx.get/require` 从 `StageServiceMap`（类型化服务表）取服务，新增服务只需加键 + 装配侧提供，构造器不感知。
- **横切**：全部横切逻辑挂在 **10 个 `LoopHooks` 钩子**上（onTurnStart / before·afterContextAssemble / onStreamEvent / before·afterToolExecute / before·afterIterationEnd / onTurnEnd / onTurnError），插件与内置共享同一套接缝。
- **输出解耦**：仅通过 `OutputHandler` 接口（onText/onThinking/onToolUse/onToolResult/onStatus/onPermissionRequest/onAskUser/onEvent…）与上层交互，任何实现它都是合法输出端。
- **编排器**：`planner.ts`/`plan-store.ts`（LLMOrchestrator 骨架 + 计划进度追踪）；次要逻辑拆到 `loop-tools/loop-provider/loop-cluster/loop-image/tool-service/cluster-service` 等辅助模块。

6 个阶段模块（`stages/`）均实现统一 `StageModule` 契约（`id/name/reads/writes/run`），`reads/writes` 声明读写字段，装配期 `checkContract` 校验 `requires ⊆ 声明`——契约真相源在代码而不是配置。

### 2.3 内核原语（`kernel/`，5 文件）

**刻意零业务依赖**（只依赖 logging），提供最小 Agent 模式所需的 3 件套：

- **`pipeline`**：配置驱动、槽位可替换的执行链。`kernel.pipeline` 配置段声明 6 槽位的 impl 与 requires；运行时 `registerStageModule` 可注册/替换/回滚整个阶段（插件改配置即可换整模块）。
- **`plugin-host`**：可插拔挂载面，三角色模型（Service Definition / Provider / Consumer），支持 mount/unmount/reload、activate 失败回滚、热替换恢复注册前值。
- **`hook-bus`**（Seam Bus）：接缝总线，观察者 `on()`（core 前跑）+ 拦截器 `intercept()`（洋葱中间件）+ core，异常隔离、串行 await、快路径零开销。
- **`types.ts`**：`Disposable/Disposer/DisposableStore`（VSCode dispose pattern，卸载逆序释放）。

### 2.4 流路由与配置中心

- **`parser/`（2 文件）**：`OutputRouter` 把 Provider 原始 `StreamEvent`（TEXT/THINKING/TOOL_USE/USAGE/STOP 判别联合）分流为执行链回调，`never` 穷尽检查保证所有类型已处理。
- **`runtime/`（3 文件）**：`RuntimeConfigCenter` 单例 = 运行时配置中心 + 变更通知。`get/set/merge/reset` + `watch(pattern, cb)`（支持 `*` 通配），`set` 时触发该路径 + 全部**祖先通配路径**事件。消费方遍布执行链（loop 订阅 safety/context、包订阅 models/local 等），支撑"外部配置化"原则。

---

## 3. 上下文与记忆（context / memory / knowledge）

### 3.1 上下文组装（`context/`，17 文件）—— 5-Zone 分层

建立在 **Manifest（菜单）与 Composer（厨师）分离** 之上：

- **Manifest**（`manifest-types|defaults|loader`）：声明"有哪些 section、放哪个 zone、什么类型"，项目可用 `.agent/context-manifest.json` 覆盖。
- **LayeredContextComposer**（`composer.ts`）：按 zone 遍历 section → Resolver 取内容 → 按 role 合并成消息数组 → 打 cache_control 断点。
- **5-Zone 布局**（按变化频率分离缓存）：

| Zone | 名称 | role | 内容 | 缓存 |
|---|---|---|---|---|
| Z1 | Anchor | system | persona/工具规则/工具包/Skill/Agent/MCP/记忆 | 最稳定，前缀缓存 |
| Z2 | Manifest | — | 辅助索引 | 独立断点（默认关） |
| Z3 | History | user | 项目上下文/摘要/对话历史 | 持续增长，压缩器管边界 |
| Z4 | Context | user | 知识库检索 | 可独立开关省 token |
| Z5 | Live | user | Flow/渠道/工具/时间戳/用户输入 | 每轮变，不缓存 |

7 种上下文变更机制各司其职：`manifest`（结构）、`router`（模式）、`injection`（动态注入）、`compressor`（预算保护）、`ContextSource`（数据供应）、`activeConditions`（条件开关）、`filterHistory`（消息过滤）。

配套：`tokenizer`（js-tiktoken GDP-4 计数）、`retriever`（全量历史池检索）、`cache-strategy`（Anthropic manual-markers / Gemini auto-prefix 等）、`prompt-builder`（system section 合并 + 项目文件加载）、`companion-filter`、`truncating-composer`（第二个实现，激进截断）。

**压缩**（`compressor.ts`）：四阶段差分——Phase1 规则裁剪（工具输出浓缩/去重/截断）→ Phase2/3 LLM 结构化摘要（按 compressDepth）→ 保护区兜底 → 全局配对修复；支持 `clusterKey` 分簇压缩 + `_compressed` 标记。

### 3.2 记忆（`memory/`，9 文件）

- `SessionManager`：会话建目录（conversation/events/stats/meta），normal/precise/companion 三型，`~/.agent/sessions/`。
- `ConversationStore`：对话 JSONL 写入 + `conversation_full.jsonl` 全量存档（永不压缩，供意图簇标记 `_cluster_id`）。
- `EventStore`/`StatsManager`/`SummaryStore`：事件、统计、摘要（分簇分桶）。
- `MemoryStore`（跨会话项目记忆，/memory 命令）、`CompanionSessionManager`（按角色隔离目录）。

### 3.3 知识库（`knowledge/`，10 文件）

`KnowledgeBase` → `Retriever`（Fts5Retriever）：`node:sqlite` FTS5 + 外链表触发器同步；**CJK bigram 分词** `indexContent`/`bigramQuery`；中文查询走 `preprocessQuery` 变体链多次降级；Tag IDF 语义匹配（`StructuredStore`）为 Zone4 注入文本。工具面 `kb_add/list/delete/update/toggle`，与 context 的 `activeConditions` 联动 zone4 开关。

---

## 4. 模型接入层（provider / local-model / lifecycle / generation）

### 4.1 统一 LLM Provider（`provider/`，29 文件）

- **统一接口**：`Provider.createStream(messages, tools, signal): AsyncIterable<StreamEvent>`；`ProviderCapabilities`（toolCalling/streaming/maxContextTokens/isLocal/vision）自描述。
- **两套"单一真源"**：`MODEL_CATALOG`（按厂商分组的模型目录：contextWindow/maxOutputTokens/capabilities/cost/replacedBy）与 `PROVIDER_META`（14 在线厂商元数据），三者同源由守卫测试锁死。
- **工厂注册表** `factory-registry`：`PROVIDER_FACTORIES` **键序即优先级**，`ProviderType` 由此派生；`registerProviderFactory` 支持运行时扩展/卸载回滚。
- **三层厂商接入**：① 内置（改 `PROVIDER_TYPES`/`PROVIDER_FACTORIES`/`PROVIDER_META`/`MODEL_CATALOG` 四处，进 DEFAULT_PROVIDERS 与模型目录）；② 运行时扩展（`registerProviderFactory`，代码注册、dispose 回滚）；③ **JSON 声明（零代码）**——在 `~/.agent/providers.json` 加一条 `{ id, name, baseUrl, defaultModel, envKey, protocol?, sampling?, fieldMap? }` 即接入：`getProviderFactory` 命中兜底、`detectFromEnv`/`getAvailableProviders`/setup 向导/`getApiKeyEnvName` 自动纳入，改文件即热生效（provider-watcher）。
- **字段翻译层**（`fields.ts`）：厂商私有字段通用化——`ProviderFields` 定义通用语义（userId/温度/topP/penalties/maxOutputTokens），`PROTOCOL_FIELD_MAP` 按协议（openai→user_id / openaiUser→user / anthropic→metadata.user_id / responses→user）翻译成 wire 字段，`translateFields` 注入请求 body。**映射数据化**：内置厂商的 wire 映射也是数据（`PROVIDER_META[type].fieldMap`，如 openrouter 默认 `userId→user`），可被 providers.json 覆盖——厂商换代/端点差异改一行配置即生效（provider-watcher 热加载），零代码。新增通用字段只加「ProviderFields 一行 + 映射一行」。
- **多能力厂商（capabilities 声明即用）**：`ProviderFactoryMeta.capabilities` 声明非 chat 能力（`tts/image/video/embedding/rerank`），适配中转站/聚合平台（一个 key + baseUrl 背后同时提供 LLM、TTS、图片、视频、embedding）。声明后生成侧**零配置**自动物化（见 §4.4），embedding 侧 `getEmbeddingProvider` 声明即取（`provider/embedding.ts`：统一接口 + OpenAI 兼容实现，POST `{baseUrl}/embeddings`，按 index 重排对齐）。
- **采样参数三级兜底**：激活配置（config.json provider 节点 `sampling`）→ 厂商级（meta.sampling）→ 模型级（ModelCatalogEntry.sampling）→ 不发送；`ProviderManager.createFromConfigFile` 把 sampling/fields/maxOutputTokens 从 config.json 收敛进 ProviderConfig，让 temperature 等配置真正生效。
- **适配器**：Anthropic/OpenAI/Gemini 原生，Groq/xAI/Mistral/OpenRouter/Moonshot/Zhipu/Volcengine 复用 `OpenAICompatibleProvider`，Qwen/MiniMax/MiMo 复用 `AnthropicProvider`，DeepSeek 薄封装。统一 `recoverToolArguments` 容错 + `sanitizeText` 防注入。
- **弹性层**：`ResilientProvider`（指数退避重试 + 三态熔断）+ `FallbackProviderChain`（顺序降级、剥 cache_control、onFallback/onRecover 回调）。
- **路由**：`ProviderRouter`（按复杂度自动路由：high→在线否则本地）、`ModelRouter`/`ModelChannelRegistry`（按角色 assessment/planning/compression/sub-agent → 通道 → provider → main 降级链）。
- `user-id.ts`：DeepSeek KVCache 隔离 ID 统一管理。

### 4.2 本地模型（`local-model/`，6 文件）

`LocalModelModule`（门面）→ `ModelBridge`（端口推断后端：llama.cpp/Ollama/vLLM/LM Studio/custom）→ `lifecycle/ProcessManager` 托管进程；`ModelRegistry` 扫描 `models/` 热插拔；`LlamaCppProvider`（原生 fetch+SSE，LoRA adapter 管理）；`DownloadManager`（GitHub 预编译包零依赖解压）。

### 4.3 生命周期（`lifecycle/`，4 文件）

`ProcessManager`（子进程托管：健康检查轮询、崩溃恢复、进程树清理）与 `LifecycleSupervisor`（全局优雅关闭：三阶段信号防线 SIGINT/SIGTERM→异步关闭→同步 forceKillAll）。

### 4.4 媒体生成（`generation/`，12 文件）

与对话 LLM **并列但独立**的生成供应商层（图片/视频/音频），复用轻量接口 `GenerationProvider.submitTask/getTaskStatus`。适配器：`volcengine`（Seedream/Seedance）、`minimax`（三模态）、`openai-compatible`（**双轨**：TTS `/v1/audio/speech` + 文生图 `/v1/images/generations`，`getCapabilities` 按 models 声明动态派生）。`GenerationService` 统一提交→轮询→下载转存；`scene-render` 提供陪伴模式场景渲染窄工具（SHA 去重防烧 API）。

**vendor 声明即用（auto-materialize）**：`generation/vendor.ts` 在凭证继承（baseUrl/apiKeyEnv 从 LLM providers.json 借）之外，新增两级联动——① LLM 厂商声明 `capabilities` 后，生成侧**零配置**自动物化条目：`tts→audio_tts`、`image→text_to_image`（缺省走 `openai-compatible` 适配器），`video→text_to_video`（无 OpenAI 标准端点，需显式 `spec.adapter`，缺省跳过并 warning）；embedding/rerank 走独立接口不进生成侧。同一厂商多能力走不同适配器时拆条目（第一组保留原名，其余加能力后缀）。② **声明即用默认路由**：某任务类型无显式 `defaults` 且只有一家能力供应商 → 自动写入 `defaults`；多厂商竞争同一能力不自动（避免隐式路由意外）。显式配置/显式 defaults 始终优先。

---

## 5. 工具与扩展体系（tools / registry / plugins / skills / mcp）

### 5.1 工具体系（`tools/`，64 文件，最大模块）

- **契约**：`Tool` 接口 `{ name, description, inputSchema, execute }`（+可选 companionDescription/companionOnly/executionMode/setBackgroundRegistry），任何实现它的对象都是工具。
- **执行器** `ToolExecutor`：真实中断（AbortController+定时器）、并行执行、超时。
- **内置工具**（`createDefaultRegistry` 16 个 + Git）：read/write/edit/multi_edit/insert/bash/glob/grep/git/restart/diff_files/json_edit/http_request/archive/db_query/disk_usage/generate_media。
- **安全中间层**：`path-sandbox`（子 Agent 沙箱）、`allowlist`（白名单免确认）、`injection-filter`（工具结果注入清洗防 prompt injection）、`ToolResultBuffer`（>16KB 落盘 + 指针消息）、`BackgroundProcessRegistry`（asyncable 后台进程管理）。
- **子目录**：
  - `runtime-control/`（8 文件）：30+ 运行时工具（provider 切换/toggle/subagent/session/allowlist/task/model-channel/companion），注册集中点在 `tool.registry.registerRuntimeControlTools`。
  - `xref/`：AST 级代码图谱（XrefManager + TS/regex 解析器，SQLite 索引，text/mermaid/graphviz 三格式，10 种查询 action）。
  - `python-bridge/`：把 Python 脚本（docstring 解析 meta）桥接为 Tool，内置 docx/xlsx 读取走此桥。

### 5.2 注册表（`registry/`，5 文件）

`GenericRegistry<T>`（Map + disabled Set + 事件）派生三种真实注册表：**ToolRegistry**（heatPlug 追踪、getToolDefinitions）、**SkillRegistry**（内置快照恢复）、**AgentRegistry**（多实例语义：以 instanceId 为键、spawnInstance 分身）。注：README 所称"7 注册表"中 Provider/Channel/Plugin 已废弃（由 Router/ChannelRegistry/PluginManager 覆盖）、MCPSystem 已移除独立注册表。

### 5.3 插件 / Skill / MCP

- **plugins**：`plugin.json` 清单 + `PluginApi`（register×5：tool/skill/mcp/configContextSource/channel + onHook/aroundHook），生命周期委托内核 `PluginHost`，`createApiWithAutoRollback` 卸载自动逆序回滚。示例 `plugins/example-greeter/`。
- **skills**：Markdown 模板（YAML frontmatter）+ `use_skill` 工具按需注入；内置 code-review/debug/refactor/framework-reference。
- **mcp**：`MCPSystem` 统一管理 server 生命周期，stdio/SSE 双传输，`MCPBridge` 把 MCP 工具注册为 `mcp__server__tool`，崩溃自动重连（stdio 固定 2s / SSE 指数退避），危险命令黑名单、孤儿进程清扫、自动安装 npm/python 包。

---

## 6. 渠道与 UI（channels / ui / ui-protocol / webui）

### 6.1 多渠道（`channels/`，29 文件）

- **统一抽象** `ChannelHandler`：`register→start→onEvent→handleMessage→reply→stop` 生命周期；`ChannelManager` 托管状态；`MessageDispatcher` 提供**跨渠道"纯借用"分发**（借道发送不建 session 不改状态，暴露给 Agent 的 `send_channel_message` 工具）。
- **内置渠道** `builtin/`：`TuiChannel`（渲染回调桥接）、`HttpWebhookChannel`（Fastify REST+WS+静态 WebUI，Bearer 认证）、`UiProtocolSession`（协议层唯一生产装配入口）、`UiWsSession`（WS 薄封装）、golden-scenarios 回归测试。
- **插件渠道** `plugins/`：飞书（WebSocket SDK，富文本/流式卡片/图片/长 queue/chatId 持久化）、微信 ClawBot（HTTP 长轮询、二维码授权、token 生命周期）。

### 6.2 TUI 组件（`ui/`，15 文件）

基于 `@earendil-works/pi-tui` 的可复用组件（不负责渲染主循环，渲染在 gateway/tui）：`CommandRegistry`（内置斜杠命令 + commands.json 热重载）、`ChatLog`（流式/工具状态缓存）、消息/Markdown/Diff/工具卡片组件、`OSC8` 超链接、主题与终端净化。

### 6.3 UI 协议层（`ui-protocol/`，23 文件）

**TUI/WebUI/桌面端共享的统一双向 RPC+事件协议**（传输中立/形态中立）：`UiRequest/UiResponse/UiEvent`（方法命名空间 `<domain>.<action>`）。`UiProtocolServer` 路由 + `UIAdapter`（InProc 本地 / `WsAdapter` WebSocket ping/pong）+ 19 个业务域工厂（config/session/model/message/state/permission/command/kb/process/orchestrator/context/tool/bundle/mcp/plugin/supervisor/companion/schedule/meta）。`src/events.ts` 是跨层中立事件契约（业务核心与 UI 共享、零依赖）。

### 6.4 WebUI（`webui/`）

纯静态前端（index.html/app.js/app.css/theme.css + vendor tailwind/lucide + assets），经 `/ui`/`/desktop` WS 端点连接协议层。

---

## 7. 业务机制（machine / schedule / rollback / repair / evolution / dependency）

- **machine（Flow）**：`MachineRunner`（事件驱动状态机：StateDef/TransitionDef/guard）+ `MachineRegistry`（单活跃 Flow + `flow-state.json` 崩溃恢复）。`flows/todo`（两阶段）、`flows/spec`（三阶段，guard 解析 markdown 勾选进度）。通过 `getContextInjection()` 作为模型唯一可见通道（Zone 5）。
- **schedule**：`HeartbeatScheduler` 心跳驱动，五策略 interval/cron/daily/fixed-time/random（Random 增强：时间窗口、U 形分布、概率权重拒采样）；`SchedulePersistence` 每次重读磁盘 + mtime 检测，支持多 Agent 实例共享任务文件。
- **rollback**：`TurnRecorder`（回合开始 git 锚点 + 工具拦截前置采集 + endTurn git diff 补全）落 `TurnStore`（环状 20 回合），`rollback` 工具 `git resetHard(preCommit)` 精确回滚。
- **repair**：`LoopGuard`（ToolGuard 工具风暴 + TextGuard 文本循环，Jaccard 相似度）+ `scavenge`（从 thinking 回收漏声明工具调用）。
- **evolution**：`GitManager`（最底层，唯一 Node 内置依赖），支撑回滚锚点 + 上下文检索；`auto-git.ts`（S4 自管理策略层）：回合收尾提交（`autoGit.postTurnCommit` 默认关，onTurnEnd 钩子观察者）、启动处置（`autoGit.startupAction`）、`createBackup`（hyacinth backup 快照，bundle+tag 双保险），经 `wireAutoGit` 工厂在装配层接线。
- **dependency**：AST/正则依赖图 + 增量更新（content hash）+ 影响面 BFS + 数据流追踪，为 xref/子 Agent 提供分析能力。

---

## 8. 元认知层与子 Agent（bypass / agents / world-engine / companion）

### 8.1 旁路智能体（`bypass/`）

**系统元认知层**：在主循环 preTurn/postTurn 独立运行的后台观察者，结果直接注入主 Agent 上下文。因风险最高，受**安全红线**约束——工具面只装专一化窄工具，强制禁止 bash/read/write/edit/http_request 等通用工具。`BypassAgentBase`（独立模型通道、异常隔离、状态持久化）+ `BypassManager`（注册/启停/preTurn 阻塞收集 + postTurn 并行 allSettled）。

普通模式 `ContextOrchestrator`：意图识别（preTurn）→ 记忆维护/纠偏/簇归类（postTurn），6 套提示词 + 6 个窄工具（inject_hint/memory_*/cluster_assign），是**意图的权威来源**。

### 8.2 子 Agent（`agents/`）

`delegate_to_agent` 工具创建隔离工作单元：独立上下文/工具白名单（FilteredToolRegistry + path-sandbox）/独立 Provider（KVCache 隔离）/独立会话。**delegate / adversarial / parallel** 三模式 + 异步后台（spawn_sub_agent 分身、TTL 会话复用、pendingAsyncResults 回流主 loop）。内置 code-reviewer / security-auditor / test-writer。

### 8.3 世界引擎（`world-engine/`）

陪伴模式世界模拟：`WorldStore`（读并发/写串行、原子写、写者所有权契约）、`WorldTicker`（时间/天气季节/NPC 移动/动态对象，按 timeScale 推进）、`sim.ts`（sim 对象自演化：snow/plant/timer + 声明式 customKinds）、`WORLD_TOOLS`（12 个窄工具，不进全局注册表）、`WorldEngine`（BypassAgent 实现，narrate 旁白/observe 世界增长）。

### 8.4 陪伴表达（`companion/`）

**不依赖 world-engine**，职责正交：台词语音表达链 `normalize`（台词→TTS 输入净化）→ `SayHistoryStore`（sqlite 台词历史）→ `VoiceLibrary`（音色库）→ `GeneratedVoiceStore`（生成语音缓存）→ `CompanionVoiceService`（TTS 合成，唯一键命中缓存，串行队列兜底）。

---

## 9. 辅助设施（multimodal / media / hot-reload / setup / cli / env / ...）

- **multimodal**：图片管线 `ImageStore`（检测→压缩→会话索引→view_image 工具→回收），fingerprint 去重。
- **media**：独立媒体库 `MediaStore`（与 kb 刻意隔离），scene_render/generate_media 回填，落库失败不阻断生成。
- **hot-reload**：`watcher-base` 统一骨架（fs.watch/poll + debounce + mtime 去重），管理 **14 个 watcher** 装配表（mcp/plugin/prompt/agent/config/tool/skill/command/provider/model-catalog/manifest/channel/bundle/extension-registry），`flag` 读取 configCenter 开关，动态 import 消除循环依赖。
- **setup**：`ConfigManager`（三层合并持久化）、`SetupWizard`/`GenerationWizard`、`persona-bootstrap`（SOUL/IDENTITY/USER 引导）、`model-defaults`。
- **cli（doctor）**：8 项系统诊断 + 自动修复（Node/env/persona/deps/native-sqlite/config/kb/api keys）。2026-09-04 改名 `src/diagnostics/`。
- **supervisor（进程监督层）**：`guardian.ts`（守护进程，退出码 42 重启 / 43 更新后剥参 / 44 插件热更新兜底；60s 滑动窗口 ≥5 次拉起熔断）、`protocol.ts`（进程边界契约叶：退出码常量、`.restart-session/.restart-continuation/.restart-reason` 标记读写、`prepareShellRestart` 会话快照，零内部依赖，verify:layers 规则 4 唯一白名单）、`shutdown.ts`（自 lifecycle/ 迁入的 `LifecycleSupervisor` 优雅关闭）。方案见 `docs/design/壳层方案-顶层操作收敛规划.md`。
- **基础设施小模块**：`env`（环境收集 + environment section）、`logging`（stderr JSON lines，setLogLevel 由配置中心权威）、`prompts`（外部优先的提示词加载，`{{var}}` 渲染）、`utils`（文本/diff/项目Key）、`update`（GitHub 自更新 + 本地编译）、`types/`（sharp 类型兜底）。

---

## 10. 关键数据流

1. **一轮对话**：渠道 `ChannelMessageEvent` → AgentLoop.run → pipeline 六槽（input/bypass/context/llm/tools/finalize）→ `OutputHandler` → UI 事件/落盘。
2. **上下文组装**：`LayeredContextComposer`（manifest → 5-Zone → Resolver → cache_control）→ Provider 流式 → `OutputRouter` 分流 → 工具执行（ToolExecutor + 权限链 + 结果缓冲 + 注入过滤）→ 结果写回 conversation → 压缩器按 budget 保护。
3. **旁路**：preTurn 注入（意图/提醒/世界旁白）→ 主 Loop 消费 → postTurn 观察（记忆/簇归类/世界更新）。
4. **跨渠道**：Agent → `send_channel_message` 工具 → MessageDispatcher → 目标 handler.send（纯借用）。
5. **配置热更新闭环**：外部文件 → watcher → Registry/System 重载 → 即改即生效。

---

## 11. 架构原则落地自检（对应设计哲学 §2.1）

| 原则 | 落地体现 |
|---|---|
| 单一职责 | 各模块一句话职责清晰；tools 只管执行、context 只管组装、provider 只管 LLM 抽象 |
| 零侵入集成 | Tool/Plugin/ContextSource/BypassAgent 先注册后使用；内核 slot 可运行时替换 |
| 外部配置化 | `kernel.pipeline` 装配、Manifest zone、configCenter 全量开关/阈值、14 watcher |
| 数据/配置/代码分离 | MODEL_CATALOG(数据) / *.json(配置) / .ts(代码) |
| 可插拔接口稳定 | `Tool`/`Provider`/`BypassAgent`/`ChannelHandler`/`GenerationProvider` 均为稳定小接口，实现可换 |
| 可独立测试 | 各模块独立 vitest（assembly-graph/context/truncating-composer/registry/resilient/generation adapter 等） |
| 跨项目可移植 | kernel 零业务依赖；media/multimodal/update 等近乎自包含 |

---

## 12. 模块依赖量化（据 `模块依赖分析.md` 及审计）

- **装配中心**：`gateway`（依赖多）—— 唯一样条装配点，依赖注入容器。
- **执行枢纽**：`orchestrator`（依赖多、被上/子 Agent 管理）。
- **能力枢纽**：`tools`（被 11 模块依赖）、`provider`（被 14 模块依赖，凡需 LLM 皆经它）。
- **零依赖底层**：`logging`、`prompts`、`evolution`、`utils`、`types.ts`、`events.ts`（事件落盘 `EventStore` 已并入 `memory/events.ts`）。
- **结论**：依赖呈严格 DAG，无循环；环形依赖通过懒求值容器、动态 import、接口下沉解决。

---

# 第二部分 · 逐模块详细拆解

> 8 篇结构文档按模块族组织，逐文件说明职责/关键符号/依赖方向（纯结构，不含实现代码）。

## 详细 核心执行链

> 本文为纯结构说明：只描述每个关键文件的职责、关键类/接口/函数、它们之间的关系、数据流，以及模块间的依赖方向。不展示代码片段（除极少数关键符号名/签名，仅供定位）。
>
> 覆盖范围：`src/index.ts`、`src/events.ts`、`src/types.ts`、`src/parser/`、`src/runtime/`、`src/kernel/`、`src/gateway/`、`src/orchestrator/`（含 `stages/` 子目录）。
> 结论基于对上述文件中每个指定文件的逐字阅读，非臆测。

---

## 0. 执行链全局视图（一句话）

用户输入从「入口（CLI/TUI/HTTP 渠道）」进入 `AgentLoop` 的主循环（`run` → `while` 迭代 → `runTurn`），
每次 `runTurn` 由**内核管道（Pipeline）的 6 个槽位**串联执行：
`input → bypass → context → llm → tools → finalize`，槽位上可挂「插件钩子（HookBus/Seam Bus）」做横切；
阶段之间用 `TurnState` 显式搬运状态，阶段所需服务经 `StageServiceMap` 从内核服务表中 `get/require` 获取；
流式输出经 `OutputRouter` 解析并转成 UI 事件上屏/落盘；LLM Provider 结果、quick 的调用链又回流到上下文，形成下一轮输入。

依赖方向（从外到内，符合"零侵入可插拔"哲学）：
- `gateway`（入口/装配）→ `orchestrator`（主循环）→ `kernel`（生命周期/接缝/管道原语）→ `logging`
- `parser`（流路由）被 `orchestrator/stages/llm` 消费
- `runtime`（配置中心）被 gateway、orchestrator、很多业务层消费（单例注入面）
- `events.ts` / `types.ts` 是零依赖的顶层契约层，被 `orchestrator` 与 UI 协议层共同引用（事件落盘 `EventStore` 在 `memory/events.ts`）

---

## 1. 顶层入口与事件/类型层

### 1.1 `src/index.ts`
进程级入口（shebang node）。唯一职责：导入 `gateway/cli.ts` 的 `runCli()`，`catch` 未处理异常并用 logger 落盘。它不承载任何业务装配逻辑——所有装配都在 `gateway`。

### 1.2 `src/types.ts`
纯类型中立层（零运行时值）。定义执行链的核心数据契约：
- **Message 体系**：`MessageRole`（system/user/assistant）、`TextContent / ThinkingContent / ToolUseContent / ToolResultContent / ImageContent`、`MessageContent` 联合、`Message`（含可选的 `_cluster_id`、`_compressed` 意图簇标记）。
- **Tool 体系**：`ToolDefinition`、`ToolCall`、`ToolResult`。
- **流事件**：`StreamEventType`（TEXT/THINKING/TOOL_USE/IMAGE/USAGE/STOP）与 `StreamEvent` 判别联合（parser 的输入）。
- **Session**：`Session`、`SessionStats`（含缓存命中统计 `cache_turns`）。
- **Provider**：`ProviderConfig`；`ProviderType` 从 `provider/factory-registry` re-export（注册表派生，新增厂商只改注册表）。
- 依赖图谱 STUB、MCP、Skill、Sub-Agent（`AgentDefinition/AgentResult`、`CollaborationMode`）。
这一层被 orchestrator/gateway/parser 等广泛 import，但**不反向依赖任何业务层**。

### 1.3 `src/events.ts`
后端 → UI 的推送事件契约层（与 types 平级、同样零依赖）。要点：
- `UI_EVENT` 常量命名空间（`ui.connected`、`message.*`、`state.update`、`config.change`、`model.change`、`session.change`、`permission.request`、`companion.say`、`companion.voice` 等）。
- 明确的依赖方向注释：`orchestrator/loop`、`companion/voice`、`tools/*`、`gateway/tui` 都消费它，`ui-protocol/*` 只做 re-export——保证业务核心不反向依赖 UI 适配层。
- 定义了两个事件载荷：`CompanionSayEvent`（台词）、`CompanionVoiceEvent`（TTS 语音就绪/失败）。load `sayId` 关联文字与语音。

### 1.4 `src/memory/events.ts`（事件层）
会话事件 JSONL 的文件读写工具层（原顶层 `src/event-store.ts` 已并入本文件）。
- `ConversationEvent` 类型（user_input/text/thinking/tool_call/tool_result/error/stop/usage）。
- `appendEvent()` 追加一条到 `events.jsonl`。
- `coalesceEvents()` 合并相邻流式片段（text/thinking 逐 token → 合成完整消息，供 UI 历史还原）。
- `readRecentEvents()` 读最近 N 条；`getEventCount()` 计数。
- `EventStore` 类：带 store 抽象的事件存储（StageServiceMap 的 `eventStore` 服务键）。
被 `loop`、`stages/finalize`、`stages/llm` 使用；它属于 `memory` 体系在 orchestrator 侧的工具入口。

---

## 2. gateway 层（入口装配/一张图，约 36 文件）

gateway 是被拆得非常细的"装配 + 入口"层。核心矛盾是：**把原来 60+ 步的 factory 顺序装配，改造成声明式、可 diff、可拓扑校验的装配体系**。因此它被切为三大家族：
- 装配声明与执行：`factory.ts`（薄壳）、`agent-assembly.ts`（编排主体）、`assembly-graph.ts`（声明表）、`assembly-runner.ts`（执行原语）、`base/core/infra/channel/context-chain/orchestrator/plugin/plugin-manager/runtime` 等 `*-contributions.ts` 贡献批。
- 接线：`boot.ts`、`bootstrap-wiring.ts`、`config-wiring.ts`、`runtime-wiring.ts`、`bypass-wiring.ts`、`tool-registration.ts`、`context-sources.ts`。
- 运行入口：`cli.ts`、`tui.ts`、`server.ts` 以及大量 `tui-*.ts` 斜杠命令族。

### 2.1 `factory.ts`（薄壳）
只保留对外 API 形状：re-export `CreateAgentOptions`/`AgentComponents` 类型，`createAgent(options, supervisor?)` 直接委托给 `agent-assembly.ts` 的 `createAgentAssembly`。注释明确装配原则：新组件走 `*-contributions.ts`，工具只在注册表统一注册，提示词/配置一律外部化。

### 2.2 `agent-assembly.ts`（真正的装配中心）
定义两个核心接口并完成全部装配时序：
- `CreateAgentOptions`：输入（cwd/provider/maxTurns/maxContext/outputHandler/sessionId/shouldContinue/maxMessages/personaDir/localModelProvider/channelsInfo/channel/sessionManager）。
- `AgentComponents`：产出（loop/sessionDir/sessionManager/toolRegistry/bundleRegistry/skillRegistry/agentRegistry/dependencyAnalyzer/contextComposer/mcpSystem/hotReloadManager/modelRouter/providerConfigLoader/knowledgeBase/kbState/companionSessionManager/backgroundRegistry/scheduler/channelLoops）。
- `createAgentAssembly()`：按 `boot()` 引导 → 各 `run*Contributions` 批 → 构造 `AgentLoop` → 后置插件/接线/回填 的顺序完成装配。关键中间产物：`loopRefBox`（懒求值容器，构造前为 null、构造后回填）、`pendingAsyncResults`（子 Agent 结果队列，与 delegateTool 共享）、`kbStateRef`（知识库查询共享引用）。

装配时序可按 `assembly-graph.ts` 归为 6 相：
P-A 配置与基础（boot→base→bootstrap→provider loader→config-wiring→model catalog→fallback）、
P-B 核心服务（infra→channel→context-chain→toolRegistry→orchestrator→core→pluginManager 批）、
P-C loop（`new AgentLoop({...服务表},{...配置表})`）、
P-D 插件+回填（setHooks→loadAll→plugin 贡献批→回填批→bypass-wiring→registerLoopDependentTools）、
P-E 收敛（channel registries→scheduler handler→config 订阅→runtime 批→11 个 ContextSource）、
P-F 热重载+返回。

### 2.3 `assembly-graph.ts`（装配全景声明表）
把"装配顺序"变成**可 diff 的声明数据 + 守卫测试**（配合 `assembly-graph.test.ts`）。
- `AssemblyEntry`：每条目含 id / kind（instance|plugin|shared-ref|phase）/ anchor（factory 中可唯一命中的文本）/ needs / provides / phase(P-A..P-F) / note。
- `ASSEMBLY_GRAPH`：约 30 条条目，覆盖三类依赖：
  1. **依赖注入**（贡献批 needs/provides，拓扑 + 环检测 + fail-fast）；
  2. **配置值**（`AgentLoopConfigOptions` 的字面量与策略集合）；
  3. **共享可变引用**（`loopRefBox` / `kbStateRef` / `pendingAsyncResults` / `bypassManager` / `channelLoops` 等，用懒求值容器或原位回填）。
- `ASSEMBLY_IDS`：全量 id 清单（守卫唯一性）。
它不执行代码，只是"施工图 + 锚点"，与 `assembly-runner`、`assembly-graph.test.ts` 协同保证装配不漂移。

### 2.4 `assembly-runner.ts`（装配贡献原语）
- `AssemblyContribution`：`{ id, needs[], provides[], mount(deps) }`。
- `AssemblyRunner`：`provide()` 登记 factory 已就位对象；`run()` 用 **Kahn 拓扑排序** 执行贡献——先跑 needs 全就绪的，provides 写入就绪集合解锁后续；缺依赖/成环时给逐条诊断并抛错（**fail-fast**）；支持**增量多批**（本次 run 产出持久化，下次 run 可消费；同 id 只执行一次）。
它只管"装配顺序"，不管生命周期（生命周期仍走 PluginHost.mount）。

### 2.5 贡献批 `*-contributions.ts` 家族（每批 = 一个 AssemblyRunner.run）
- `base-contributions.ts`：P-A 批。产出 gitManager、turnStore、turnRecorder（needs gitManager+turnStore）、flowRegistry（内置注册 TodoFlow/SpecFlow）。
- `core-contributions.ts`：P-B 批。store×4（Conversation/Event/Stats/Summary）、skillRegistry、skillTool（拓扑保证先建 skillRegistry）。
- `infra-contributions.ts`：P-B 批。memoryStore（needs memoryFilePath）、heartbeatScheduler（内联 `subscribeConfig`）、mcpSystem（内联 `trackMcpSystemForShutdown`）。
- `channel-contributions.ts`：P-B 批。ModelChannelRegistry（`buildFromLegacy/initializeChannels/setMainProvider`）→ ModelRouter（needs channelRegistry）；随后创建角色通道（compression/narration/orchestrator）并提取 `subProvider*` 三元组与 `bypassProvider` 供 delegateTool/bypass 插件。
- `context-chain-contributions.ts`：P-B 批。压缩链拓扑：TokenCounter→StructuredSummarizer→CompressorOrchestrator，加 LayeredContextComposer。
- `orchestrator-contributions.ts`：P-B 批。planStore、LLMOrchestrator（needs provider/planStore/sessionDir/modelRouter）、providerRouter（注册 main/local）、agentRegistry、toolExecutor（needs toolRegistry）、backgroundRegistry。
- `plugin-manager-contribution.ts`：PluginManager 创建（needs toolRegistry/skillRegistry/contextComposer/mcpSystem/cwd）；loadAll/setHooks 留 factory。
- `plugin-contributions.ts`：P-D 批。knowledge/xref/generation 三个插件 host.mount 挂载点，先后由 needs/provides 承载；knowledge 故障降级；generation 把 TTS 句柄回填 `loop.companionVoice`。
- `runtime-contributions.ts`：P-E 批（增量多批首个消费者）。ToolBundleRegistry（needs cwd）、HotReloadManager（needs 11 个依赖，依赖面最大）。

### 2.6 接线 `*-wiring.ts` / 引导家族
- `boot.ts`：启动引导。`boot()` 完成 ConfigManager 加载 + 会话恢复三分支（resume/续用 shouldContinue/新建），按 `startup.defaultMode` 决定初始 Router 模式，渠道隔离恢复；返回 config/configManager/sessionDir/currentSessionId/sessionType/defaultMode。另有 `createSubProviderFactory()`（为 delegateTool 构造子 Agent Provider 的闭包）。
- `bootstrap-wiring.ts`：`bootstrapPersona()`（全局 persona 文件 + 内置 Prompt 目录同步）、`restoreFlowState()`（Flow 持久化恢复）、`initModelCatalog()`（模型目录 + maxContext 上限兜底）。
- `config-wiring.ts`：`wireConfigCenter()` 初始化 RuntimeConfigCenter 单例 + `inject*ConfigCenter×5`（local-config/tool-config/context-config/generation-config/hot-reload-config）+ 日志级别双向同步 + userId 前缀 + effectiveMaxTurns/effectiveMaxContext 计算。
- `runtime-wiring.ts`（最重，~19KB）：封装 `registerLoopBackfill`（kbState/pendingAsyncResults/loopRef 回填）、`setupChannelRegistries`（`__channelLoopRegistry`/`__channelSessionRegistry` globalThis 单例 + 定时任务降级链 `resolveChannelLoop`）、`installSchedulerHandler`（命令式/陪伴广播/降级链路由）、`wireConfigSubscriptions`（models.*/local.* 订阅 + 恢复持久化 disabled 状态）、`wireMcpStatusCallback`、`wireReadToolImageHandler`、`wireFallbackNotifications`（降级链切换/恢复时自适应 session.maxContext + 一次性通知）。
- `bypass-wiring.ts`：`mountBypassPlugins()` 挂 permission-chain（fail-fast）/bypass（fail-fast）/world-engine（降级）三插件，并按 sessionType 激活旁路 agent；`restoreCompanionRouter()`（恢复陪伴 Router + 上次角色名）。
- `tool-registration.ts`：`registerLoopDependentTools()` 在 AgentLoop 构造后注册依赖 loop 的工具批（runtime-control 30+ 工具、trigger_compression、destroy_sub_agent、陪伴模式工具、companion_say、rollback、flow 控制、ask_user）。
- `context-sources.ts`：`registerContextSources()` 注册 11 个 ContextSource（env-info/channel_context/flow/memory/companion_memory/session-tools/skill-*/agent-*/intent_cluster_summary/image_store/tool-bundles），统一到 contextComposer；时序安全靠 section-resolver 按 zone/priority 排序。

### 2.7 运行入口
- `cli.ts`（~49KB）：`runCli()` 用 commander 定义主命令与 setup/setup-generation/doctor/tui/serve 等子命令；`executeAction()` 串起单次/交互/TUI 三种运行；`createCliHandler()` 构造纯文本 `OutputHandler`（写 stdout 的彩色文本 + 权限确认交互）；`runServer()` 启动 HTTP 服务；另含 restart 文件清理、端口检测、浏览器打开等辅助。
- `server.ts`：`startServer()` 组装 **渠道体系**——ConfigManager 加载 env keys、ProviderManager 创建主 Provider、SessionManager、ChannelManager，注册 `HttpWebhookChannel`（HTTP API/WebUI），`registerConfigChannels` 按 config 注册飞书等渠道，配置热监听（fs.watchFile），`agentFactory` 回调包装 `createAgent`，最后 `manager.startAll(agentFactory)`。
- `tui.ts`（~84KB，入口层最重）：`runTui()` 启动全屏终端 UI；内含状态栏/加载指示/token 估算/消息批量处理 `processBatch`、输入处理 `handleInput`、斜杠子命令分发 `handleSlashSubCommand`、`resolveHandler` 等。它会创建自己的 `OutputHandler`（把流事件渲染到终端），并持有 `AgentLoop`。
- `tui-*.ts` 命令族：把 TUI 的各类斜杠命令拆成独立模块——`tui-format.ts`（文本格式化）、`tui-permission.ts`、`tui-search.ts`、`tui-session-cmds.ts`、`tui-channel-cmds.ts`、`tui-compress-cmds.ts`、`tui-model-cmds.ts`、`tui-model-local.ts`、`tui-ask-user.ts`、`tui-welcome.ts`（各有 `.test.ts`）。

---

## 3. orchestrator 层（AgentLoop 主循环，约 22 文件）

### 3.1 `loop.ts`（73KB，主循环本体）
- **`OutputHandler` 接口**：执行链与上层（CLI/TUI/WebUI）的**唯一解耦面**——onText/onThinking/onToolUse/onToolResult/onDiff/onStatus/onTurnStart/onFlush/onInterrupt/onPermissionRequest/onAskUser/onEvent。任何实现它的对象都是合法输出端（可插拔）。
- **`AgentLoopServices` / `AgentLoopConfigOptions`**：P6-2 拆两层。服务表（provider/contextComposer/compressor/orchestrator/toolExecutor/toolRegistry/stores/skillRegistry/mcpBridge/.../turnRecorder）+ 配置表（sessionDir/maxTurns/maxContextTokens/personaDir/dangerousTools/allowlistTools/loopHooks）。新增服务 = 服务表加键 + 装配方提供，构造器不感知。
- **构造器**：创建内核三件套（`createKernel`）、填充 `stageServices` 服务表（含 `getRouter` 惰性闭包、`toolService`、`clusterService`、`bypassManager` 惰性闭包）、初始化 `LoopGuard`、`ToolResultBuffer`、`GitManager`；恢复持久化 allowlist/dangerousTools；订阅 configCenter（safety.*、context.*）；注册 view_image 工具。
- **`run(userInput)`**：入口，用 `_runMutex`（串行化锁）保护 -> `_runInternal`：
  1. 重置中断/防死循环/表达缓冲；启动 scheduler（懒）。
  2. 注入 pending 定时任务通知；注册 SIGINT 中断（中止 AbortController）。
  3. 加载持久化摘要；`syncRouter()`（保证新旧渠道一致）。
  4. input 预处理（陪伴模式剥 [[旁白]] 交给旁路）；构造用户 Message（视觉能力自动检测图片路径/渠道预取图片），追加到 conversation/eventStore。
  5. **主循环 while(true)**：每轮调用 `runTurn()`；`onIterationEnd` 钩子；消费异步子 Agent 结果队列（持久化 stop=false 强制续迭代）；stats 记账；旁路 Agent 迭代审查（`postTurn`）；遇到 stop 或 LoopGuard 升级则退出。
  6. Post-turn：`onTurnEnd` 钩子 + `router.onPostTurn` + bypass postTurn + 陪伴表达兜底（模型未调 companion_say 时把普通文本包装成台词语音事件）+ 簇归类消费（markCluster + maybeCompressCluster）+ orchestrator 历史回填；图片回收。
  7. catch 里发 `onTurnError`；finally 移除 SIGINT。
- **`runTurn()`**：单轮六阶段（全部经 `pipeline.runSlot` 逐槽执行）：
  1. `onTurnStart` 钩子 + `turnRecorder.startTurn` + `syncRouter`；
  2. 构造 `createTurnState` 初始态 -> **input 槽**（历史读入/归一化；作用副作用：contextDirty 热更新、强制重压缩）；
  3. Provider 路由决策（`providerRouter.route`）定 `activeProvider`；消费 fallback/recover 一次性通知；
  4. **bypass 槽**（preTurn 缓存/注入合并/意图消费）；
  5. **context 槽**（工具过滤/effectiveHistory/图片注入/kb/cluster/compose/压缩消费与触发），回读压缩与摘要副作用；
  6. **llm 槽**（thinking/流请求/OutputRouter 解析/去重/scavenge/只 thinking 兜底/stats/assistant 落盘）；
  7. 有 toolCalls -> **tools 槽**（inline flush 或 executeTools + before/afterToolExecute 钩子）-> checkTextLoop -> **finalize 槽**(toolCalled 分支)；无 toolCalls 则检查 Flow 活跃 -> **finalize 槽**(flowStillActive 分支)。两分支最终都 emit `beforeIterationEnd` 并返回 stop/toolCalled。
- 辅助私有方法：`makeStageCtx()`（构造 StageContext，iteration=currentTurn/signal/单 get/require 读 stageServices）、`makeToolExecContext()`、`makeClusterDeps()`、`checkTextLoop()`（LoopGuard 文本循环检测，写反射 user 消息）、加 provider 切换族薄壳。

### 3.2 `create-kernel.ts`（内核装配入口）
- 产出 `KernelComponents`：`loopHooks`（HookBus<LoopHooks>）、`pluginHost`（PluginHost，挂载面 = loopHooks）、`pipeline`（Pipeline<TurnState,_,StageServiceMap>）。
- `DEFAULT_PIPELINE_SLOTS`：与 `runtime/defaults.ts` 的 `kernel.pipeline` 骨架一致的 6 槽位默认值。
- `createKernel()`：装配三件套——循环 `BUILTIN_STAGE_CONTRIBUTIONS` 经 `pipeline.registerStageModule` 注册（与插件替换内置同一 API），然后 `assemble()`（契约校验 fail-fast），并把 pipeline 服务化注册进 pluginHost（`kernel.pipeline`）供插件运行时替换阶段。
- 命令体现 `verify:layers` 的目标：kernel 只依赖 logging；orchestrator 提供 `StageServiceMap` 类型化服务面。

### 3.3 `stage-registry.ts` / `stage-services.ts`
- `stage-registry.ts`：单一真源。`StageContribution`（id+create）、`BUILTIN_STAGE_CONTRIBUTIONS`（6 条：input/bypass/context/llm/tools/finalize 的 `create*Stage`）、`BUILTIN_STAGE_IDS`（守卫与 DEFAULT_PIPELINE_SLOTS 的 impl 一致性）。
- `stage-services.ts`：内核服务注册表的**类型化声明**。`StageServiceMap` 把每个服务键映射到具体类型（conversationStore/configCenter|undefined/compressor/turnRecorder|undefined/sessionDir/toolRegistry/contextComposer/summaryStore|undefined/statsManager/gitManager/outputHandler|null/maxContextTokens/personaDir|undefined/bundleRegistry|undefined/kbState|null/loopHooks/getRouter/eventStore/orchestrator/bypassManager()|undefined/toolService|undefined/clusterService|undefined）。`KernelStageContext = StageContext<StageServiceMap>` 使 get/require 键、返回类型编译期受保护。

### 3.4 `stages/` 六阶段模块（内核管道槽位填充者）
每个阶段都实现 `StageModule<TurnState, StageServiceMap>`（id/name/version/reads/writes/run），**契约** `reads/writes` 声明其读写字段，`requires ⊆ 声明` 由装配期 `checkContract` 校验。每个文件末尾推出 `*_STAGE_SERVICES` 常量为装配方参考。
- `input.ts`（`builtin:input-normalize`）：历史读入（conversationStore.readAll）、userInput 提取/归一化（排除纯 tool_result）、续轮判定（hasPendingToolCalls）、剥离最后 user 文本消息、陪伴表达文本化（materializeExpressions）、旁白覆盖（consumes 后置 null）。reads: history/userInput/ephemeralInput/companionMode；writes: history/userInput/hasPendingToolCalls/historyWithoutLastUser/lastUserTextMsg/uncompressedMsgs/ephemeralInput。
- `bypass.ts`（`builtin:bypass-preturn`）：首轮（bypassInjectionsCache 未建）经 bypassManager.preTurn 产出（改写 userInput、注入缓存、orchestrator 意图消费+bypass_intent 事件）；每次迭代合并 preTurn 缓存 + postTurn 运行时注入（consumeInjections）。writes: userInput/bypassInjections/bypassInjectionsCache/intent/intentLabel。
- `context.ts`（`builtin:layered-composer`，模块级最重）：工具过滤（Router 白名单/黑名单、bundle 展开、激活触发激进压缩）、历史预处理 effectiveHistory、图片注入（视觉模型，注入后调用方清空 pendingImageInjections）、知识库 kbQuery 更新、意图簇历史过滤（clusterService.buildClusterHistoryTransform）、before/afterContextAssemble 钩子、`composer.compose()` 分层组装 + zoneBreakdown 记账、**压缩消费与触发**（Step1 消费上一轮后台压缩：replace 存储、换模板、重 compose、激进兜底检测；Step2 当前轮超标：紧急阈值同步压缩 / 普通阈值后台异步压缩 + clusterService.restoreSummary）、stats 记账。writes 覆盖 toolDefinitions/messages/zoneBreakdown/summary/lastSavedSummary/lastContextTokens/needsCompression 等一长串。
- `llm.ts`（`builtin:provider-stream`）：thinking 配置（/think 运行时切换）；`activeProvider.createStream(messages, tools, ctx.signal)` 流式请求；构造 `OutputRouter` 解析流（onText/onThinking/onToolUse/onUsage/onStop），事件落盘（memory/events.ts）+ cache 统计（DeepSeek/OpenAI 与 Anthropic 缓存字段归一化）；`onStreamEvent` 钩子；**流内工具执行**（TOOL_USE 到达即 `toolService.executeSingleInline`）；工具调用去重（ResilientProvider 重试流产生的孤儿）；scavenge 修复（从 thinking 恢复漏声明工具）；thinking-only 兜底；assistant 消息构建+落盘（Flow 工具不记历史只记事件）。writes: streamText/toolCalls/stopReason/cacheStats/inlineToolExecuted/inlineToolResults。
- `tools.ts`（`builtin:tool-dispatch`）：工具调度。无 toolCalls 原样穿过（toolCalled=false）；`beforeToolExecute` 钩子（权限链/storm/turnRecorder 预录）、recentToolNames 更新、plan 进度更新（orchestrator.updatePlanProgress）、inline 已执行则 `toolService.flushInline` 否则 `toolService.executeTools`、`afterToolExecute` 钩子（携带真实成败结果）。writes: toolCalled/recentToolNames/activePlan/inlineToolExecuted(→false)/inlineToolResults(清空换新 Map)。
- `finalize.ts`（`builtin:turn-finalize`）：回合收尾。三态判定表：toolCalled→继续下一轮（stop=false，不写 stop 事件）；flowStillActive→继续 loop（不写 stop 事件，死循环由 LoopGuard 兜底）；默认→写 stop 事件并 stop=true。每次先 `turnRecorder.endTurn`（尽力而为）。

### 3.5 `turn-state.ts`
- `TurnState`（一次迭代的状态，阶段间显式传递）：按阶段分区——内核记账(turn/stop/stopReason/toolCalled)、input(history/userInput/hasPendingToolCalls/ephemeralInput/companionMode/...)、bypass(bypassInjections/intent/intentLabel/historyTransform)、context(toolDefinitions/messages/zoneBreakdown/lastContextTokens/summary/needsCompression/.../pendingImageInjections)、llm(activeProvider/streamText/toolCalls/inlineToolResults/cacheStats/fallbackInfo)、tools(toolResults/pendingAsyncResults/recentToolNames)、finalize(companionExpressions/activePlan/flowStillActive)。
- `SessionState`（跨回合会话态，挂在 loop 实例）。
- `createTurnState()`（工厂，runTurn 入口调用）。
- 支撑类型：PendingImage、InlineToolResult、CacheTurnRecord、CacheStats、AsyncAgentResult、CompanionExpression、ToolExecSummary。

### 3.6 拆分辅助族（loop.ts 拆出的模块级函数群）
- `loop-hooks.ts`：`LoopHooks` 声明 **10 个钩子点**（onTurnStart/beforeContextAssemble/afterContextAssemble/onStreamEvent/beforeToolExecute/afterToolExecute/beforeIterationEnd/onIterationEnd/onTurnEnd/onTurnError），`LOOP_HOOK_NAMES` 清单，`createLoopHookBus()` 创建 HookBus。
- `loop-provider.ts`：Provider 路由族（toggleProvider/switchProvider/tryCreateProviderFromConfig/subscribeConfig/switchToAutoRoute/getProviderRoutingInfo/setModelSource/getModelSources），参数化 deps + 回调，loop 同名方法转发，签名不变。
- `loop-tools.ts`：工具执行器（*B1 拆出*）——`ToolExecContext`（执行上下文 + 可变状态访问器）、`ToolExecOutcome`、`checkCommandAllowed`、`runToolDispatch`（后置执行）、`runToolInline`（流内单工具）、`flushInlineResults`（回写），深度依赖权限链/storm/resultBuffer/turnRecorder。
- `loop-session.ts`：会话级清理工具（removeLastRoundFromJsonl/cleanCompanionJsonl/removeTriggerFromJsonl）。
- `loop-cluster.ts`：意图簇 + deep 压缩辅助（buildClusterHistoryTransform/maybeRestoreSummary/maybeCompressCluster/loadClusterIndex + ClusterDeps/ClusterIndexEntry）。
- `loop-image.ts`：已处理图片回收（旧 base64→占位符+模型描述）。
- `planner.ts`：`LLMOrchestrator` 骨架（assess/plan LLM 已移除，保留 Provider 切换与 plan 进度追踪 `updatePlanProgress`）。
- `plan-store.ts`：`Plan`/`PlanStore`/`formatPlanAsText`/`createPlan`（计划持久化与展示）。
- `tool-service.ts`（闭包触手正规化）：`ToolService` 接口（executeTools/executeSingleInline/flushInline），`createToolService(() => makeToolExecContext())` 惰性构造每轮取当前值。
- `cluster-service.ts`（闭包触手正规化）：`ClusterService` 接口（buildClusterHistoryTransform/restoreSummary/setDeepCompressState/getNeedsCompression/setNeedsCompression），`createClusterService(() => makeClusterDeps())`，把三个 mutable 字段从 loop 私有迁入服务内部，消灭 `as any` 直连。
- `orchestrator/index.ts`：桶文件 re-export AgentLoop/LLMOrchestrator/PlanStore 等。

### 3.7 编排数据流（一轮 end-to-end）
`run()` 复用 history + 注入 userInput --> `pipeline.runSlot('input')`（读历史/归一化输入）--> `runSlot('bypass')`（preTurn 注入 + 意图）--> `runSlot('context')`（compose 出 messages + 压缩决策）--> `runSlot('llm')`（流式请求 + OutputRouter 解析成 text/toolCalls，流内 inline 直执行）--> 若 toolCalls 非空 `runSlot('tools')`（flush/execute 工具写回 conversation）--> `runSlot('finalize')`（stop 判定）--> 循环判据。每轮横切点全部暴露给 10 个 LoopHooks，插件与内置共享同一套接缝。

---

## 4. kernel 层（5 文件，内核原语）

定位：**最小 agent 模式所需的生命周期、接缝与装配原语**。刻意不依赖任何业务模块（orchestrator/channels/...），只依赖 logging。
- `index.ts`：桶 re-export 全部原语。
- `types.ts`：生命周期基础。`Disposable/disposer/toDisposable/noopDisposable/DisposableStore`——对齐 DSH `ctx.effect` 与 VSCode dispose pattern，**注册即返回 disposer，卸载逆序释放**（后注册先释放），异常隔离（单资源失败不阻断其余，抛出最先遇到的错误），幂等。
- `hook-bus.ts`（接缝总线 Seam Bus）：主循环横切逻辑挂载点。三类挂载者：观察者 `on()`（core 前跑，可改写 payload）、拦截器 `intercept()`（洋葱中间件，可短路/包裹/改写）、core（由 run 调用方传入）。执行顺序 `拦截器₁(拦截器₂(...观察者→core))`。泛型 over HookMap（kernel 不认业务类型，`LoopHooks` 由 orchestrator 侧声明）；异常隔离（挂载者抛错被吞并记录）；串行 await（可预期顺序）；`has()` 让调用方跳过昂贵 payload 构造；快路径（无挂载者 → 直接跑 core，零洋葱开销）。API：on/intercept/has/count/observerCount/interceptorCount/hookNames/emit（纯通知）/run/clear。
- `pipeline.ts`（配置驱动、可替换执行链）：由具名槽位串成链，槽位与模块绑定写在配置（`kernel.pipeline`）。`FieldContract`（reads/writes，支持 `a.b`/`a.*`）、`ContractIssue`、`StageContext<Svc>`（iteration/signal/get/require/config/logger）、`StageModule<S,Svc>`（统一签名 `(state, ctx)=>state`，恒等签名换可替换性）、`SlotSpec/PipelineSpec`、`Pipeline` 类（registerStageModule 运行时注册/替换/回滚、assemble 契约校验、snapshot、run 全链、runSlot 单槽驱动、describe）、`checkContract`（requires ⊆ 模块声明）、`createPipelineBus`。契约真相源在代码（模块自带 reads/writes），配置只管装配——避免双份漂移。
- `plugin-host.ts`（可插拔挂载面）：三角色模型（Service Definition/Provider/Consumer）。`ServiceMap`、`PluginContext`（pluginId/logger/config/add/register/get/require/registerTool/registerContextSource/hooks/onHook/aroundHook）、`HyPlugin`（id/deps/activate/deactivate）、`PluginHost` 类（mount/unmount/reload/isMounted/list/dispose；`register()` 恢复注册前值以支持热替换回滚；`setHooks()` 运行时注入总线宿主不重建；deps 校验、activate 失败回滚并保留 error 条目）。`createHookBus()` 便捷创建。

kernel 与 orchestrator 的关系：orchestrator 的 `create-kernel.ts` 用 Pipeline/PluginHost/HookBus 三件套组装出「主循环内核」，`stage-services.ts` 提供类型化服务面；guiating 哲学——kernel 保持零业务依赖，业务侧（StageServiceMap/LoopHooks）只通过泛型塞进去。

---

## 5. parser 层（2 文件，流事件路由）

- `index.ts`：仅 re-export `OutputRouter`。
- `router.ts`：`OutputRouter` 类。`onText/onThinking/onToolUse/onUsage/onStop` 五个可空回调 + `route(event: StreamEvent)` 按判别联合分发（IMAGE 只预留注释、default 走 `never` 穷尽检查保证所有 StreamEventType 已处理；未注册处理器静默忽略）。被 `orchestrator/stages/llm` 实例化消费：把 Provider 原始流事件转成执行链的回调（文本上屏/落盘、工具调用收集、usage 统计、stop 判定）。

---

## 6. runtime 层（3 + 1 文件，运行时配置中心）

- `defaults.ts`：`getDefaultConfig()` 返回 `FullConfig` 完整默认值（provider/session/safety/context/schedule/generation/resiliency/agents/tools/skills/models/local/logging/repair/hotReload/memory/kb/startup/**kernel.pipeline**/bypass/companion/diagnostics/ui）。其中 `kernel.pipeline` 段给出 6 槽位默认装配（input/bypass/context/llm/tools/finalize 各自的 impl + requires 契约），是内核管道与配置衔接的落点。
- `config-schema.ts`：`FullConfig` 类型（前述全部配置域 + `kernel.pipeline`）+ `ConfigSchemaEntry`（schema 描述条）。
- `config-center.ts`：`RuntimeConfigCenter` 单例 —— 运行时配置中心 + **变更通知机制**。核心：
  - 读：`get()`（runtime 覆盖优先，否则 defaults，产路径缺失返回 undefined）、`getAll()`（defaults 与 runtime 深合并后克隆）。
  - 写：`set()`（产路径结构不合法抛错；`setByPath` 写 runtime 覆盖并触发该路径 + 全部**祖先通配路径**（provider.active.model→provider.active.*/provider.*/*）的事件）、`merge()`（深合并并 fireDiffs）、`reset()`（全部或子树还原触发事件）。
  - 订阅：`watch(pattern, cb)` 支持 `*` 通配；每个回调 try-catch 隔离（一个失败不阻断其他）。
  - 行为：`save()`（isSaving 标记防 config-watcher 自触发）、`load()`（从 ConfigManager 重载 + 与默认深合并 + fireDiffs）。
  - 内部：`getByPath/setByPath/hasPath/deleteByPath/generateParentWildcardPaths/deepMerge/deepClone/normalizeConfig(旧扁平→新嵌套)/deepDiff/fireDiffs`。
- 配置变更通知的消费方遍布执行链：loop 构造订阅 safety.*/context.*，`wireConfigSubscriptions` 订阅 models.*/local.*，`subscribeConfig`（loop-provider）订阅 provider.*/session.max* 实现即时切换/更新。该层支撑"任何行为开关/阈值/路径在外部可配"的外部配置化原则。

---

## 7. 模块间依赖方向（结论）

```
gateway/{cli,tui,server} ──► gateway/{factory,agent-assembly,boot,*-contributions,*-wiring}
                                          │
                     agent-assembly ──► orchestrator/{loop,planner,plan-store,create-kernel,...}
                                          │  run()/runTurn() → pipeline.runSlot()×6
                                          │  loop-hooks（HookBus）
                        stages/{input,bypass,context,llm,tools,finalize}
                                          │  ctx.get/require（StageServiceMap）
                                          ├─► parser/router（OutputRouter，llm 阶段消费）
                                          ├─► runtime/config-center（配置 + 变更通知）
                                          ├─► events.ts / memory/events.ts（UI 推送 + 落盘契约）
                                          ▼
                   kernel/{pipeline,plugin-host,hook-bus,types}  ← 零业务依赖，只依赖 logging
                                          ▲
                     (create-kernel 用三件套组装主循环内核；PluginHost 钩子被各插件消费)

分层约束（verify:layers 目标）：
  gateway → orchestrator → kernel → logging（正向依赖，无反向）
  parser → types（流事件契约）
  runtime ← 被 gateway/orchestrator/全业务层注入消费（singleton 注入面）
  events/types = 零依赖中立契约层，业务核心与 UI 协议层共同引用（避免倒置）；事件落盘在 memory/events.ts
```

- **装配依赖**：agent-assembly.ts 依调用序 + 贡献批 needs/provides 拓扑（assembly-runner/assembly-graph）承载；共享可变引用用 `loopRefBox` 懒容器/原位回填。
- **运行依赖**：AgentLoop 是执行链枢纽，上接 OutputHandler（解耦 UI），上接 pipeline（六阶段），阶段内通过 StageServiceMap 取服务；流输出经 OutputRouter 分派；循环守卫生效在 run/_runInternal 与 finalize 三态。
- **安全/治理**：permission-chain/bypass/world-engine 等作为"插件"挂在 loop 钩子上（kernel 原语挂载面），fail-fast 或降级语义由装配方（bypass-wiring）控制。
- **可插拔落点**：除了工厂/注册表式的 Tool/ContextSource/Skill/Agent 注册，还新增了 **kernel.pipeline 槽位级可替换**（改 config 换整模块，插件经 pluginHost 经 `kernel.pipeline` 运行时替换阶段），与贡献批/注册表共同构成"外部配置化 + 可插拔接口稳定"的实现。

---

*本文档基于对上述文件的逐行阅读整理，用于核心执行链的结构导航。*

## 详细 上下文与记忆

> 本文件是对 `src/context/`、`src/memory/`、`src/knowledge/` 三个模块的**纯结构分析**，
> 仅描述职责、类/接口/函数、关系、数据流与依赖方向，不含代码片段。
> 阅读范围：已逐一打开上述三个目录下全部源码文件（含 index 与测试），结论以实际代码为准。

---

## 一、src/context/（约 17 文件）—— 5-Zone 分层上下文组装

### 1.1 模块定位与核心设计

`context/` 是"给 LLM 组装输入"的编排层。整个模块建立在 **Manifest（菜单）与 Composer（厨师）分离** 这一核心原则上：
Manifest 只声明"有什么 section、每个 section 放哪个 zone、什么类型"；Composer 负责"怎么拼"——按 zone 遍历 section、
调用 Resolver 取内容、按 role 合并成消息数组。新增 section 只改 Manifest，改组装逻辑只改 Composer。

模块头注释明确定义了 **7 种上下文变更机制**，本模块各文件分别对应其一：

| # | 机制 | 对应文件 / 入口 | 职责 |
|---|------|----------------|------|
| 1 | manifest | `manifest-types.ts` / `manifest-defaults.ts` / `manifest-loader.ts` | 管结构（有哪些 section，在哪个 zone） |
| 2 | Router | `router.ts` / `profiles.ts` | 管模式（不同模式显示/跳过哪些 section、用哪个 persona/memory） |
| 3 | Injection | `section-resolver.ts`（bypass 注入） | 管动态注入（旁路 Agent 运行时插内容） |
| 4 | Compressor | `compressor.ts` | 管预算保护（超 token 时裁剪历史、生成摘要） |
| 5 | ContextSource | `interface.ts`（ContextSource 类型）+ 各注册点 | 管数据供应（运行时数据从哪来） |
| 6 | activeConditions | `section-resolver.ts` / `composer.ts` | 管条件开关（如 precise_mode） |
| 7 | filterHistory | `composer.ts` / `companion-filter.ts` | 管消息过滤（历史中哪些消息不显示） |

另有 `tokenizer.ts`（令牌计数）、`retriever.ts`（全量历史池检索）、`truncating-composer.ts`（第二实现）、`context-config.ts`（外部可配置参数出口）、`cache-strategy.ts`（缓存策略）、`prompt-builder.ts`（系统提示词构建）。

### 1.2 各文件职责

| 文件 | 职责 |
|------|------|
| `interface.ts` | 定义模块对外的核心接口与类型：`ComposeOptions`（扁平组装输入）、`ContextComposer`（组装接口）、`ContextComposerLike`（收窄后的最小消费者接口——阶段 B 产物，双签名 compose 重载 + `activeConditions` 字段）、`ContextSource`（数据源注册类型，含 `strategy` 与 `cacheability`）、策略与缓存声明类型。 |
| `manifest-types.ts` | 菜单的**类型定义**（机制 1）。`SectionType`（static/template/runtime/retrieval/conditional）、`ContextSourceStrategy`（always_inline/index_only/lazy_expand/phase_bound）、`ConditionName`（precise_mode）、`SectionEntry`、`ZoneEntry`、`ContextManifest`。 |
| `manifest-defaults.ts` | 默认 Manifest（兜底菜单）+ 详尽的 Zone/Section 布局文档。声明 Zone1~5 及全部默认 section。 |
| `manifest-loader.ts` | `ManifestLoader` 加载器。加载优先级：`{cwd}/.agent/context-manifest.json`（项目覆盖）→ 默认 manifest。含 `load/reload/getZone/getEnabledZones/getSections/isZoneEnabled/setZoneEnabled`，支持校验、落盘、热重载。查询接口按 zone.order、按 section.priority 排序。 |
| `profiles.ts` | Router 注册中心（机制 2）。维护 `routerRegistry` Map 与全局活跃 Router 名，提供 `registerRouter/switchRouter/getActiveRouter`。启动时注册 `NormalRouter`/`CompanionRouter`。并保留 deprecated 的 `ContextProfile`/`NORMAL_PROFILE`/`COMPANION_PROFILE` 与 `isCompanionModeActive` 等旧 API 作为向后兼容。 |
| `router.ts` | 统一上下文路由器。定义 `IContextRouter` 接口（工具白/黑名单、skipSections/skipRuntimeSources、sourceOverrides、transformUserInput、filterHistory、beforeSection、roleForSection、onActivate/onDeactivate、getTaskPrompt、onPostTurn）。实现 `NormalRouter`（默认全pass-through）与 `CompanionRouter`（陪伴模式：精简工具、跳过框架 section、persona 与 memory 覆写、世界引擎旁路、时间戳概率注入、JSONL 清理等）。 |
| `section-resolver.ts` | Section 内容解析器（机制 3+6）。`ResolverContext` 承载一切解析所需输入。`resolveSection()` 为统一入口：先走 Router `beforeSection` 钩子，再处理 bypass 注入（replace/append），再按 `type` 分发到 `resolveStatic/resolveTemplate/resolveRuntime/resolveRetrieval/resolveConditional`。另导出 `buildSoulSection`。 |
| `composer.ts` | 核心组装器 `LayeredContextComposer`（机制 7 filterHistory + 组装主流程）。组装 LayeredContext，含 Zone 遍历、role 合并、Zone3 内容 hash 采集、缓存断点打点、token 统计。实现 `ContextComposer`（implements）。定义 `LayeredComposeOptions`、`LayeredContext`、`ZoneBreakdown`。 |
| `tokenizer.ts` | 令牌计数。`TokenCounter` 基于 `js-tiktoken`（对应 'gpt-4' 模型），提供 `countTokens/countMessageTokens/countMessagesTokens`，含 role 开销、text/tool_use/tool_result/thinking/image 各 content 类型的开销模型。 |
| `compressor.ts` | 压缩编排（机制 4）。`ToolOutputTrimmer`（Phase1 规则裁剪）、`StructuredSummarizer`（Phase2/3 LLM 摘要）、`CompressorOrchestrator`（多轮迭代编排）。 |
| `retriever.ts` | Zone4 池检索 `Retriever`。从全量历史 `conversation.jsonl` 池中按关键词交集+文件路径加分+位置衰减检索补充上下文；含 git 上下文检索通道。 |
| `cache-strategy.ts` | 缓存策略 `CacheStrategy`（接口）+ Anthropic（manual-markers）/Gemini（auto-prefix）/AutoPrefix 实现 + `registerStrategy/getCacheStrategy` 注册查找。 |
| `prompt-builder.ts` | `SystemPromptBuilder`（按 priority 合并 system sections）；`loadProjectContext`（按优先级加载 .agent.md/AGENTS.md/CLAUDE.md/.cursorrules + 提示注入检测）。 |
| `companion-filter.ts` | 陪伴模式历史过滤（机制 7 的辅助）：`materializeExpressions`（把 companion_say 表达轮文本化）、`filterToolRounds`（移除含工具调用/工具文本的整轮）。 |
| `context-config.ts` | 外部配置出口。`injectContextConfigCenter/getContextConfig` 及一组便捷读取函数（safetyThreshold、targetRatio、clusterBudgetRatio、zone5TailBudgetRatio、zone4BudgetRatio、maxCompressRounds、trimWindow），统一走 `context.*` 配置键，注入前回退硬编码默认值。 |
| `truncating-composer.ts` | `ContextComposerLike` 的**第二个真实实现**（门槛 2 验收件）。激进截断策略：不做分层/manifest，预算超限直接从最旧开始丢。含自带 token 估算、双签名判别。注释记录了接口观察点 O1~O4。 |
| `index.ts` | 模块公共出口，重导出上述类型与类/函数。 |
| 测试（5 个） | `context.test.ts`、`truncating-composer.test.ts`、`context-config.test.ts`、`manifest-loader.test.ts`、`cache-stability.test.ts`。 |

### 1.3 5-Zone 布局（manifest-defaults.ts 声明，manifest 可覆盖）

| Zone | 名称 | 默认启用 | role | 内容定位 | 缓存特性 |
|------|------|---------|------|---------|---------|
| Zone 1 | Anchor | 是 | system | 身份/人设/工具规则/工具包索引/Skill/Agent/MCP 注册表/记忆/注意 | 最稳定，享受前缀缓存 |
| Zone 2 | Manifest | 否 | — | 辅助索引区（sections 为空，默认关） | 供需要独立断点的 Provider 用 |
| Zone 3 | History | 是 | user | 项目上下文文件 / 摘要 / 对话历史消息 | 持续增长区，由压缩器管边界 |
| Zone 4 | Context | 是 | user | 知识库检索结果（runtime:kb_context） | 可独立开关以省 tokens |
| Zone 5 | Live | 是 | user | Flow 注入/渠道上下文/会话临时 MCP/工具/时间戳/用户输入 | 每轮变化，不缓存 |

Zone1 的默认 sections 含 `persona_precise`（conditional, precise_mode）、`persona_soul`（static）、`tool_rules`、
`tool_bundles`、`skills`、`agents`、`mcp`、`memory`（均 runtime）、`attention`（static）。
Zone3 含 `project_context`（retrieval）、`history_summary`（runtime:summary）、`history`（runtime:history）。
Zone5 含 `flow_injection`、`channel_context`、`session_mcp`、`session_tools`、`orchestrator_hint`、`timestamp`、`user_input`。

### 1.4 ContextComposer 组装流程（composeCore）

1. 通过 `getManifestLoader(cwd)` 取 loader，`getEnabledZones()` 得到按 order 排序的启用 zone 列表。
2. 构建 `ResolverContext`（注入 sources、activeConditions、router、profile、bypassInjections、tokenCounter、gitManager 等）。
3. 逐个 zone 调 `assembleZone`：
   - zone role 为 `system`：逐 section 解析，conditional 先按 activeConditions 判断；把解析结果注册进 `SystemPromptBuilder`，最后 build 成一条 system 消息。
   - zone role 非 `system`：逐 section 解析；`runtime:history` 特判展开为独立消息（跳过 system/纯 thinking/系统注入文本）；其余按 sectionRole 与 zoneRole 的异同决定合并进同一消息或独立成系统/其他角色消息；`flushTextParts/flushSystemParts` 负责落消息。
   - 记录 zone 消息数与 token 数（zoneMsgCounts / breakdown）。Zone3 组装后计算其消息 md5 集合（zone3Hashes），供 Zone4 去重。
4. Zone 遍历结束后按 `providerType` 取缓存策略：先 `clearMarkers`（清除历史残留 cache_control），再按 `computeMarkers` 在 Zone 边界消息上打 `cache_control`（仅 system/user 消息，assistant 跳过）。
5. 汇总 `zoneBreakdown`（含 total），清理 promptBuilder，返回 `LayeredContext { messages, zoneBreakdown }`。
6. `compose` 双签名：有 `sessionDir` 判为 Layered 路径走 composeCore；否则走 legacy 扁平路径（把 systemPrompt 注册为 `legacy_system_prompt` section，转成 Layered 再组装，返回 messages）。
7. `previewZone` 供设置页展示单 zone 真实预览内容（复用已注册 ContextSource）。

### 1.5 Section 解析与注入（section-resolver）

`resolveSection(sec, ctx)` 处理顺序：
1. **Router 介入**：`ctx.router.beforeSection` 若返回非 undefined，直接采用（null→跳过）。
2. **Bypass 注入（Injection）**：按 section name 查 `bypassInjections`；`mode='replace'` 完全替代；`mode='append'` 追加到正常结果末尾。
3. **按类型分发**：
   - static：`persona_soul` 特殊处理（precise_mode 下不注入；Router `sourceOverrides` 可换 persona 源/追加；否则 `buildSoulSection` 拼 SOUL/IDENTITY/USER）；其他 static 走 `loadPrompt`。Router `skipSections` 优先。
   - template：用 templateVars（cwd、toolNames）渲染 `loadPrompt` + `renderPrompt`。
   - runtime：按 source 前缀分派——`runtime:plan/impact/summary/timestamp/userInput/env/skills/agents/mcp/mcp_live/tools_live/mcp_status/tool_bundles/memory/history`。`runtime:memory` 允许 Router/profile 覆写 memory 源；`runtime:skills/agents/mcp` 用 `buildSourcePartsFromCtx` 按 cacheability 与 strategy 汇总；`runtime:history` 显式返回 undefined（由 composer 特判处理）。
   - retrieval：`runtime:projectContext` 走 `loadProjectContext`；`runtime:pool`/`runtime:git` 走 `Retriever`（用 fullHistory 池、excludeLast、excludeHashes、maxTokens=zone4BudgetRatio%，可选 gitManager）。
   - conditional：`precise_mode` 条件满足才走 static 解析。
4. 通用回退：任意 `runtime:*` 未命中特判时，从 `ctx.sources` 按 name 查找 ContextSource 取内容。

### 1.6 Cache 策略（cache-strategy）

`CacheMode` 四值：`none`（local/llamacpp）、`auto-prefix`（DeepSeek/OpenAI/Groq 等）、`manual-markers`（Anthropic，打 cache_control 断点）、`pre-create`（Gemini 显式 CachedContent，预留）。
- `AnthropicCacheStrategy`：maxMarkers=4，BP1→zone1 首消息、BP2→zone2 首、BP3a→zone3 首、BP3b→zone3 次消息。
- `GeminiCacheStrategy`：当前走 auto-prefix（隐式），`zonesToPreCreate` 预留返回 ['zone1','zone2']。
- `AutoPrefixCacheStrategy`：零标记，为未注册 Provider 的兜底策略。

### 1.7 Router 与陪伴模式（router + companion-filter）

`IContextRouter` 是全模式上下文行为的统一入口。`CompanionRouter.filterHistory` 调 `filterToolRounds`（先 `materializeExpressions` 把 companion_say 轮次文本化，再整轮清洗含工具调用的内容）；`transformUserInput` 解析 `[[旁白]]` 走世界引擎旁路；`beforeSection` 处理角色 persona.md 读取与时间戳概率注入（首接触 100%/提问强制/随机 30%）；`roleForSection` 让 timestamp 槽被世界旁白顶替时以 assistant（内心独白）身份注入；`onActivate/onDeactivate` 负责会话目录、KVCache 隔离 user id、BypassManager 激活世界引擎。

### 1.8 压缩编排（compressor + context-config）

- `ToolOutputTrimmer`（无 LLM）：`trimToolResults`（非最近 N 条的工具结果浓缩并缓存原值）、`deduplicateToolResults`（MD5 去重的重复结果替换为引用）、`truncateLargeToolCalls`（超大 tool input 做 Write/Edit/通用智能摘要）。
- `StructuredSummarizer`（LLM）：按 `compressDepth`（激进/平衡/保守）生成摘要提示词；无前摘要=Phase2 首次摘要，有前摘要=Phase3 增量更新；经 ModelRouter 的 `compression` provider 流式生成；`serializeMessages` 归一化消息文本。
- `CompressorOrchestrator`：`needsCompression`（usageRatio > compressThreshold）触发；`compress` 执行多轮迭代（最多 maxRounds 轮）——每轮 `splitByTokenRatio` 按比率切 layer3（最旧，LLM 摘要）/layer2（中间，规则裁剪仅第 1 轮）/layer1（最新保留），`fixOrphanedToolResults` 修配对，收敛检查（≤targetRatio 或 ≤0.5 停），未收敛则缩小保护区；第 4 阶段为保护区规则裁剪兜底；第 5 阶段 `fixGlobalOrphanedToolResults/fixGlobalOrphanedToolCalls` 全局配对完整性校验。支持 `clusterKey` 分簇压缩（按 `clusterBudgetRatio()`=0.7 分桶预算，摘要存 `clusterSummaries`），被压缩消息标记 `_compressed` 供写回全量存档。一个压缩实例同时维护 `currentSummary`（全局）与 `clusterSummaries`（分簇）。

### 1.9 与模块外依赖方向（context）

- **依赖出去**：`../types`（Message/ToolDefinition/ProviderType）、`../setup/config`（ContextConfig）、`../tools/interface`、`../tools/sqlite`（间接）、`../prompts/loader`（loadPrompt/renderPrompt）、`../evolution/git-manager`、`../hot-reload/manifest-watcher`（getManifestLoader）、`../gateway/factory`（注册 ContextSource，间接）、`../bypass/types`（Injection）、`../memory/summary`（SummaryStore）、`../provider/interface` + `../provider/model-router`、`../setup/persona-bootstrap`、`../utils/misc`、`../runtime/config-center`、`../world-engine/agent`、`../provider/user-id`、`../memory/companion-session`、`../memory/session`。
- **被依赖进**：`ContextComposerLike` 被内核 stage（`stages/context.ts`）与插件消费；`ContextSource` 由 gateway/factory 及各下游注册；`CompressorOrchestrator` 供内核/stages 压缩调用。context 也被 TUI/settings 用于 `previewZone`。

---

## 二、src/memory/（约 9 文件）—— 会话 / 持久化 / 统计 / 摘要 / 陪伴

### 2.1 各文件职责

| 文件 | 职责 |
|------|------|
| `index.ts` | 模块出口，重导出 SessionManager、ConversationStore、EventStore、StatsManager、SummaryStore 及事件类型。 |
| `session.ts` | **会话管理**。`generateSessionId`（{channel}_YYYYMMDD-HHMMSS-XXXX）；`SessionManager`：create（normal/precise/companion，建目录+初始化 conversation.jsonl/events.jsonl/stats.json/meta.json）、resume（指定/最新/按渠道）、list、getLatest、getLatestByChannel（按渠道过滤防跨渠道串用 session）、getSessionDir、cleanup（按 AGENT_MAX_SESSION_AGE，默认 30 天清理过期）。sessions 根目录 `~/.agent/sessions/`。 |
| `conversation.ts` | **对话持久化**。`ConversationStore`：append（写 conversation.jsonl + 同步全量存档）、readAll/readLast/count、truncate（超 maxMessages 截旧）、replace（原子写，压缩后写回）、FULL_FILE=`conversation_full.jsonl` 全量存档（永远追加、行号稳定），及 markCluster/markCompressed（给全量存档写 `_cluster_id`/`_compressed` 标记）。 |
| `events.ts` | **事件存储**。`EventStore`（events.jsonl 追加/读取）。定义事件类型联合 `SessionEvent`：SessionStartEvent、UsageEvent、ToolCallEvent、UserInputEvent、ClusterAssignEvent（旁路意图簇归类，含行号范围）、BypassIntentEvent。 |
| `stats.ts` | **统计追踪**。`StatsManager`（stats.json）：init/update/get/increment，字段为 SessionStats（input_tokens/output_tokens/turn_count/compact_count/current_context_tokens）；写失败时自动重建目录。 |
| `summary.ts` | **摘要持久化**。`SummaryStore`：FULL_SUMMARY=`summaries/_full.md`；`clusterFile`/`capabilityFile` 分桶路径（summaries/cluster_{id}.md、summaries/summary.{capability}.md）；save/load；`saveClusterSummary`（clusterKey 白名单校验 `[a-zA-Z0-9_-]{1,64}`）、`getClusterSummary`（general 桶回退到全量摘要）。 |
| `memory-store.ts` | **跨会话项目记忆**（/memory 命令）。`MemoryStore`：文件读写（readFile 路径），load/save/append/formatForContext（加 HEADER）/initializeIfNeeded。 |
| `session-allowlist.ts` | **会话白名单**。`load/save/addTool/addCommand/isToolAllowed/isCommandAllowed`，存取 `allowlist.json`（allowedTools/allowedCommands）。 |
| `companion-session.ts` | **陪伴模式会话**。`CompanionSessionManager`（全局单例）：按角色隔离目录 `~/.agent/companion/<角色名>/`，setCharacter/getOrCreate（自动建目录+初始化）、reset（归档对话文件、保留 world.json）、listCharacters（有 persona.md 的目录）、getLastCharacter/setLastCharacter（.last-character）。 |
| 测试（2 个） | `memory.test.ts`、`memory-store.test.ts`。 |

### 2.2 数据流与关系

- **会话生命周期**：`SessionManager.create` 建目录 → 初始化三个文件 → 写 meta.json → 通过 `EventStore` 写 `session_start` 事件 → `StatsManager.init`。
- **对话写入**：运行时每轮消息 → `ConversationStore.append`（活跃文件+全量存档）；触顶后 truncate 旧消息；压缩后经 `ConversationStore.replace` 写回并 `markCompressed`；意图簇归类写 `markCluster`。
- **摘要流**：`CompressorOrchestrator`（context 模块）→ `SummaryStore.saveClusterSummary/getClusterSummary`（分为 summaries/summary.{capability}.md）→ 供 context `runtime:summary` 读取。
- **陪伴模式**：`CompanionSessionManager` 被 `CompanionRouter.onActivate/onDeactivate` 使用（切会话、恢复角色），reset 时仅归档不删世界数据。
- **跨会话记忆**：`MemoryStore` 相对独立，直接落一个 md 文件，顶层 `/memory` 命令或 `runtime:memory` section 读取。

### 2.3 依赖方向（memory）

- 依赖 `../types`（Session、Message、SessionStats）、`../logging/logger`、`../utils/misc`（toProjectKey）。
- 会话/事件/统计之间**横向协作**（session.ts 内动态 import events/stats）。
- 被 context/companion/loop/stages 消费：router 依赖 `../memory/session` 与 `../memory/companion-session`；compressor 依赖 `../memory/summary`。

---

## 三、src/knowledge/（约 10 文件）—— SQLite FTS5 知识库 / CJK / Tag IDF

### 3.1 各文件职责

| 文件 | 职责 |
|------|------|
| `index.ts` | 模块出口，重导出 Retriever 类型、Fts5Retriever、KnowledgeBase、索引器/监控/工具/结构化库相关。 |
| `retriever.ts` | **检索后端抽象**。`Retriever` 接口（name/search/add/remove/update/findBySource/list/count/close）；`KbDocument`、`KbSearchResult`（含 <b> 高亮 snippet）。未来可换 Vector/Hybrid 实现。 |
| `fts5-retriever.ts` | **FTS5 实现** `Fts5Retriever`。用 node:sqlite DatabaseSync；docs 表 + docs_fts FTS5 虚拟表（content=docs 外链）+ 三个触发器同步；CJK bigram 分词（`indexContent` 追加 bigram、`bigramQuery` 把中文查询转 bigram）；中文走 `preprocessQuery` 变体链多次降级；CRUD + `migrateSchema` 迁移旧 schema。 |
| `query-preprocessor.ts` | **中文查询预处理器**。`preprocessQuery(rawInput)` → QueryVariants（raw/keywords/variants）。CJK 停用词表；`segmentCjk` 按 4→2 逐级滑窗+单字产出词；变体链= 单个关键词 + 相邻二词短语 + 清洗后原文 + 原始输入（去重）。 |
| `store.ts` | **知识库状态管理** `KnowledgeBase`。管理 enabled/zone4Enabled 开关；懒加载 retriever（默认 Fts5Retriever）；把存储/检索委托给 Retriever。 |
| `indexer.ts` | **文件索引器**。文本扩展名白名单；`indexFile`/`indexDirectory`（可复制到 kb files/ 目录，文件系统为主存储）；`removeFile`/`updateFile`/`syncDirectory`（全量对账 依赖 Retriever；按 source 找 id 去重更新）。 |
| `watcher.ts` | **文件监控** `KnowledgeWatcher`。可选依赖 chokidar（未装则降级禁用）；启动时 `syncDirectory` 全量同步；add/change/unlink 事件 + 300ms 防抖分别调 updateFile/removeFile。 |
| `tools.ts` | **LLM 工具暴露**。`createKbAddTool/createKbListTool/createKbDeleteTool/createKbUpdateTool/createKbToggleTool`（kb_add/list/delete/update/toggle）。每个工具以 `kbGuard` 守卫启用状态；kb_toggle 还联动 contextComposer 的 `activeConditions.add('zone4_enabled')`。 |
| `structured-store.ts` | **结构化知识库存储** `StructuredStore`。entries 表 + entries_fts 外链表 + 触发器。`matchByTags`（Tag 子串匹配 + IDF 加权 + title 加分）、`searchFts`（FTS5 兜底）、`expandRefs`（refs 链式扩展）、`search`（tag→FTS→refs 组合检索）、`formatResults`（格式化为 Zone4 注入文本）。 |
| `structured-tools.ts` | **结构化工具**。单一 `createStructuredTool`（kb_structured，action=add/update/delete/list）。 |
| 测试（1 个） | `fts5-retriever.test.ts`。 |

### 3.2 检索流程

**全文（Fts5Retriever.search）**：
1. 空查询→空。含中文 → `searchCjk`（取 `preprocessQuery` 的 variants 链，逐个 `matchQuery`，首个有结果即返回，实现从精确到宽泛的降级）；非中文 → 直接 `matchQuery`。
2. `matchQuery`：清洗 `"*()` 字符 → `bigramQuery`（中文转 bigram）→ FTS5 `MATCH` 按 rank 排序 LIMIT k → 按 title+source 去重 → 返回带高亮 snippet 的结果。

**组合检索（StructuredStore.search）**：
1. `matchByTags`：先算全库 tag 文档频率→IDF（平滑下限 0.5）；每条目对 query `includes(tag)` 做子串匹配，IDF 加权×10 累加，title 命中×3；score>0 进主结果。
2. 主结果 <2 条时用 `searchFts` 兜底补足。
3. `formatResults` 把主结果（前 maxMain）+ 关联条目（expandRefs 后取前 maxRefs）格式化为 Zone4 KB 注入文本。

### 3.3 依赖方向（knowledge）

- 依赖 `../tools/interface`（Tool）、`../tools/sqlite`（Database/类型）、`../logging/logger`、可选 `chokidar`、`node:sqlite`。
- 各层协作：`KnowledgeBase` → `Retriever`（Fts5Retriever）；`indexer`/`watcher` → `Retriever`；`tools` → `KnowledgeBase`；结构化层独立于 FTS 层（`structured-store`/`structured-tools` 自成一组）。
- 对外被消费：`KnowledgeBase`、`Fts5Retriever`、`StructuredStore` 供 gateway/factory 与 context Zone4（runtime:kb_context）服用；tools 注册为 LLM 工具；通过 `activeConditions` 与 context Composer 联动（zone4 开关）。

## 详细 模型接入层

> 范围：`src/provider/`、`src/local-model/`、`src/lifecycle/`、`src/generation/`
> 性质：纯结构文档（不含代码）。已逐一阅读全部源文件。
> 用途：描述各模块职责、关键类/接口/函数、依赖方向与数据流。

---

## 0. 总览：四模块关系

- **provider/** —— 在线/本地 LLM 供应商的统一抽象（对话推理层）。提供 `Provider` 统一接口、工厂注册表、自动路由、重试/熔断/降级链、模型能力目录。
- **local-model/** —— 本地模型（llama.cpp / Ollama / vLLM 等）的注册、进程托管、下载安装、热切换门面。
- **lifecycle/** —— 通用子进程生命周期管理（ProcessManager）与全局优雅关闭/信号处理（LifecycleSupervisor）。
- **generation/** —— 与 LLM 对话并列的"生成供应商"层（图片/视频/音频生成），与 provider 层完全解耦。

**依赖方向（单向）**：
- `local-model/` → 依赖 `lifecycle/manager.ts`(ProcessManager 托管进程) 与 `provider/local-config.ts`(Ollama 端点/进程参数)。
- `lifecycle/supervisor.ts` → 依赖 `local-model/index.ts`(LocalModelModule) 与 `tools/background-registry`、`agents/delegate-tool`。**2026-09-04 迁移**：本文件已迁至 `supervisor/shutdown.ts`（进程监督层三件套 guardian/protocol/shutdown），此处保留原文以存档依赖结构。
- `provider/` → 依赖 `local-model/llamacpp-provider.ts`（向外 re-export）。
- `generation/` → 独立；仅复用 `runtime/config-center`、`logging`、`media`（scene-render 归档），不依赖 provider/local-model/lifecycle。

---

## 1. src/provider/（29 文件，约 4500 行）

### 1.1 统一接口层

**`interface.ts`** —— 定义整个模型调用层的统一抽象。
- `ProviderCapabilities`：能力声明结构。字段：`toolCalling`、`streaming`、`adapterSupport`、`maxContextTokens`、`isLocal`、`vision`（多模态/图片输入）。
- `Provider`：所有适配器必须实现的接口。核心方法 `createStream(messages, tools, signal): AsyncIterable<StreamEvent>`（统一流式返回）。可选方法：
  - `getCapabilities()` 能力自描述。
  - `getProviderType()` / `getModel()` 元信息。
  - `loadAdapter?/unloadAdapter?/listAdapters?` LoRA 适配器动态管理（仅本地 Provider）。
  - `setThinking?(enabled, effort)` 运行时切换思考模式（DeepSeek high/max、Anthropic budget tokens）。
  - `setUserId?(userId)` 运行时切换 KVCache 隔离 ID。
- 注意：`Message`、`StreamEvent`、`ProviderType`、`ToolDefinition` 都来自 `../types.js`（模块内不定义）。

### 1.2 统一消息类型与模型目录单一真源

**`model-types.ts`** —— 独立文件（避免 provider/config.ts 与 loader 循环依赖）。
- `ModelCatalogEntry`：模型目录条目结构（id/name/provider/contextWindow/maxOutputTokens/capabilities/cost/status/replacedBy/reasoningEffort）。
- `ModelsCatalogConfig`。
- `MODEL_CATALOG: Record<provider, ModelCatalogEntry[]>`：内置模型目录单一事实源，按 14 在线厂商分组（anthropic/openai/deepseek/gemini/groq/xai/mistral/openrouter/moonshot/qwen/zhipu/minimax/mimo/volcengine）。厂商更新模型只需改这里。含 deprecated + `replacedBy` 迁移链、`reasoning`/`reasoningEffort` 推理字段、`cost` 定价。

**`provider-meta.ts`** —— 厂商元数据单一真源（P5-15 方案 C）。
- `ProviderFactoryMeta`：id/name/baseUrl/defaultModel/envKey/models(挂载 MODEL_CATALOG)。
- `PROVIDER_META`：14 个在线厂商（local 三态不在列，不进 DEFAULT_PROVIDERS）。
- 从 factory-registry 独立成文件的动机：避免 config→factory-registry→实现文件→config 的模块加载环（TDZ）。三处同源由守卫测试锁死。

### 1.3 能力/成本查询层

**`catalog.ts`** —— 运行时模型注册表。
- `ModelInfo` / `ModelCapabilities` / `ModelCost` 查询结构。
- `ModelCatalog` 类：`register/registerAll/lookup/getByProvider/getAvailable/getAll/getDefault/init/reload`。内部把「provider:id」作为 Map key。
- `modelCatalog` 全局单例 + 便捷函数 `getModelInfo(provider, modelId)`。
- 各适配器构造函数用 `getModelInfo().maxOutputTokens/contextWindow/vision` 决定能力与 token 上限。

**`model-catalog-loader.ts`** —— 模型目录加载器。
- `ModelCatalogLoader`：从 `~/.agent/providers.json` 读取 models（某 provider 显式声明则用声明，否则回退内置 MODEL_CATALOG，文件缺失整体回退内置）。
- 兼容旧键名 `maxTokens`→`maxOutputTokens`。`getModelCatalogLoader()` 单例。

### 1.4 各供应商适配器（文件 → 供应商映射）

| 文件 | 供应商/协议 | 复用基类/依赖 |
|---|---|---|
| `anthropic.ts` | Anthropic（原生 SDK）| `AnthropicProvider` 类；`createAnthropicProvider`。启示：providerType 可被 qwen/minimax/mimo 复用覆盖 |
| `openai.ts` | OpenAI（原生 SDK）| `OpenAIProvider`；`createOpenAIProvider`。支持 reasoning_content、user_id 缓存隔离、init 阶 user_id |
| `deepseek.ts` | DeepSeek | 薄封装 → `OpenAICompatibleProvider`；`createDeepSeekProvider/createDeepSeekFromConfig` |
| `compatible.ts` | Groq / xAI(Grok) / Mistral / OpenRouter / Moonshot(Kimi) | `OpenAICompatibleProvider` 单类覆盖全部（用工厂设置各默认值 + OpenRouter 额外 HTTP 头） |
| `gemini.ts` | Google Gemini | `GeminiProvider` 类（@google/genai SDK）；`createGeminiProvider` |
| `qwen.ts` | 阿里百炼（Anthropic 兼容端点）| 复用 `AnthropicProvider(providerType:'qwen')`；`createQwenProvider/createQwenFromConfig` |
| `zhipu.ts` | 智谱 GLM（OpenAI 兼容）| 复用 `OpenAICompatibleProvider`；`createZhipuProvider/createZhipuFromConfig` |
| `minimax.ts` | MiniMax（Anthropic 兼容端点）| 复用 `AnthropicProvider(providerType:'minimax')` |
| `mimo.ts` | 小米 MiMo（Anthropic 兼容）| 复用 `AnthropicProvider(providerType:'mimo')` |
| `local.ts` | 本地推理（按 baseUrl 端口推断后端）| `LocalProvider` 类（OpenAI SDK，baseURL 本地）。端口含 `:11434`→ollama，否则 llamacpp。提供 `setModel/setBaseUrl` |
| `local-config.ts` | 本地后端配置 + 自动检测 | 见下方 1.8 |
| `llamacpp-provider.ts`（在 local-model/）| llama.cpp 专用 | `LlamaCppProvider`，provider/index re-export |

**适配器共同点**：都实现 `Provider.createStream`，把内部 `Message[]` + `ToolDefinition[]` 转成各家格式，并把流式 chunk 归一为 `StreamEvent`（TEXT/THINKING/TOOL_USE/USAGE/STOP）。tool_use 参数累积后统一走 `recoverToolArguments` 做容错。消息文本统一过 `sanitizeText`。

### 1.5 能力声明机制

- 静态声明：`MODEL_CATALOG` 每条目的 `capabilities`（streaming/toolCalling/thinking/vision/inputTypes）。
- 运行态查询：每个适配器 `getCapabilities()` 通过 `getModelInfo(provider, model)` 查本地目录，回填 `ProviderCapabilities`。
- 生效点：
  - `router.ts` 靠 `isLocal` 做自动路由。
  - 各适配器在消息转换时靠 `vision` 决定图片 block 是原文发送还是降级为文本占位符。
  - 适配器构造函数计算 `maxTokens`：临时覆盖 → 模型目录 `maxOutputTokens` → 兜底 8192。

### 1.6 工厂注册表（单一事实源，P5-15 方案 C）

**`factory-registry.ts`** —— 收敛原 15 个 switch / 13 个 env if / 13 个可用性 if。
- `PROVIDER_TYPES`：16 值键列表（anthropic…mimo + local/ollama/llamacpp）。`ProviderType` 由此派生。
- `ProviderFactory`：`{ local?, create(config), createFromEnv?, checkAvailability?, envKeys?, meta? }`。
- `PROVIDER_FACTORIES: Record<ProviderType, ProviderFactory>`：**键序即优先级**（anthropic 优先、local 兜底、ollama/llamacpp 不进 DEFAULT_PROVIDERS）。
- 运行时扩展：`registerProviderFactory` / `getProviderFactory` / `listProviderFactories`（扩展优先、内置键序殿后）。注册支持 `dispose` 卸载回滚。
- local 兜底 `detectLocalFromConfig()`：读 local-config，有 defaultModel 则建 `LocalProvider`。
- llamacpp 工厂 `create` 直接抛错（仅后端不可直接创建）。

### 1.7 配置加载

**`config.ts`** —— Provider 配置加载器。
- `DEFAULT_PROVIDERS`：直接 spread `PROVIDER_META`（同一对象引用，守卫测试 toBe 锁死）。
- `ProviderConfigLoader`：读写 `~/.agent/providers.json`（缺失则写默认）。`getProvider(id)/getAll/reload`。`getProviderConfigLoader()` 单例（需先注入 cwd）。

**`local-config.ts`** —— 本地后端配置单一出口。
- `LocalProviderConfig`：baseUrl/port/defaultModel/maxOutputTokens/backend。
- 自动检测：
  - `detectLocalBackend()`：先探 Ollama（`/api/tags`），再探 llama.cpp（`/health`，默认端口 8080），返回 backend/baseUrl/port。
  - `fetchOllamaModels()` + `pickBestOllamaModel()`（精确→前缀→反向前缀→首元素）。
  - `detectBackendBinary('ollama')`：PATH 或 `libs/ollama/`。
  - `getOllamaEndpoints()`：由 port/baseUrl 派生 apiBase/v1Base/healthUrl。
  - `getLocalProcessConfig()`：Ollama 进程健康检查参数（restartDelay/interval/timeout/maxRetries/startupTimeout），可被 `provider.local.healthCheck.*` 覆盖。
- 配置优先级：RuntimeConfigCenter 注入（`provider.local.*` > `local.*`）→ 硬编码默认值。旧键名 maxTokens 兼容。

### 1.8 弹性层（重试 / 熔断 / 降级）

**`retry.ts`** —— 重试工具。
- `RetryConfig`(`maxRetries=4/baseDelayMs=1000/maxDelayMs=30000`)。
- `isRetryableError` / `isNonRetryableError`（网络、5xx/429、overloaded/rate limit 等；401/403/404/auth 非重试）。
- `withRetry(fn, config, name)` 通用指数退避封装。

**`resilient.ts`** —— `ResilientProvider`（装饰任意 Provider 加重试+熔断）。
- 指数退避 1s→2s→4s→8s；已 yield 过任何事件后失败不再重试（防重复文本）。
- 熔断三态 closed→open→half-open；`DEFAULT_CB`（failureThreshold=5, cooldownMs=30s）。
- 实现 `Provider` 接口且透传 getProviderType/getModel/getCapabilities/setThinking/setUserId。

**`fallback.ts`** —— `FallbackProviderChain`。
- 一组 Provider 顺序尝试；每个成员各自包 `ResilientProvider`（独立重试+熔断）。
- 降级时剥掉 Anthropic `cache_control` 标记（对不支持 manual-markers 的厂商非法）。
- `onFallback`/`onRecover` 回调用于外部适配 maxContext/cache 策略；`hasFallenBack` 标志保证「降级尝试过但失败」也能正确触发恢复。

**`manager.ts`** —— `ProviderManager`（装配中心）。
- 优先级：显式配置 > 环境变量自动检测（`detectFromEnv` 遍历注册表键序）。
- `wrapProvider(primary)`：有显式 fallback 就用 FallbackProviderChain；否则自动收集可用厂商（排除主 provider）；单 Provider 时只包 ResilientProvider。
- `buildFallbackProviders`：本地三态读 local-config；在线读 providers.json 的 envKey/defaultModel。
- `switchProvider`（运行时切换保留弹性层）、`getProvider`、`setOnFallback`。
- 静态：`createProviderFromConfig`（注册表驱动）、`detectFromEnv`、`getAvailableProviders`（envKeys/checkAvailability）、`createFromConfigFile`（ConfigManager 加载 .env + 三层配置合并 + userId 提取）。

### 1.9 路由层（两套路由）

**`router.ts`** —— `ProviderRouter`（按复杂度自动路由）。
- `AssessmentInput`(complexity low/medium/high)、`RoutingInfo`。
- register/unregister/get/list；`setDefault`/`clearDefault` 手动覆盖。
- `route(assessment)`：手动覆盖 > high→在线 > 其他→本地 > 首个 > 空抛错。
- `isLocalProvider`：优先 getCapabilities().isLocal，回退按 providerType（llamacpp/local/ollama）。

**`model-router.ts`** —— `ModelRouter`（按角色路由到通道）。
- 角色：`ModelRole`（assessment/planning/compression 等）、`ModelsConfig`、`LocalModelConfig`。
- 内部委托 `ModelChannelRegistry`；`getProvider(role)` 未命中 fallback 到 mainProvider。
- `setRegistry/setConfig/reloadChannels/setMainProvider/getChannelProvider` 热切换入口。

### 1.10 通道注册表

**`model-channel-registry.ts`** —— `ModelChannelRegistry`（N 通道模型路由配置中心）。
- 文件：项目级 `.agent/model-channels.json`，回退全局 `~/.agent/model-channels.json`；`ChannelConfig`(provider/model/apiKey/apiKeyEnv/baseUrl/description)。
- 硬编码 `DEFAULT_ROLES`：assessment/planning/compression/sub-agent → main。
- 降级链：role → channelName → channelProvider → mainProvider（`getProvider`）。
- `fromLegacy` 向后兼容构建；`load/reload/reloadFromConfig/mergeDefaults`。
- 通道 CRUD：`upsertChannel/removeChannel/setRoleMapping/setMainProvider/setChannelProvider/setChannelModel/resetChannelModel`；main 通道不可删。
- 非 main 通道自动包 `ResilientProvider`，读取失败自动回退 main（`wrapWithFallback` 包装器）。`save()` 持久化回文件。

### 1.11 辅助工具（provider/）

- **`sanitize.ts`**：`sanitizeText` 替换 `<|...|>` 特殊 token（防 prompt injection）；`sanitizeStrings` 递归清洗对象。
- **`user-id.ts`**：DeepSeek KVCache 隔离 ID 统一管理。`DEFAULT_USER_ID='hyacinth'`，`setUserIdPrefix` 覆盖；为 6 个调用点生成 ID（mainUserId/companionUserId/orchestratorUserId/narrationUserId/compressorUserId/subAgentUserId）。
- **`tool-args-recovery.ts`**：`recoverToolArguments` 对损坏 JSON 的 best-effort 正则提取（file_path/content/path/pattern/command）；`logToolArgsWarning`。
- **`index.ts`**：模块统一出口（re-export 全部类型/类/工厂）。
- 测试文件：`factory-registry.test.ts`、`resilient.test.ts`、`local.test.ts`、`local-config.test.ts`、`model-catalog-loader.test.ts`。

### 1.12 模块外依赖方向
`provider/` → `../types.js`（Message/StreamEvent/ProviderType/ToolDefinition）、`../logging/logger.js`、`../setup/config.js`(ConfigManager)、`../runtime/config-center.js`(local-config)、`../local-model/llamacpp-provider.js`(re-export)。外部不反向依赖 provider（除 local-model 复用 local-config）。

---

## 2. src/local-model/（6 文件，约 1800 行）

### 2.1 结构一览

| 文件 | 职责 |
|---|---|
| `types.ts` | 全部本地模型数据类型单一出口（ModelEntry/ModelRegisterOptions/RunningModelInfo/LlamaCppOptions/LoadedModelInfo/ModelBackend） |
| `model-registry.ts` | 模型注册表（.agent/models.json + models/ 目录扫描 + 热插拔监听） |
| `model-bridge.ts` | 桥接层（ModelRegistry ↔ ProcessManager 进程托管，按端口推断后端） |
| `index.ts` | `LocalModelModule` 门面类（对外统一 API，delegate 到 registry+bridge） |
| `llamacpp-provider.ts` | llama.cpp 专用 Provider（原生 fetch+SSE，健康检查，LoRA Adapter 管理） |
| `download-manager.ts` | llama.cpp 预编译包下载/安装（GitHub API + 零依赖 ZIP 解析） |

### 2.2 类型定义（`types.ts`）
- `ModelBackend = 'llama.cpp' | 'ollama' | 'vllm' | 'lm-studio' | 'custom'`。
- `ModelEntry`：name/modelFile/modelPath/backend/port/host/ctxSize/nGpuLayers/extraArgs/addedAt/enabled。
- `RunningModelInfo`：运行中模型对外信息（含 state/pid/baseUrl）。
- `LoadModelInfo`：CLI/TUI 配置 LocalProvider 用的最终契约（modelName 去 .gguf 扩展名 / baseUrl）。
- `ProcessState` 从 `../lifecycle/interface.js` 引入（跨模块契约）。

### 2.3 模型注册表（`model-registry.ts`）
- `ModelRegistry extends EventEmitter`（单例 `getInstance(projectRoot)`）。
- 持久化：`~/.agent/models.json` 同级 `.agent/models.json`；`scripts dir` 为项目 `models/`。
- `init()` = load + scanAndMerge + startWatcher。
- `scanDirectory` 扫 `.gguf/.GGUF`；`scanAndMerge` 自动发现未注册文件并注册（backend 默认 llama.cpp）。
- `startWatcher`：`fs.watch(models/)` 热插拔（延迟 500ms 扫描）。
- CRUD：`register`（llama.cpp 校验 GGUF 存在，Ollama 用 modelPath=modelFile）、`unregister`、`find/findByPort/list/count`；事件 `changed/added/removed`。

### 2.4 桥接层（`model-bridge.ts`）
- `ModelBridge extends EventEmitter`：维护 `Map<name, ProcessManager>`、活跃模型、端口映射。
- `buildConfig(model)` → `ManagedProcessConfig`：按 backend 分支
  - `ollama`：`<path> serve`，健康检查 `/api/tags`。
  - `vllm`：`vllm serve --model ... -ngl`，健康 `/v1/models`。
  - `custom`：命令 = modelPath + extraArgs。
  - `lm-studio`：返回 null（需手动启动，跳过）。
  - 默认 llama.cpp：`llama-server -m <path> --host --port [-c ctxSize] [-ngl layers]`，健康 `/health`。
- 端口分配：`findAvailablePort`（ollama 用 getOllamaEndpoints().port，llama.cpp 从 8080，避开已用端口）。
- `start/stop/switch/startAll/stopAll/getStatus/register/stop`；事件 `model-starting/model-running/model-stopped/model-error/active-changed/all-stopped`。
- 进程启动回调：running→置活跃；stopped/failed/crashed→清活跃 + 发 error。

### 2.5 门面类（`index.ts`）
- `LocalModelModule.getInstance()` 单例，聚合 registry+bridge。
- API：`initialize(projectRoot)`（resolve llama-server 路径）、`start/startAll/stop/switch`、`list/getActive/getModelName`、`configure`、`registerModel/unregisterModel`、`checkLlamacpp/checkOllama/listOllamaModels`、`scanUnregistered`、`status/getRegistry/getBridge/isInitialized`。
- `resolveLlamaServerPath`：按优先级找 `libs/llama.cpp/build/bin/.../llama-server(.exe)` 或 PATH。

### 2.6 llama.cpp Provider（`llamacpp-provider.ts`）
- `LlamaCppProvider`：原生 `fetch` + SSE 解析 OpenAI /v1/chat/completions（不依赖 openai npm）。
- `checkHealth()`（/health）、`loadAdapter/unloadAdapter/listAdapters`（/v1/lora LoRA）。
- 请求用 `withRetry` 包裹；最终 error 带友好 "Make sure llama-server is running"。
- 处理 reasoning_content → THINKING、cache_control ephemeral 透传。
- `index.ts` 经 provider 模块 re-export。

### 2.7 下载管理（`download-manager.ts`）
- `DownloadManager`：`check/isInstalled` + `download(projectRoot, onProgress)`。
- 从 GitHub API `ggerganov/llama.cpp releases/latest`，筛选 `*win-x64-cuda*.zip`，下载（进度回调）→ 零依赖内联 ZIP 解析/解压（`inflateRawSync` + EOCD/中央目录解析）→ 落 `libs/llama.cpp/` → 写 `.version`。
- 错误信息带手动安装指引。

### 2.8 模块外依赖方向
`local-model/` → `../lifecycle/interface.js`(ProcessState/ManagedProcessConfig/ProcessEventCallbacks)、`../lifecycle/manager.js`(ProcessManager)、`../provider/local-config.js`(Ollama 端点/进程参数)、`../provider/interface.js`(Provider/ProviderCapabilities)、`../provider/retry.js`(withRetry)、`../types.js`。

---

## 3. src/lifecycle/（4 文件，约 800 行）

### 3.1 结构一览

| 文件 | 职责 |
|---|---|
| `interface.ts` | 进程生命周期契约（状态/配置/状态快照/回调/本地模型配置） |
| `manager.ts` | `ProcessManager` 通用子进程托管（启动/停止/健康检查/崩溃恢复/进程树清理） |
| `supervisor.ts` | `LifecycleSupervisor` 中心注册表 + 全局优雅关闭 + 信号处理（**已迁至 `supervisor/shutdown.ts`**，lifecycle/index 不再导出） |
| `index.ts` | 模块统一出口（re-export ProcessManager/ModelRegistry/ModelBridge/LocalModelModule/LifecycleSupervisor） |

### 3.2 契约（`interface.ts`）
- `ProcessState`：stopped/starting/running/stopping/failed/crashed。
- `HealthCheckConfig`：url 或 host+port，intervalMs/timeoutMs/maxRetries。
- `ManagedProcessConfig`：name/command/args/env/cwd/healthCheck/autoRestart/maxRestarts/restartDelayMs/stopSignal/stopTimeoutMs/startupTimeoutMs。
- `ProcessStatus`：name/state/pid/uptime/restartCount/lastExitCode/lastError/startedAt。
- `local ModelConfig`：backend/modelPath/port/nGpuLayers/ctxSize/extraArgs/modelName/ollamaModel + 进程/健康参数覆盖。
- `ProcessEventCallbacks`：onStateChange/onCrash/onHealthFail/onHealthRecover。

### 3.3 子进程托管（`manager.ts`）
- `ProcessManager`：`start/stop/restart/destroy/forceKill/getState/getStatus/getProcess/setCallbacks`。
- `start()` = spawn + waitForStartup（含健康检查轮询，超时 → failed 并可能 autoRestart）。
- `stop()`：优雅信号（默认 SIGTERM）→ 等待退出 → 超时强杀进程树（Windows `taskkill /F /T /PID`，Unix `kill -SIGKILL -pid`）。
- 崩溃恢复：`handleCrash` 检查 autoRestart+maxRestarts，延迟重启；`manualStop` 标志抑制。
- 周期健康检查：失败累计超 maxRetries → onHealthFail + 触发崩溃处理。
- `forceKillAll`：exit handler 中同步清理子进程（不依赖异步）。

### 3.4 全局优雅关闭（`supervisor.ts`）
- `LifecycleSupervisor`：`loadAndStartModels/startModel/startModelOnDemand/stopModel/startOllamaOnDemand`、`registerMCPServer/register/registerBackgroundRegistry`、`getAllStatus/getStatus/getByType`。
- 本地模型门面持有 `LocalModelModule`；`runningModels` 记录 LoadedModelInfo（供 CLI 配置 LocalProvider）。
- `startOllamaOnDemand`：检测 ollama 二进制/端点，自动拉起 `ollama serve`（配置驱动健康检查参数），复用 detectLocalBackend 二次确认。
- `shutdownAll()`：关闭顺序 backgroundRegistry → 等待异步子 Agent 任务（≤5s）→ 并行停所有受管实体。
- `installSignalHandlers()`：SIGINT/SIGTERM → 异步优雅关闭（10s 兜底强制 exit）；beforeExit → 异步关闭；exit → 同步 forceKillAll（三层防线）。返回解除函数。

### 3.5 模块外依赖方向
`lifecycle/` → `../logging/logger.js`、`../local-model/index.js`、`../local-model/types.js`、`../provider/local-config.js`(动态 import)、`../tools/background-registry.js`、`../agents/delegate-tool.js`(waitForAsyncTasks)。
`local-model/` 反向依赖 `lifecycle/`（ProcessManager/interface），所以在 provider/index 处由生命周期对外暴露本地模型管理。

---

## 4. src/generation/（12 文件，约 2100 行）

### 4.1 结论先行：生成的是什么？
不是「LLM 生成」，而是**媒体生成供应商层**（图片/视频/音频），与 LLM 对话 Provider 并列但完全独立（不共享 Provider 接口）。产出统一为 `resultUrl` → service 层下载转存到本地。

### 4.2 结构一览

| 文件 | 职责 |
|---|---|
| `interface.ts` | 生成抽象完整契约（模态/任务类型/请求/任务/状态/能力/Provider/配置/AdapterMeta） |
| `adapters/volcengine.ts` | 火山方舟适配器（Seedream 图片 + Seedance 视频，同步+异步） |
| `adapters/minimax.ts` | MiniMax 适配器（图片/视频/音频三模态，含音频 file retrieve） |
| `adapters/openai-compatible.ts` | OpenAI 兼容 TTS（本地 openedai-speech/Kokoro/GPT-SoVITS + 云端） |
| `adapters/index.ts` | 适配器聚合文件（BUILTIN_ADAPTERS，全自动注册） |
| `registry.ts` | `GenerationRegistry`（供应商实例创建/路由/默认选择） |
| `service.ts` | `GenerationService` 门面（提交+轮询+下载转存） |
| `config.ts` | `.agent/generation.json` 加载（项目级 > 全局 > 空） |
| `generation-config.ts` | 轮询/音色/格式默认值（configCenter 注入） |
| `vendor.ts` | vendor 引用机制 + auto-materialize（生成侧从 LLM providers.json 继承 baseUrl/apiKeyEnv；LLM 厂商声明 capabilities → 生成侧零配置物化条目 + 声明即用默认路由） |
| `scene-render.ts` | 陪伴模式场景渲染窄工具（scene_render，签名去重防烧 API） |
| `index.ts` | 模块统一出口 |

### 4.3 统一契约（`interface.ts`）
- `GenerationModality = 'image'|'video'|'audio'`；`GenerationTaskType = text_to_image/image_to_image/text_to_video/image_to_video/reference_to_video/audio_tts`。
- `MediaInput`（url/base64/asset_id + role 首尾帧/参考）。
- `GenerationRequest`：provider/model/taskType/prompt/negativePrompt/各参考媒体/视频参数/音频参数/control+extraParams(透传)/signal。
- `GenerationStatus`：queuing/processing/success/failed/canceled/expired（9 家状态码收敛）。
- `GenerationTask` + `initialStatus`（同步接口直接 `status=success`，service 跳过轮询）。
- `GenerationStatusResult`：进度/resultUrl/尺寸/时长/thumb/errorCode/errorMessage/raw。
- `GeneratedArtifact`：service 转存后的本地 file（localPath/sourceUrl/mediaType/byteSize/尺寸/provider/model/createdAt）。
- `GenerationCapabilities`：模态/任务类型/分辨率/时长/宽高比/负向/参考媒体/首尾帧/异步/输出格式/maxCount。
- `GenerationProvider` 接口：`providerType/submitTask/getTaskStatus/cancelTask?/getCapabilities`。注释明确"不负责轮询/下载/落盘（那是 service 层的职责），适配器只做请求映射+状态映射，尽量薄"。
- `GenerationProviderConfig`：type/vendor(继承)/model/models(按 taskType)/apiKey/apiKeyEnv/baseUrl/voice/responseFormat/description。
- `AdapterMeta`：适配器自描述（type + create 工厂），供 adapters/index 聚合。新增厂商 = 新文件 + index 加一行。

### 4.4 各适配器要点

**`volcengine.ts`** —— `VolcengineProvider`（providerType='volcengine'）。
- 图片 `/images/generations`（同步，Seedream，`--neg:` 拼接负向；base64 不带 data: 前缀）。
- 视频 `/contents/generations/tasks`（异步，Seedance 轮询）。`mapStatus` + `mapErrorCode` 统一状态/错误。
- 图片通过 initialStatus 同步返回（service 跳过轮询）；视频返回 taskId 进入轮询。
- size 规范化（像素串/2k/3k/4k）；URL 24h 有效 → service 立即下载。
- 导出 `createVolcengineProvider` + `meta`。

**`minimax.ts`** —— `MiniMaxProvider`（providerType='minimax'）。
- 图片 `/v1/image_generation`（同步，subject_reference 人物参考）；视频 `/v2/video_generation`+查询（异步）；音频 `/v1/t2a_async_v2`+查询+`/v1/files/retrieve` 两步取 download_url。
- baseUrl 归一化：剥掉 vendor 继承的 `/anthropic` 后缀。
- `cancelTask` 返回 false（无官方取消接口）。

**`openai-compatible.ts`** —— `OpenAICompatibleProvider`（providerType = 配置名，如 local-tts）。
- 仅 `audio_tts`；`/v1/audio/speech`，响应体即音频 → 转 data URL 填 initialStatus（完全同步，零轮询）。
- `baseUrl` 必填（无云端默认，避免误打 OpenAI）；不配 apiKey 也允许（本地服务）。
- `sniffAudioMime` 按魔数嗅探 WAV/OGG/FLAC/MP3（本地服务器可能忽略 response_format）。

### 4.5 注册表与门面

**`adapters/index.ts`** —— `BUILTIN_ADAPTERS: AdapterMeta[]` = [volcengine, minimax, openai-compatible]；注释给出加 kling/wanxiang 的扩展位。

**`registry.ts`** —— `GenerationRegistry`。
- `adapters: Map<type, factory>`（内置自动注册 + `registerAdapter` 插件扩展）+ `instances` 懒加载缓存。
- `static load(cwd)`：loadGenerationConfig + resolveVendorInheritance。
- `getProvider(name)` / `getDefaultProviderName(taskType)` / `getDefaultProvider(taskType)` / `listProviders` / `hasTaskType`。

**`service.ts`** —— `GenerationService`。
- `generate(req, opts)`：getProvider → submitTask → （initialStatus.success 直接 finalize / failed 抛错）→ pollUntilDone → finalize。
- 轮询参数按模态差异化：视频 15s、图片 3s（configCenter 提供），maxAttempts 600。
- `finalize`：下载 resultUrl 转存 outputs（全局 `~/.agent/generation/`），扩展名/媒体类型推断；`opts.download=false` 时只返回 URL 引用。
- 支持 `req.signal` 中断。

### 4.6 配置与继承

**`config.ts`** —— `.agent/generation.json` 加载：项目级整体优先，否则全局，否则空。`loadGenerationConfig` 返回 source 标识。`getGlobalGenerationOutputDir()` = `~/.agent/generation`。

**`generation-config.ts`** —— 轮询/默认值走 configCenter（`generation.*` 键注入）：pollIntervalMs(3000)/videoPollIntervalMs(15000)/maxPollAttempts(600)/minimaxDefaultVoiceId/minimaxAudioFormat。未注入回退硬编码。

**`vendor.ts`** —— vendor 引用机制 + auto-materialize（声明即用）：① 生成侧厂商声明 `vendor` 指向 LLM providers.json（`~/.agent/providers.json`）同名厂商，自动继承 baseUrl/apiKeyEnv（只补缺失字段，显式优先）；② LLM 厂商声明 `capabilities`（tts/image/video）后生成侧零配置物化条目，某任务类型唯一能力供应商时自动写 `defaults` 默认路由；embedding/rerank 走独立接口；未注册适配器/无 adapter 的 video 跳过并 warning。`resolveVendorInheritance` 纯函数 + `getLlmProvidersPath`。

### 4.7 场景渲染窄工具（`scene-render.ts`）
- `SCENE_RENDER_TOOL`：LLM 可见工具定义（只接受 scene_desc 一句画面描述）。
- `executeSceneRender`：安全校验角色名 → 签名去重（sha256 前 16，未变跳过不烧 API）→ 懒加载 generation 模块 → 默认 text_to_image 供应商生成 → 转存固定 `scene.png` + 写 `scene.json` 元数据 → `recordMediaFile` 归档媒体库。
- 设计的 bypass 安全红线：只写 `~/.agent/companion/<角色>/`，LLM 只能传描述、不接触通用生成能力。
- `getSceneDir(characterName)`。

### 4.8 模块外依赖方向
`generation/` → `../logging/logger.js`、`../runtime/config-center.js`、`../media/index.js`(recordMediaFile)、`../types.js`(ToolDefinition)。自带完整内部结构，不依赖 provider/local-model/lifecycle。与对话侧 Provider 平行但「接口不共享」（对话走重 Provider.createStream，生成走轻 GenerationProvider.submitTask）。

---

## 5. 跨模块协作小结（数据流）

1. **工厂装配**：`ProviderManager`/`factory-registry` → `ProviderConfigLoader`→`providers.json≡PROVIDER_META≡MODEL_CATALOG`（单一真源）→ 创建实现 `Provider` 的适配器。
2. **能力查询**：适配器 `getCapabilities()` → `ModelCatalog(lookup)` → `ModelCatalogLoader`(读 providers.json 或内置 MODEL_CATALOG)。
3. **弹性**：ProviderManager 用 `ResilientProvider`+`FallbackProviderChain` 包裹；模型/降级切换通过 `onFallback/onRecover` 回调适配上下文窗口。
4. **路由**：`ModelRouter` → `ModelChannelRegistry`（role→channel→provider→mainProvider 降级）。
5. **本地模型**：`LocalModelModule`(index) → `ModelBridge` → `ProcessManager`(lifecycle) 托管 llama.cpp/Ollama/vLLM 进程 → 起好后返回 baseUrl/modelName 供 `LocalProvider`/`LlamaCppProvider` 消费。
6. **生命周期**：`LifecycleSupervisor.loadAndStartModels` 调用 `LocalModelModule.startAll`，把各 ProcessManager 注册为 entity，统一在 shutdown 优雅关闭。
7. **媒体生成**：`GenerationService.generate` → `GenerationRegistry.getProvider` → 各适配器 submitTask/getTaskStatus → 统一轮询/下载转存，独立于对话 LLM 层。scene-render 作为工具消费 generation 图片能力。

## 6. 与项目架构哲学的对应

- 单一职责：provider 只做 LLM 统一抽象；generation 独立做媒体；lifecycle 只做进程托管。
- 零侵入集成：适配器通过 `factory-registry`(registerProviderFactory) / `BUILTIN_ADAPTERS`(adapters/index) 注册，非硬编码。
- 外部配置化：providers.json/model-channels.json/generation.json/configCenter 键均外部可配；轮询/熔断/降级链参数可配。
- 数据/配置/代码三分离：MODEL_CATALOG(数据) / providers.json·generation.json·channels(配置) / .ts 逻辑(代码)。
- 跨项目可移植/可独立测试：各模块有独立测试（factory-registry/resilient/local-config/model-catalog-loader/lifecycle.manager/generation 各 adapter tests）。

## 详细 工具与扩展体系

> 模块范围：`src/tools/`、`src/registry/`、`src/plugins/`、`src/skills/`、`src/mcp/`
> 本文档为纯结构描述（不含代码），说明各关键文件的职责、关键类型/函数、关系、数据流与对外依赖方向。

---

## 0. 模块全景与职责边界

| 模块 | 目录 | 职责一句话 |
| ---- | ---- | ---- |
| 工具层 | `src/tools/` | 定义统一的 `Tool` 接口、调度执行器、注册表、安全/权限、结果缓冲与全部具体工具（系统最大模块） |
| 注册表体系 | `src/registry/` | 供应泛型注册表基类 `GenericRegistry<T>` 及其专用子类（Tool / Skill / Agent） |
| 插件系统 | `src/plugins/` | 插件发现、清单、加载、生命周期（委托内核 PluginHost）、暴露 `PluginApi` 能力面 |
| Skill 系统 | `src/skills/` | Skill 定义加载、注册表访问、`use_skill` 工具（把提示词模板渲染并注入对话） |
| MCP 集成 | `src/mcp/` | MCP 配置加载、客户端/传输、服务器生命周期管理、工具桥接到 ToolRegistry |

依赖方向总览：
- `tools` → registry（复用注册表）、runtime/config-center（工具配置）、logging。
- `registry` 不依赖 plugins/mcp；tool.registry 依赖 tools/runtime-control 与 tools/config 的工厂函数。
- `plugins` → registry（注入 ToolRegistry/SkillRegistry）、kernel/plugin-host（生命周期委托）、context、mcp/system（插件 MCP 委托）、channels。
- `mcp` → tools（bridge 把工具注册进 ToolRegistry）、context（ContextSource）、lifecycle（进程管理与监督）。
- `skills` 主要复用 registry/skill.registry 与 types、prompts/loader；skill-tool 实现 tools 的 Tool 接口。

---

## 1. src/tools/（最大模块，64 文件 / 约 10400 行）

### 1.1 核心契约层

**`interface.ts` — `Tool` 接口（全系统工具的唯一契约）**
- 字段：`name`（全局唯一）、`description`（供 LLM 理解）、`companionDescription?`（陪伴模式下的拟人化替代描述）、`companionOnly?`（true 时普通模式工具列表完全不含，硬隔离）、`inputSchema`（JSON Schema）、`execute(args, signal?)`（返回 Promise<string>，signal 用于中断）、`executionMode?`（'sync' 默认 / 'asyncable'）、`setBackgroundRegistry?`（仅 asyncable 工具需要，注入后台进程注册表）。
- 设计要点：任何实现这 5-6 个字段的对象都是工具，天然可插拔且跨项目可移植（呼应项目模块化哲学第五条）。

**`executor.ts` — `ToolExecutor` 调度执行器**
- 依赖 ToolRegistry 与 `tools.executor.timeoutMs`（默认 300000ms）。
- `execute(toolCall)`：查表（未找到返回 `Unknown tool` 错误结果）→ 用 `AbortController` + 定时器实现真实中断（非 Promise.race）→ 调用 `tool.execute(input, signal)` → 组装 `ToolResult`（含 `tool_use_id` / `content` / `is_error`）。abort 后即使工具"配合地"正常返回也按超时处理。
- `executeParallel(toolCalls)`：批量 Promise.all 并行执行。

**`index.ts` — 注册入口与内置工具聚合**
- 明确规定工具注册流程（禁止业务代码硬编码 new Tool）：
  - 内置工具 → `createDefaultRegistry()` / `createBuiltInTools()`；
  - 运行时工具 → `registerRuntimeControlTools()`；
  - 热插拔 → 运行时 `registry.register(...)` 或 `createPluginTool()`。
- `createDefaultRegistry(cwd?, sandboxConfig?, sessionId?, channel?)`：注册 Read/Write/Edit/Bash/Glob/Grep/MultiEdit/Insert/Restart/DiffFiles/JsonEdit/HttpRequest/Archive/DbQuery/DiskUsage/GenerateMedia（16 个内置，不含 Git）。
- `createBuiltInTools(gitManager, ...)`：在其上追加 `GitTool`（依赖 Evolution 模块的 GitManager）。
- type `SandboxConfig` 复用到 bash 的沙箱类型。

---

### 1.2 内置工具层（src/tools/ 顶层各 *Tool 文件）

文件级工具清单（除下方列表外，registerBundle 的 7 个 bundle 工具 + runtime-control 分类见 §1.5）：

| 文件 | 工具名 | 职责 |
| ---- | ---- | ---- |
| read.ts | `read` | 流式/分页读文件；二进制与图片签名嗅探（png/jpg/gif/webp/bmp → 注入 ImageStore）；`read-before-write` 门控（调用 file-tracker） |
| write.ts | `write` | 创建/覆盖文件，自动建父目录；写前门控（file-tracker）、写后 `runDiagnostics` 类型检查、`autoReferenceCheck` 符号引用告警、diff 推送 |
| edit.ts | `edit` | 字符串精确替换（需唯一匹配）或按行号替换；同样走 write 的联动 |
| multi-edit.ts | `multi_edit` | 跨多文件 glob 搜索替换，支持 dry_run 预览 |
| insert.ts | `insert` | 指定行号插入（0/'end'=追加） |
| bash.ts | `bash` | 任意命令执行 + 沙箱（危险命令黑名单/词边界正则）+ 超时与输出截断 + async 后台进程启动 |
| glob.ts | `glob` | glob 模式匹配文件列表，按修改时间排序，限条数 |
| grep.ts | `grep` | ripgrep 正则搜索，支持 glob 过滤/上下文/多行/三种输出模式（content/files_with_matches/count） |
| git-tool.ts | `git` | Git 四个子命令：commit/revert/branch/diff（依赖 evolution/git-manager） |
| restart.ts | `restart` | 写入重启标记（.agent/.restart-*），进程重启后恢复会话 |
| diff-files.ts | `diff_files` | 两个文件的行级 unified diff |
| json-edit.ts | `json_edit` | 点路径读写 JSON/YAML/TOML，保留原格式 |
| http-request.ts | `http_request` | HTTP 客户端（GET/POST/PUT/DELETE 等），爬虫/API 调试，超时与截断 |
| archive.ts | `archive` | zip/tar.gz/tar.bz2 解压与压缩（用系统 tar） |
| db-query.ts | `db_query` | SQLite 参数化查询（node:sqlite 封装），杜绝注入 |
| disk-usage.ts | `disk_usage` | 磁盘剩余/目录/文件大小分析（Windows PowerShell / Unix du·df） |
| generate-media.ts | `generate_media` | 统一多模态生成（image/video/audio），懒加载 generation 模块，结果落盘 + 归档媒体库 |
| system-info.ts | `system_info` | 系统环境信息（OS/CPU/内存/GPU/Python），缓存注入 |
| channel-info.ts | `channel_info` | 已连接外部渠道信息（TUI 等注入缓存） |
| ask-user.ts | `ask_user` | 交互式多问题表单（依赖注入的 AskUserFn） |
| flow.ts | `flow_start/flow_add/flow_complete` | 通用流程控制（todo/plan/spec 模式状态机），不记入对话历史 |
| compression.ts | `trigger_compression` | 手动触发上下文压缩（normal/deep），deep 时临时替换 summary 模板 |
| companion-say.ts | `companion_say` | 陪伴模式"开口"通道，sayId 关联文字/TTS |
| process-tools.ts | `process_list/process_kill/process_output` | 管理 bash(async:true) 启动的后台进程（走 BackgroundRegistry） |
| config.ts | `get_config/update_config/config_schema/reset_config` | 运行时配置读改（deep merge、点路径展开） |

内聚辅助文件：
- `file-tracker.ts`：全局读/写时间表，支撑 read-before-write 门控（防幻觉编辑 / 过期数据）。
- `diagnostics.ts`：write/edit 后自动运行类型检查（TS/Go/Rust/Python），结果下轮注入，超时 15s 静默降级。
- `symbol-references.ts`：编辑后提取变更符号名并搜索外部引用告警。
- `diff-channel.ts`：edit/write 算出的 diff 写入，executor 读取通知 UI（按 filePath 索引的共享通道）。
- `sqlite.ts`：node:sqlite 封装层，暴露 better-sqlite3 兼容 API，供 db-query / xref / 知识库共用。
- `builtin/`：两个 Python 工具脚本（由 hot-reload 的 tool-watcher 经 Python 桥注册）：
  - `docx_read.py`（python-docx 读 Word）
  - `xlsx_read.py`（openpyxl 读 Excel）

---

### 1.3 工具注册表与安全/权限

**`registry.ts`** — 仅是 re-export：`ToolRegistry` 真正实现位于 `registry/tool.registry.ts`（见 §2）。

**`filtered-registry.ts` — `FilteredToolRegistry extends ToolRegistry`**
- 包装父注册表 + 白名单 `allowedTools`，重写 get/getAll/getToolDefinitions/has。
- 用途：子 Agent 工具隔离（子 Agent 只见/只能调用白名单内工具）。

**`path-sandbox.ts`** — 路径沙箱包装
- `createSandboxedTool(tool, root)`：对 read/write/edit（file_path）与 grep/glob（path）解析并校验到 sandboxRoot 内，越界拒绝；bash 在沙箱模式直接拒绝。
- `wrapSandboxedTools(tools, root)`：批量包装。
- 用途：子 Agent 沙箱模式 / 带 cwd 约束的运行。

**`tool-config.ts`** — 工具配置出口
- `injectToolConfigCenter(cc)` / `getToolConfig(key, fallback)`：内置工具参数默认值统一走 runtime/config-center 的 `tools.*` 键（read.maxLines、executor.timeoutMs、glob.maxResults、grep.maxFileSizeBytes、bash.timeoutSec、http.*、db.maxRows 等）。注入前回退硬编码默认。

**权限白名单（runtime-control/allowlist.ts）** — `allow_tool` / `disallow_tool` / `list_allowlist`，操作 configCenter 的 `safety.allowedTools`（加入后无需用户确认即可执行）。

**安全入口**：BashTool 的 SandboxConfig（危险命令黑名单 + 词边界正则）、path-sandbox、allowlist、以及 MCP config 的危险命令拦截（见 §5）。

---

### 1.4 结果缓冲与注入过滤（安全中间层）

**`result-buffer.ts` — `ToolResultBuffer`**
- 全系统工具执行结果的统一中间层：所有工具（内置/MCP/插件/Skill）结果在注入对话历史前经过 `maybeBuffer(result, toolName)`。
- 超阈值（默认 16KB）→ 先折叠连续重复行（≥5 次压缩为 `[×N]`）→ 写入 `<sessionDir>/buffered-results/`（文件名=工具名-时间戳-FNV1a 哈希）→ 返回"指针消息"（含大小/行数/文件路径/预览/引导用 read 分页读取）。
- 阈值/预览长度可由配置控制；解耦大输出对 token 的占用。

**`injection-filter.ts` — `sanitizeToolResult(content)`**
- 在工具结果进入上下文前的注入清洗：移除 `<system>`、`<|im_start|>system`、`[SYSTEM ...]` 标签 + 中英危险指令模式（ignore previous instructions / 忽略之前的指令 等），命中即从源头截断。

**`background-registry.ts` — `BackgroundProcessRegistry`**
- 管理 `asyncable` 工具启动的后台子进程（dev server 等）：register 生成 `bg_001` 句柄并捕获 stdout/stderr（环形 1000 行），getStatus/getOutput/list/kill（进程树）、shutdownAll、forceKillAll（exit handler 兜底）。

---

### 1.5 四个子目录

#### 1.5.1 `runtime-control/` — 运行时控制工具（依赖 AgentLoop 等运行时实例）

`index.ts` 为聚合出口，按域拆分 8 个文件（消费方 tool.registry / factory 统一从此导入）：

| 文件 | 工具名 | 职责 |
| ---- | ---- | ---- |
| provider.ts | `switch_provider` / `list_providers` / `provider_info` / `switch_to_auto_route` | 切换 Provider（含动态注册新 Provider）、列出/查询、切回自动路由 |
| toggle.ts | `toggle_tool` / `list_tools` / `toggle_skill` / `list_skills` / `toggle_sub_agent` / `list_sub_agents` | 启用/禁用并持久化（tools.disabled） |
| subagent.ts | `list_sub_agent_tasks` / `get_sub_agent_result` / `spawn_sub_agent` / `create_sub_agent` / `update_sub_agent` / `destroy_sub_agent` | 子 Agent 异步任务与生命周期（多实例分身） |
| session.ts | `interrupt` / `current_session` / `session_stats` / `list_sessions` / `new_session` / `switch_session` / `delete_session` | 会话控制（精确中断子 Agent 用 delegate-tool 动态 import 避免循环依赖） |
| allowlist.ts | `allow_tool` / `disallow_tool` / `list_allowlist` | 安全白名单管理（入白名单免确认） |
| task.ts | `add_task` / `remove_task` / `list_tasks` / `toggle_task` | 定时任务管理（interval/cron/daily/fixed-time/random 五类调度，走 HeartbeatScheduler） |
| model-channel.ts | `mcp_status` + `list_model_channels` / `add_model_channel` / `remove_model_channel` / `set_channel_role` / `set_channel_model` / `reset_channel_model` / `channel_info` | MCP 连接状态 + 模型通道/角色映射管理 |
| companion.ts | `companion_mode`（activate/create/deactivate）/ `reset_companion_session` | 陪伴模式切换与角色管理、重置陪伴会话 |

注意：runtime-control 的注册集中点在 `registry/tool.registry.ts → registerRuntimeControlTools()`（按 Provider/ModelChannel/Registry control/异步子Agent/Session/MCP status/Allowlist/Task 分组）。

#### 1.5.2 `xref/` — 交叉引用（代码图谱）

- `index.ts`：聚合 `xref_build` / `xref_query` / `xref_graph` 三工具 + `XrefManager`，共享单个 XrefManager 实例（factory 创建注入）。
- `manager.ts` — `XrefManager`（最大文件，约 40K 字节）：SQLite 索引管理器（`~/.agent/cache/xref-<projectKey>.sqlite`），`build()`（全量/增量/目录过滤，分批解析，事务写入）、`query()`（10 种 action 分发）、`graph()`（text/mermaid/graphviz）、`deleteDatabase()`。
- `schema.ts`：类型定义（XrefSymbol/XrefRef/XrefImport/XrefFile） + SQLite DDL（files/symbols/refs/imports/meta + 索引）。
- `parser.ts`：`FileParser` 接口、`ParserRegistry`（按扩展名选解析器）、`createParserRegistry()`（优先 TypeScript AST，失败回落正则）。
- `ts-parser.ts`：TypeScript/JavaScript AST 解析器（ts.createSourceFile + 递归遍历）。
- `regex-parser.ts`：正则回退（TsRegexParser / PyParser / GenericParser）。
- `xref-build.ts` / `xref-query.ts` / `xref-graph.ts`：三个 Tool 实现，封装 manager 相应入口。

数据流：factory → XrefManager.init(rootDir) → (三工具) → 查询时读 SQLite → 文本返回 LLM。

#### 1.5.3 `python-bridge/` — Python 工具桥

- `bridge.ts` — `PythonToolBridge implements Tool`：把 Python 脚本桥接为 Tool。构造时要求 PythonToolMeta；`fromFile` 静态工厂（解析+构造）。
- `parser.ts` — `parsePythonToolMeta(filePath)`：从 docstring 解析 `name/description/parameters`（YAML-like 缩进转 JSON Schema）。
- `executor.ts` — `executePython(filePath, args)`：spawn python（优先虚拟环境）传 JSON 参数，stdout 返回；60s 超时、100KB 输出上限。
- `index.ts`：聚合导出。

注册链路：tool-watcher/hot-reload 触发 → parsePythonToolMeta → new PythonToolBridge → ToolRegistry.register；执行时 bridge.execute → executePython。内置 builtin/*.py 即走此桥。

---

## 2. src/registry/（5 文件 / 约 660 行）

**`base.ts` — 注册表体系基石**
- `RegistryItem` 基接口：`name` + 可选 `source`（'builtin'|'mcp'|'plugin'|'file'|'user'）。
- `GenericRegistry<T extends RegistryItem>`（抽象类）：`items: Map` + `_disabled: Set` + 事件监听器；统一 `register/unregister/get/getAll/has/enable/disable/isEnabled/getEnabled/getDisabled/isEmpty/size` + 事件 `onEvent/offEvent`（register/unregister/enable/disable/update）。
- 语义：get/（禁用返回 undefined、getAll 过滤禁用），同名覆盖（register 以 name 为键）。可插拔、可独立测试。

**`tool.registry.ts` — `ToolRegistry extends GenericRegistry`**
- `RegisteredTool extends Tool`：附加 `source` 与 `mcpServer?`（来自哪个 MCP Server，mcp 工具名 `mcp__{清洗名}__{tool}`，清洗不可逆）。
- 额外能力：
  - 热插拔追踪：`markHotAdded/getHotAddedNames/clearHotAdded`（供 hot-reload/tool-watcher 与 Zone 5 session_tools）。
  - `getToolDefinitions(companionMode?)`：生成 LLM 用定义数组；过滤 companionOnly、陪伴模式取 companionDescription、按名排序。
  - `registerConfigTools(configCenter)`：注册 4 个配置工具。
  - `registerRuntimeControlTools(agentLoop, providerRouter, skillRegistry, agentRegistry, configCenter, cwd, heartbeatScheduler?, mcpSystem?, modelRouter?)`：集中注册 30+ 运行时工具（分组见 §1.5.1），依赖项按存在性条件注册。
- 向后兼容别名 `enableTool/disableTool`（deprecated）。

**`skill.registry.ts` — `SkillRegistry extends GenericRegistry<SkillDefinition>`**
- 内置快照恢复：`registerBuiltin` 保存副本，`unregister` 时若存在同名内置则自动恢复。
- `getIndex()`（供 Zone 2 manifest）、`getFullDefinitions(names)`。
- `createBuiltinSkills()`：从 `src/prompts/skills/` 加载 code-review/debug/refactor/framework-reference 四条内置 skill。

**`agent.registry.ts` — `AgentRegistry extends GenericRegistry`（多实例语义，大幅覆写）**
- 以 instanceId（name-短UUID）为键而非 name；`agents` 按 name 分组存实例数组。
- `get(name)` 返回该名下所有启用实例数组（有意背离基类单值语义）；`spawnInstance` 克隆模板建分身；`enable/disable` 作用于该名下全部实例；`update(instanceId, partial)` 改描述/提示词/允许工具/模型/协作模式/TTL；`destroyInstance`；`getIndex()`/`getFullDefinitions()` 供 prompt 注入。

**`index.ts`** — 统一导出 + 结论说明：
- 现实现注册表仅 3 个：`ToolRegistry` / `SkillRegistry` / `AgentRegistry`。
- **关于"7 种专用注册表"的重要事实**：注释明确说明 ProviderRegistry / ChannelRegistry / PluginRegistry **已废弃（2026-09, P4）**——由 ProviderRouter / ModelChannelRegistry / PluginManager 覆盖全部语义，无消费者；McpRegistry **已移除**——MCP 统一由 MCPSystem 管理，不再有独立 Registry 包装。因此源码中只有 Agent/Channel/MCP/Provider/Plugin/Skill/Tool 中的"Tool/Skill/Agent"三个真实遗留。

`base.test.ts`：GenericRegistry 的单元测试。

---

## 3. src/plugins/（14 文件 / 约 1500 行）

设计要点：P2 改造把"能力注册 + 生命周期 + 自动回滚"委托给内核 `kernel/plugin-host.ts` 的 `PluginHost` / `DisposableStore`；`plugin-adapter.ts` 把旧 `PluginDefinition` 包装为内核 `HyPlugin`，register 操作登记进 DisposableStore，卸载自动逆序回滚（零侵入、可插拔稳定的直接体现）。

- **`types.ts`** — 核心类型：
  - `PluginManifest`（plugin.json 结构）：id/name/description/entry/enabledByDefault?/skills?/configSchema?/version?。
  - `PluginDefinition`（definePlugin 返回）：id/name/description/configSchema?/register(api)/onActivate?/onDeactivate?。
  - `PluginApi`（暴露给插件的能力面）：register/unregister × 5（tool/skill/mcp/config—即 contextSource/channel）+ 对应 unregister；`onHook`/`aroundHook`（挂主循环钩子/包裹接缝）；`getConfig()`；`logger`；`pluginId`。
  - `PluginInstance`（运行时状态）：manifest/definition/status（discovered/loaded/activated/deactivated/error）/mcpServers/dir/error。

- **`define.ts`** — `definePlugin(options)`：轻量工厂构造 PluginDefinition。

- **`api.ts`** — `createPluginApi(options)`：为每个插件在 register 时构造独立 PluginApi；每个能力方法直接操作宿主注册表（ToolRegistry/SkillRegistry/ContextComposer/ChannelManager/MCP 回调），并触发 onXxxRegister 追踪回调（供自动回滚登记）。

- **`loader.ts`** — `PluginLoader`：
  - 搜索路径按优先级：`<projectDir>/.agent/plugins/<id>/` 与 `<projectDir>/plugins/<id>/`。
  - `discover()` 扫描子目录读 plugin.json；`loadEntryModule()` dynamic import 入口（热重载加时间戳破缓存）；`loadPluginConfig()` 读 `.agent/plugins.config.json`（支持新旧两格式）；`loadHyPlugin()` 目录插件→HyPlugin 一体化装载。

- **`manager.ts`** — `PluginManager`（生命周期协调器，约 18K 字节）：
  - `PluginManagerDeps`：toolRegistry/skillRegistry/contextComposer/projectDir/channelManager?/mcpSystem?。
  - `loadAll()` 增量发现（移除已删除、加载新增/变更是 reload() 单独做）；config 显式禁用则跳过。
  - `activate(id)/deactivate(id)`：activate → configSchema 校验 → wrapAsHyPlugin → host.mount（自动追踪+回滚）；deactivate → host.unmount（逆序释放 DisposableStore）。
  - `createApiWithAutoRollback`：每个 register 调用登记一个 dispose 回调（工具/技能/上下文源/MCP 队列/渠道），卸载自动逆序回滚。
  - MCP 委托：插件声明 MCP 汇集到 `pendingMcpConfigs`，`connectPluginMcpServers()` 统一 `mcpSystem.addExternalServers(configs)`。
  - 渠道注册：`onChannelRegister → channelManager.register(handler)`，回滚时 unregister。

- **`plugin-adapter.ts`** — `wrapAsHyPlugin(deps, instance, config)`：把 PluginDefinition 适配为内核 HyPlugin；activate 时执行 register/onActivate，并扫描 `{manifest.id}-` 前缀 skill 注册为 `plugin-skill-<name>` ContextSource；deactivate 调 onDeactivate。

- **`index.ts`** — 聚合导出 definePlugin/createPluginApi/PluginLoader/wrapAsHyPlugin/PluginManager/类型。

- 示例插件 **`plugins/example-greeter/`**（repo 根 plugins/ 目录）：
  - `plugin.json`：id=example-greeter，entry=./index.js，enabledByDefault=true。
  - `index.js`（已编译 JS）：default export PluginDefinition —— register 注册 `hello` 工具 + `example-greeter-friendly` skill；onActivate/onDeactivate 打日志 + 展示 getConfig()。

- 其余文件为插件能力演示/测试：knowledge-plugin / generation-plugin / bypass-plugin / demo-override-context / world-engine-plugin / xref-plugin 及其 `.test.ts`、permission-chain 等。

---

## 4. src/skills/（4 文件）

**`skill-tool.ts` — `SkillTool implements Tool`（工具名 `use_skill`）**
- 输入 `skill_name`（必填）+ `variables`（模板变量）。
- `execute`：查 SkillRegistry 取 skill；把 `{{variable}}` 占位符替换为给定值，未替换的占位符清理为 `(name)`；返回渲染后的 prompt 文本注入对话。
- 注册到 ToolRegistry（Skill 本身不是 Tool，而是经 use_skill 激活）。

**`loader.ts`** — `loadSkillFile(path)` / `scanSkillsDir(dir, registry)`：解析 Markdown 的 YAML frontmatter（name/description/tools→relatedTools）+ 正文即 promptTemplate，注册为 `source:'file'` 的 Skill。

**`registry.ts`** — re-export `SkillRegistry` / `createBuiltinSkills`（实现见 §2）。

**`index.ts`** — 聚合导出。

---

## 5. src/mcp/（11 文件 / 约 1300 行）

**`system.ts` — `MCPSystem`（MCP 统一管理器）**
- 对标 PluginManager。`start()`：configLoader.load → 清扫孤儿进程 → 逐个 addServer；`stop()`：逐个 disconnect；`reload()`：热加载增量增/删/改（新增/变更打 `isHotPlug` 标记 → ContextSource 用 live 缓存进 Zone 5）。
- 依赖通过 register 注入：`registerToToolRegistry`（→ bridge.registerToRegistry）、`registerToContextComposer`（每 Server 一个 ContextSource `mcp-<name>`，strategy=index_only，cacheability=hot?live:manifest）、`registerToLifecycleSupervisor`。
- 对外：`addExternalServer(s)/removeExternalServer`（插件声明 MCP 走此路径）、`getConfigView()`（UI 展示含 _disabled）、`setServerEnabled`（写回配置文件 _disabled + reload）、`onStatusChange`（added/removed/failed 事件）。
- 内部 `addServer`：installManager.ensureInstalled（自动装 npm/python 包）→ MCPServerManager.connect → syncBridge → 注册工具/ContextSource/Supervisor。

**`config.ts` — `MCPConfigLoader`**
- `getMCPConfigPaths`：3 层优先级（`~/agent/mcp.json` 用户级 < `.mcp.json` 项目级 < `.agent/mcp.json` 项目级），同名高优先覆盖，`_disabled` 标记条目。
- 危险命令黑名单（cmd/powershell/bash/sh/zsh 等 shell）在 parseOne 拦截；超时（connectTimeout/callTimeout）可配。

**`client.ts` — `MCPClient`**
- 基于 `@modelcontextprotocol/sdk` 的 Client；连接传输：stdio（StdioClientTransport）或 HTTP SSE（SSEClientTransport）。
- `connect`（带连接超时 30s）、`listTools`、`callTool`（调用超时 60s，错误分类：连接丢失/参数错/内部错）、`getToolIndex()`（合并索引文本）。

**`bridge.ts` — `MCPBridge`（MCP 工具 → ToolRegistry 桥）**
- 为每个 MCP 工具注册 `mcp__{sanitizeMcpName(server)}__{tool}` 名；描述前缀 `[MCP:server]`；`source:'mcp'` + `mcpServer` 保留原始名；若工具名含副作用关键词则标注 `[side-effect]`。
- `registerToRegistry`（幂等，先清旧）、`unregisterTools`、`getAllToolNames`（与注册名算法一致）。

**`side-effect.ts`** — `sanitizeMcpName`（清洗 server 名）+ `hasSideEffect`（create/delete/write/navigate 等关键词）。

**`lifecycle.ts` — `MCPServerManager`**
- 组合 ProcessManager（spawn/监控；因 stdio MCP 无 HTTP 端点，autoRestart=false、靠 onCrash 回调 + 工具调用超时检测挂起）+ MCPClient。
- `connect`（stdio 先 start 进程再 ProcessTransport / SSE 直连 + 二次验证）、`reconnect`、`handleCrash`（stdio 固定 2s / SSE 指数退避至 30s，`maxReconnectAttempts=5` 后放弃并收割进程树）。

**`process-transport.ts`** — `ProcessTransport implements Transport`：包 stdio（ReadBuffer + serializeMessage/parseLine），适配 SDK 传输接口。

**`install-manager.ts`** — `MCPInstallManager`：`~/.agent/mcp-servers/<name>/` 安装 npm/python 包 + 版本索引 `~/.agent/mcp-installed.json`；安全升级（先下载到 `<name>.new/`，成功后原子替换，失败回退旧版）；返回解析后的 command/args（npm .bin / python -m）。

**`orphan-sweeper.ts`** — `sweepOrphanedMcpProcesses`：Windows 启动前清扫孤儿 MCP 进程树（PowerShell 枚举 + 配置 args 推导特征串 + 父进程死亡判定 → taskkill /T，宁可漏杀不误杀）。

**`shutdown.ts`** — `trackMcpSystemForShutdown`：process.on('exit') 同步 forceKillAll 收割所有 MCPSystem 的进程树。

**`index.ts`** — 聚合导出全部 MCP 类。

---

## 6. 跨模块数据流示例

1. **内置工具调用**：LLM 发起 ToolCall → AgentLoop → `ToolExecutor.execute` → ToolRegistry.get(name) → tool.execute(input, signal) → ToolResultBuffer.maybeBuffer（超阈值落盘） → sanitizeToolResult（注入过滤） → 注入对话历史。
2. **MCP 工具**：MCPSystem.start → MCPServerManager.connect → MCPClient(stdio/SSE) → MCPBridge 注册 `mcp__server__tool` 到 ToolRegistry → Agent 调用 → bridge 闭包 → MCPClient.callTool → 返回文本。崩溃 → MCPServerManager.handleCrash 重连。
3. **插件注册工具**：PluginLoader.discover → loadEntryModule → wrapAsHyPlugin → PluginHost.mount → api.registerTool → ToolRegistry.register（并登记 dispose，卸载回滚）。插件 MCP → PluginManager.pendingMcpConfigs → MCPSystem.addExternalServers。
4. **Skill 激活**：LLM 调 use_skill → SkillTool.execute → SkillRegistry.get(skill_name) → 渲染 `{{var}}` → 返回提示词文本注入对话。

---

## 详细 渠道与 UI

> 本文分析 `src/channels/`、`src/ui/`、`src/ui-protocol/`、`src/webui/` 四个模块的内部结构、关系与依赖方向。只描述职责与结构，不展示代码。

---

## 一、模块总览与依赖方向

四个模块构成"多渠道接入 + 前端渲染 + 统一 UI 协议"三层骨架：

```
┌──────────────────────────────────────────────────────────────┐
│  src/channels/  多渠道接入层（ChannelHandler 抽象 + 内置/插件渠道）│
│  └─ 内置渠道：TUI、HTTP Webhook、UI 协议会话（WS/进程内）        │
│  └─ 插件渠道：飞书 feishu、微信 ClawBot                            │
├──────────────────────────────────────────────────────────────┤
│  src/ui-protocol/  前端协议层（连接任意 UI 形态的统一双向协议）    │
│  ── UiProtocolServer 路由 + 传输适配器 + 19 个业务域              │
├──────────────────────────────────────────────────────────────┤
│  src/ui/  TUI 组件库（斜杠命令、聊天日志、Markdown/Diff/主题）    │
├──────────────────────────────────────────────────────────────┤
│  src/webui/  浏览器端 WebUI（静态 HTML/CSS/JS + vendor + assets） │
└──────────────────────────────────────────────────────────────┘
```

**依赖方向**（谁引用谁）：
- `channels/` 是上层装配层：`gateway/tui.ts`、`gateway/server.ts` 使用 `auto-detect.ts` 注册渠道、使用 `manager.ts` 启动渠道、在托盘管线里注入 `TuiChannel`；`builtin/http-webhook.ts` 与 `builtin/ui-protocol-session.ts` 分别依赖 `ui-protocol/`（协议服务器、传输、域工厂）与运行时模块（provider、memory/session、runtime/config-center、provider/model-channel-registry 等）。
- `ui-protocol/` 依赖后端运行时模块（`orchestrator/loop`、`memory/session`、`memory/events`、`runtime/config-center`、`provider/model-channel-registry`、`provider/config`、`hot-reload/manifest-watcher`、`tools/ask-user`、`companion/*`、`events.ts` 等）。其中 `src/events.ts` 是跨层中立的事件契约层，`ui-protocol/types.ts` 仅 re-export，避免业务核心反向依赖 UI 适配层。
- `ui/` 是纯前端组件库，只依赖第三方 `@earendil-works/pi-tui`、`chalk`，以及 `memory/session`、`provider/model-channel-registry`（斜杠命令动态子命令提供者用到），不依赖 `ui-protocol/`。
- `webui/` 是纯静态资源，被 `http-webhook.ts` 的 Fastify @fastify/static 静态服务托管。

---

## 二、src/channels/ —— 多渠道接入层

### 2.1 核心抽象：interface.ts
定义整个渠道系统的"统一语言"，是全模块的契约中心：

- **配置与事件**：`ChannelConfig`（自由键 + `enabled` 开关）；`ChannelEvent`（判别联合）：`ChannelMessageEvent`（会话/用户/内容/图片/元数据）、`ChannelConnectedEvent`、`ChannelDisconnectedEvent`、`ChannelErrorEvent`。图片以 base64 + MIME 携带，由各渠道自行下载填入。
- **回复**：`ChannelReply`（content + images + metadata）。
- **跨渠道发送目标**：`ChannelTarget`（`type: 'user' | 'chat'` + `id`，ID 格式由各渠道自行解析，如飞书 `ou_`/`oc_`）。
- **Agent 运行接口**：`ChannelOutputHandler`（文本/工具调用/状态/回合开始/冲刷/中断回调）、`ChannelSessionRunner`（`run` + `setOutputHandler`）、`AgentFactory`（创建 AgentLoop 的工厂，由 gateway 注入）、`ReplyFn`。
- **区域核心 `ChannelHandler` 接口**：`register→start→onEvent→handleMessage→reply→stop` 生命周期；`id/name/description/pluginId`；可选 `updateConfig`、`handleTuiCommand`（TUI 子命令，如 `clawbot/login`）、`getStatus`、可选 `send()`（跨渠道"纯借用"入口）。
- **状态**：`ChannelStatus`（registered/starting/active/stopped/error）、`ChannelState`（handler + status + config）。

### 2.2 生命周期管理者：manager.ts
`ChannelManager`：维护 `Map<id, ChannelState>`。
- 注册/注销/批量注册、`getAll/get/getActive`。
- `startAll(agentFactory, enabledIds?)`：向 `config` 注入 `agentFactory`，用 `onEvent` 订阅；收到 `message` 事件时构造 `replyFn`（转调 `handler.reply`）并调用 `handler.handleMessage`，最后 `handler.start(config)`，成功置 active。
- 停止/重启、主动 `send(channelId, sessionId, reply)`、`getStatusSummary`。

### 2.3 跨渠道消息分发：dispatcher.ts
- `MessageDispatcher`：持有 `ChannelManager`，按渠道 ID 查找目标渠道并调用其 `handler.send(target, content)`。语义为"纯借用"——不创建 session、不写 conversation、不影响渠道内部状态。不存在的渠道/未 active/未实现 send() 均返回友好字符串，不抛异常。
- `createSendChannelMessageTool(dispatcher)`：暴露给 Agent 的 `send_channel_message` 工具，schema 含 channel/to/target_type/text/images。注释标明此工具由 gateway 在 `channelManager.startAll()` 之后注册，确保所有渠道已启动。
- **数据流**：Agent → 工具 → MessageDispatcher.send → ChannelManager.get → handler.send → 渠道 API → 用户。

### 2.4 通用消息队列：message-queue.ts
`MessageQueue`：channel-agnostic 纯数据结构（无消费逻辑），配 `QueueMessageMode`（queue/insert，insert 语法 `!...!` 走队首 unshift）、进队/出队/pop（Backspace 取消）/peek/定点删除，最大 100 条溢出丢最旧。静态 `detectMode`/`stripMarkers` 可复用。

### 2.5 渠道自动发现：auto-detect.ts
- `ChannelPlugin` 接口：`configKey`（对应 config.json channels 下的键）、`autoRegister(channelManager, config, channelsInfo)`、可选 `onGatewayInit`。
- 插件注册表 + `discoverPlugins()` 扫描 `channels/plugins/*/index.js` 导出名为 `channelPlugin` 的常量。
- `registerConfigChannels(channelManager, cwd)`：加载配置，遍历插件，把各插件的 `configKey` 配置交给 `autoRegister` 注册渠道，返回 `ChannelsInfo[]`（用于注入 System Prompt）。TUI 渠道手动注册；HTTP 渠道由 serve 模式负责。

### 2.6 内置渠道 builtin/

**tui-channel.ts —— `TuiChannel`**（id=tui）
终端 UI 的标准渠道包装，**不包含** blessed 渲染逻辑（渲染仍在 gateway/tui.ts），只做桥接：
- `sendMessage(sessionId, content)` 由 tui.ts 输入处理器调用，触发事件回调。
- `reply` 转调 `onReply` 回调（tui.ts 设置以输出到屏幕）。
- `handleMessage` 委托给 `onHandleMessage` 回调（tui.ts 用主 loop 处理消息）。
- 通过 `onReply`/`onHandleMessage` 两个公开回调字段与外部（gateway/tui.ts）交互。

**http-webhook.ts —— `HttpWebhookChannel`**（id=http-webhook）
企业加固版 HTTP REST + WebSocket 渠道，基于 Fastify，是 WebUI/桌面端/远程 TUI 的后端载体：
- 认证：Bearer Token（`HYACINTH_API_KEY`/`--api-key`/`config.apiKey`），`authHook` 对所有 preHandler 生效；WS upgrade 在 Fastify preHandler 之外单独校验，防止绕过。
- REST 端点：`/api/health`、`/api/chat`（同步 request-response，`CollectHandler` 收集文本/工具调用/状态后返回）、`/api/sessions`（list/create/:id 恢复/删除）、`/api/tools`、`/api/skills`；媒体路由 `registerMediaRoutes`；陪伴语音端点 `/api/companion/voice/list|:id/file`。
- **WebSocket 端点 `/tui`、`/desktop`、`/ui`** 统一走 `wireUiSession`（见下），共享同一套 ui-protocol 协议，取代旧 `/tui` `/desktop` 的老协议。
- 安全头：nosniff/DENY/XSS-Protection/CORS。
- WebUI 静态资源：`webuiRoot` 存在时用 @fastify/static 托管（`/vendor/`、`/assets/` 等免认证）。

**ui-protocol-session.ts —— `UiProtocolSession`**（传输无关的协议会话）
是 ui-protocol 协议层的**唯一生产装配入口**：
- 构造：创建 `UiProtocolServer` + `ProtocolOutputHandler` + `PendingRequestRegistry`，注册**静态域**（不依赖 AgentLoop）：config/session/model/command/permission/kb/process/orchestrator/context/tool/bundle/plugin/mcp/companion。
- `initialize(agentFactory)`：`createAgent` 拿到 AgentLoop 后注册**动态域**（message/state/schedule），桥接 `ask_user` 工具（`setAskUserHandler` → `onAskUser` → `message.ask_user` 事件 → `message.askUserResolve` 应答），`attach` 适配器并广播 `ui.connected`。
- `UiProtocolSessionBackend`：静态后端依赖注入面（configCenter/sessionStore/registry/manager/commandRegistry/historyProvider/statsProvider/getKb/getRegistry/getBypassManager/getToolRegistry/getBundleRegistry/getMCP/getCompanionMgr/getRouterSwitcher/音色库/生成语音库/台词历史/场景读取/URL 构造器等，多为异步解引用闭包）。
- 还提供：`createManifestAdapter`（把 ManifestLoader 包装成协议层 ManifestLike）、`createDefaultSceneReader`（读 ~/.agent/companion/<角色>/scene.json）、`createBackendExecutor`（后端命令执行器，识别 `model/online/*`、`channel/*` 等，委托真实 ModelChannelRegistry / loop.switchProvider）。

**ui-ws-session.ts —— `UiWsSession`**（协议层 over WebSocket 的薄封装）
只做"WebSocket → WsAdapter"传输绑定，装配逻辑全在 `UiProtocolSession`。`UiWsSessionBackend extends UiProtocolSessionBackend`。http-webhook 的 `wireUiSession` 用它初始化并暴露 `getLoop/getComponents`。

**golden-scenarios.ts**
黄金主测试（Golden Master）公共模块：把旧 TuiWsSession 协议与新 ui-protocol 协议规范化成一棵 `GoldenOp` 事件流（connected/thinking/text/status/tool_use/tool_result/turn_info/interrupt/permission_req/error），用于重构前后行为一致性回归。含场景定义、fake loop、waitFor/sleep/collectOps 等测试驱动 helper。配套 `__golden__/tui-legacy-golden.json` 快照与 `ui-ws-contract.test.ts`、`ui-ws-golden.test.ts`。

### 2.7 插件渠道 plugins/

**飞书 feishu/**（id=feishu）——通过 `feishuChannelPlugin`（`channelPlugin` 别名）自动注册。WebSocket 长连接（SDK 底层）收发。

各文件职责：
- `index.ts`：导出入口 + `ChannelPlugin`（configKey=`feishu`，`onGatewayInit` 装日志抑制器，`autoRegister` 按配置注册并 push ChannelsInfo）。
- `feishu-config.ts`：配置类型 + `resolveFeishuConfig`（默认值）/`validateFeishuConfig`。含 connectionMode（websocket）、domain（feishu/lark）、DM/群组策略（open/allowlist/disabled）、requireMention、resolveSenderNames、tuiSync、sessionMode（shared/per_chat/per_user）。
- `feishu-transport.ts`：`FeishuTransport` 管理 WS 生命周期（start/stop/onMessage），注册 `im.message.receive_v1` 事件，SDK 内置自动重连。
- `feishu-client.ts`：`FeishuClientFactory` + 模块级便捷函数（createFeishuClient/createFeishuWSClient/createEventDispatcher），基于配置哈希缓存 Client，懒加载 SDK。
- `feishu-event.ts`：`parseFeishuMessageEvent`、`parseMessageContent`（text/post/interactive/image）、`checkBotMentioned`、`FeishuDedupeStore`（去重窗口 10 分钟）、`checkDmAccess`/`checkGroupAccess`（白名单匹配）。
- `feishu-send.ts`：`sendText`（post 格式富文本/Markdown 子集）、`sendCard`/`buildMarkdownCard`/`patchCard`（含流式更新）、`sendImage`、`getSenderInfo`、`resolveSendTarget`（ID 前缀推导 receive_id_type）、错误增强（feishuContext/feishuResponse）。
- `feishu-streaming.ts`：`FeishuStreamingCard` 流式卡片控制器（先发占位卡片，按间隔 patch 更新，finished/aborted 终态）。
- `feishu-message-queue.ts`：`FeishuMessageQueue` per-session 串行队列（入队先 ACK，队列内去重，最大 100 背压）。
- `feishu-session.ts`：`ChannelSessionPool`（按 sessionMode 生成 sessionId）+ `createCollectHandler`（只收集文本、丢弃工具/状态回调）。
- `feishu-log-suppressor.ts`：`installSDKLogSuppressor` 拦截 `console.log` 到 stderr，避免污染 TUI。
- `feishu-channel.ts`：`FeishuChannel` 主实现——大小写包括 sessionMap/conversationToSession 映射、`sessionPool`、LRU loop cache（server 模式）、chatId 持久化（`.agent/feishu_chat.json`）、`__channelLoopRegistry` 定时任务路由注册；原始消息处理流程：解析→去重→访问控制（群聊查 requireMention）→构造 sessionId→持久化→发送者名/图片下载→构造 ChannelMessageEvent→入队；提供 `send()`（跨渠道借用：卡片/文本/图片）、`sendProactiveMessage`、`handleTaskNotification`（定时任务通知拉 loop 执行并推送）、`handleWithCollectHandler`/`handleWithStreamingCard` 两种回复模式、`updateConfig`。

**微信 ClawBot clawbot/**（id=clawbot）——通过 `clawbotChannelPlugin` 自动注册。HTTP 长轮询（非 WS）、无 SDK、二维码授权、单会话。

各文件职责：
- `index.ts`：导出入口 + `ChannelPlugin`（configKey=`clawbot`）。
- `clawbot-config.ts`：配置 + `resolveClawbotConfig`/`validateClawbotConfig`（无必填项，botToken 可运行时扫码）。
- `clawbot-client.ts`：`ClawbotClient` 封装 iLink 协议 7 个 HTTP 接口（getQRCode/getQRCodeStatus/getUpdates/sendMessage/sendTyping/getConfig/getUploadUrl），`ClawbotAPIError`（errcode:-14 判 token 过期），`sendMessageChunked` 长文本分片（2000 字符、双换行/单换行/空格切割），防重放头 X-WECHAT-UIN。
- `clawbot-auth.ts`：`ClawbotAuthManager` 二维码授权 + bot_token 生命周期（7 天有效期、2 天告警、restoreFromCache/setTokenDirect/startAuthorization/refreshToken 状态机 wait→scaned→confirmed/expired），持久化 `.agent/clawbot_token.json`。
- `clawbot-message-queue.ts`：per-session 串行队列（与飞书同构）。
- `clawbot-session.ts`：`createCollectHandler`（单会话版）。
- `clawbot-channel.ts`：`ClawbotChannel` 主实现——授权回调（二维码 URL 输出到 TUI/控制台）、长轮询循环（while、opaque get_updates_buf 回传）、`handleIncomingMessage`（过滤非 FINISH、过滤 bot 自身消息、提取文本/下载图片、context_token 管理、构造事件入队）、token 过期自动重授权、`handleTuiCommand`（`clawbot/login`、`clawbot/status`）、`sendProactiveMessage`/`handleTaskNotification`、typing ticket 预取、session 持久化（`.agent/clawbot_session.json`）、回复分片发送。

### 2.8 与模块外的依赖方向（channels/）
- 向外（被使用）：`gateway/tui.ts`、`gateway/server.ts` 是主要调用方（注册/启动渠道、注册 send_channel_message 工具、注入 TuiChannel 回调、创建 UiProtocolSession 本地模式）。
- 向内（引用）：`logging/logger`（manager）、`setup/config`（auto-detect）、`env/index`（ChannelsInfo）、`tools/interface` 类型（dispatcher）、`provider/interface`、`memory/session`（sessionId/sessionManager）、`orchestrator/loop`（OutputHandler）、`gateway/factory`（createAgent/AgentComponents）、`runtime/config-center`、`runtime/defaults`、`provider/model-channel-registry`、`provider/config`、`local-model`、`context/profiles`（switchRouter）、`prompts/loader`、`memory/events`、`companion/*`、`memory/stats`、`hot-reload/manifest-watcher`、`tools/ask-user`、`logging/logger`、`ui-protocol/*`（server/adapter/transport/domains/types）、`ui/command-registry`。

### 2.9 sessionId 前缀 → 渠道 契约（`src/session-channel.ts`，根级中立契约）

会话目录名形如 `{channel}_YYYYMMDD-HHMMSS-XXXX`；无渠道启动（CLI 单发 / serve）则是
**裸日期 ID**（如 `20260916-170213-1bfa`）。"前缀 → 渠道"映射用于**从 sessionId 反推渠道**：
`resolveChannelFromSessionId()` 由 `memory/session.ts`（为缺 meta 的存量会话补写 channel）与
`orchestrator/loop.ts`（`materializeSessionIfNeeded`）消费，也是**渠道隔离恢复**
（`SessionManager.getLatestByChannel`）与 `ChannelManager` 前缀登记的同一张表。

**为什么放在根级而非 `memory/`**：该文件只是一张映射表 + 纯函数（无业务逻辑）。早期放在
`memory/`（业务核心）下时，`channels/manager.ts` 引用它会被 `verify:layers` 规则 5 判为
"UI 直连业务核心"，而该白名单**只减不增** —— 这种引用永远无法合法登记。上移到 `src/` 根级后
与 `events.ts`/`types.ts` 同级，属规则内明确豁免的"根级基础文件"，双方引用均合法。

**单一真源 + 插件自管**（历史事故：前缀是散落在核心里的字面量、与渠道实现分家，导致插件渠道
`clawbot` 生产侧一直 `generateSessionId('clawbot')` 造得出 `clawbot_xxx`，注册表里却从来没有
`clawbot_`，会话归属永远推断不出、渠道隔离失效）：

| 渠道类型 | 前缀声明位置 | 登记时机 |
|---|---|---|
| 内置（tui / webui） | `src/session-channel.ts` 的 `TUI_SESSION_PREFIX` / `WEBUI_SESSION_PREFIXES` —— **单一真源**，handler 只引用常量、不得写字面量 | 模块加载即登记（与渠道是否启用/加载无关，保证任何模式下存量会话都可解析） |
| 插件（feishu / clawbot / 第三方） | 插件自己的 `*_SESSION_PREFIX` 常量 + `handler.sessionPrefix` 字段 | `ChannelManager.register()` 自动登记；**并在 `ChannelPlugin.autoRegister` 开头无条件登记**（早于 `enabled` 判断 —— 该钩子对每个已发现插件都会执行，所以插件被禁用时前缀依旧可解析） |

- 契约字段：`ChannelHandler.sessionPrefix?: string | readonly string[]`（多前缀场景，如 WebUI 的
  `webui_` + 旧版 `ui_`；`ui_` 是历史 `/ui` 前缀，用于兼容存量会话）。
- 方向约束：**核心不反向依赖插件** —— 插件渠道绝不登记进内置前缀表。
- 新增内置渠道 = 前缀表加一行 + handler 引用该常量；新增插件渠道 = 插件内声明常量 + autoRegister 登记。
- 守卫测试：`src/session-channel.test.ts`（注册表语义：最长前缀优先 / 多前缀 / 幂等 / 注销）+
  `src/channels/session-prefix-contract.guard.test.ts`（内置 handler 必须引用常量；插件前缀登记
  必须早于 `enabled` 判断）。
- WebUI 会话前缀：`http-webhook.ts`（REST `/api/chat`）与 `ui-protocol-session.ts`（WS/UI 协议会话）
  创建 Agent 时传 `channel: 'webui'`，使 WebUI 会话落 `webui_` 前缀并启用渠道隔离恢复。
  **历史缺口**：这两处曾不传 channel，WebUI 会话落成裸日期 ID，与 CLI/serve 的裸会话混在
  同一命名空间 —— 既分不清来源、也无法按渠道恢复。

---

## 三、src/ui/ —— TUI 组件库

基于 `@earendil-works/pi-tui` 的组件与工具，供 gateway/tui.ts 的终端界面渲染使用。注意：渲染装配（blessed/pi-tui 主循环）在 gateway/tui.ts，`ui/` 只提供可复用组件。

### 3.1 斜杠命令系统
- **command-registry.ts —— `CommandRegistry`**（单例，extends EventEmitter）：统一斜杠命令注册中心。命令来源分两路：`BUILTIN_COMMANDS`（内置硬编码、带分类/图标/参数/动态子命令提供者）+ `commands.json`（用户/模型可写，热重载），同名用户命令递归覆盖内置。API：`getAll/getByCategory/getUserCommands/getConfigPath/filter/find/findParent/flattenCommands/resolvePath`。内置命令覆盖 help/session/clear/exit/restart/new/status/model（online/local/settings/thinking/info 多级）/context/turns/compress/threshold/confirm/log/training/scavenge/storm/storm-win/storm-th/schedule/schedule-add/zone4/kb/orchestrator/default-mode/channel/clawbot 等。`SlashCommandCategory`：session/model/tools/system/config/repair/mode。
- **slash-commands.ts**：门面层，把 `getSlashCommands/getCommandsByCategory/filterCommands/findCommand/getCategoryLabel` 委托给 `CommandRegistry` 单例，re-export 类型与分类标签。
- **slash-panel.ts —— `SlashSubPanel`**：斜杠命令二级菜单浮层面板（pi-tui `SelectList`），支持多级子命令导航（子面板继承路径前缀），`childrenProvider` 在打开时动态生成，返回值 `SubPanelResult{path, command}`，Esc/回车/上下键处理。

### 3.2 聊天日志
- **chat-log.ts —— `ChatLog`**（extends Container）：核心日志容器。内置极简 diff/流式状态缓存：
  - `streamingRuns`（runId→AssistantMessageComponent）支持流式更新/终结/丢弃助手消息；
  - `toolById`（toolCallId→ToolExecutionComponent）支持工具开始/参数更新/结果/部分结果；
  - 系统消息重复合并（coalesceConsecutive）；
  - 滚动视图（scrollOffset、pinnedToBottom、unreadCount、setViewportHeight/scrollToLine/pinToBottom）、最大组件数裁剪、`showDiff`、工具栏/展开切换、文本/行数提取。
- **assistant-message.ts —— `AssistantMessageComponent`**：助手消息（HyperlinkMarkdown + Spacer）。
- **markdown-message.ts —— `MarkdownMessageComponent`**：通用 Markdown 组件（HyperlinkMarkdown 包装）。
- **user-message.ts —— `UserMessageComponent`**：用户消息（继承 Markdown 组件，带 userBg/userText 主题）。

### 3.3 工具展示与 Diff
- **tool-display.ts**：`TOOL_DISPLAY` 表把工具名映射为 emoji/label/detailKeys（如 read→📖 Read path），`resolveToolDisplay` + `formatToolSummary`（bash 特判）。
- **tool-execution.ts —— `ToolExecutionComponent`**：工具执行卡片（标题 emoji + 参数摘要 + Markdown 输出），pending/success/error 三态背景色，部分结果省略号，展开/折叠（preview 12 行）。
- **diff-component.ts —— `DiffComponent`**：渲染文件 diff（单 Text 组件避免子组件间距），add/del/header 配色，最多 30 行 + 截断。

### 3.4 Markdown / 超链接 / 净化
- **hyperlink-markdown.ts —— `HyperlinkMarkdown`**：包装 pi-tui `Markdown`，渲染后调 `addOsc8Hyperlinks` 追加 OSC8 超链接。
- **osc8-hyperlinks.ts**：`wrapOsc8/extractUrls/addOsc8Hyperlinks`——把 Markdown 中的链接转为终端 OSC8 可点击超链接（剥 ANSI、URL 范围定位、跨行 pending）。
- **tui-formatters.ts**：`sanitizeRenderableText`——终端安全净化：剥 ANSI/控制字符、二进制内容行占位、超长 token 分词（跳过可复制敏感 token，如 URL/路径/长 tokenish）、RTL 隔离。

### 3.5 编辑与主题
- **pi-tui-editor.ts —— `CustomEditor`**（extends Editor）：在 pi-tui Editor 上追加快捷键回调（Alt+Enter/Ctrl+L/Ctrl+P/Esc/Ctrl+C/Ctrl+D/Enter/Backspace-on-empty），Enter 用 `getExpandedText()` 展开粘贴标记，autocomplete 显示时交给基类。
- **theme.ts**：亮/暗调色板（`palette=lightMode?lightPalette:darkPalette`），亮度/对比度自动探测（AGENT_THEME、COLORFGBG），导出 `theme` 对象（fg/assistantText/dim/thinking/accent/success/error/header/system/userBg/tool* 等）、`markdownTheme`、`selectListTheme`、`editorTheme`。

### 3.6 与模块外的依赖方向（ui/）
- 只依赖：`@earendil-works/pi-tui`（组件基类）、`chalk`（着色）、`memory/session`、`provider/model-channel-registry`（command-registry 的 /session /channel 动态子命令）、`logging/logger`。不含任何传输/渠道/协议依赖。

---

## 四、src/ui-protocol/ —— 前端协议层

### 4.1 定位：它是什么
`ui-protocol/` 是 **TUI 与 WebUI（及桌面端、未来渠道）同一套后端能力的"统一双向协议层"**。它不是终端渲染器，而是"传输中立、形态中立"的 RPC + 事件协议：

- 消息模型：`UiRequest{kind,id,method,params}`（UI→后端）、`UiResponse{kind,id,ok,result|error}`（后端→UI）、`UiEvent{kind,type,payload}`（后端→UI 推送）。`method` 命名空间 `<domain>.<action>`。
- 目标是让 **TUI 本地（InProc）、WebUI / 桌面端 / 远程 TUI（WebSocket）、未来渠道**共享同一套协议与后端能力；`UiWsSession`（WS 端）与 `UiProtocolSession`（进程内）复用同一装配链路。

结构：`index.ts`（统一出口）、`server.ts`（路由）、`adapter.ts`（UIAdapter 接口 + InProc 实现）、`transport/ws.ts`（WS 传输适配器）、`types.ts`（协议类型/常量）、`domains/`（19 个业务域）、`util/zip.ts`（最小 zip）、另有跨层中立事件契约 `src/events.ts`（types.ts 仅 re-export）。

### 4.2 server.ts —— `UiProtocolServer`（核心路由）
- `registerDomain(domain, handler)`：注册领域处理器。关键设计：**注册时用 `Object.keys(handler)` 快照方法表**（`methodTables`），只收录可枚举属性→冻结"协议方法面"契约；后挂的、不可枚举的生命周期方法（如 `config.dispose`）不进方法面，既不可被远程调用也不上报能力清单。
- `dispatch`：按 `method.<domain>.<action>` 拆前缀分发到快照方法表，未知域/未知方法/处理器异常 → 标准 `UiError`（UNKNOWN_DOMAIN/UNKNOWN_METHOD/INTERNAL_ERROR）。
- `attach/detach`：管理接入的 `UIAdapter`，消息自动进入路由；`emit/broadcast` 向指定或全部适配器推送事件。
- 内建 `meta` 域：`meta.get` 返回协议版本 + 已注册域 + 每域方法（能力协商）。

### 4.3 adapter.ts —— 传输边界
- `UIAdapter` 接口：`id`、`send(UiMessage)`（后端→UI）、`onMessage`（UI→后端）、`close`。协议服务器只依赖此接口，不感知具体传输。
- `InProcAdapter`：进程内双向内存交换（用于 TUI 本地与协议层单测），`connect` 互连、记录 `sent/received`；`createInProcPair` 创建已互连的 [client, server] 对。

### 4.4 transport/ws.ts —— WebSocket 传输
- `WsAdapter implements UIAdapter`：`WebSocket → UIAdapter`。JSON 编解码（二进制帧按 UTF-8 解析）、**ping/pong 心跳**（默认 30s 间隔/10s 超时，失联 terminate）、close/error/心跳清理（幂等）。
- `attachWsUpgrade(httpServer, options)`：在 `http.Server` 的 `upgrade` 事件上挂载 `<path>` 协议端点，可配 `authorize` 鉴权钩子；每个连接创建 `WsAdapter` 并 attach 到协议服务器。

### 4.5 types.ts —— 协议契约
- 三种消息形态、`UI_PROTOCOL_VERSION`、`UI_DOMAIN`（18 域命名常量：message/state/session/config/model/command/permission/kb/process/orchestrator/context/tool/bundle/mcp/plugin/companion/schedule/meta）、`UI_METHOD`（每方法常量表，P5-4 由 `index.test.ts` 的"常量同源守卫"与真实装配双向断言）。
- 业务数据类型（独立定义、与后端结构对齐）：`StateSnapshot`、`SessionMeta`、`HistoryMessage`、`ConfigChangeEvent`、`ConfigEntry`、`ModelChannel`、`LocalModelEntry`、`ScheduledTaskLike`、`ProviderSummary/ProviderStatus`、`CommandDef`、`PermissionRequestInfo/Result`、`KnowledgeBaseState`、`ProcessInfoLike`、`OrchestratorState` 等。
- re-export `UI_EVENT`（事件常量与 companion 事件载荷）from `../events.ts`。

### 4.6 events.ts —— 跨层中立事件契约（src/ 顶层）
`UI_EVENT` 定义后端→UI 推送事件：`ui.connected/ui.error`、`message.*`（text/thinking/tool_use/tool_result/diff/status/error/turn_start/turn_info/flush/interrupt/ask_user）、`state.update`、`config.change`、`model.change`、`session.change`、`permission.request`、`companion.say`、`companion.voice`。设计动因（P5-6）：事件是业务与 UI 共享契约，产生者既有协议层也有业务核心（companion.say 由 AgentLoop、companion.voice 由 TTS），独立成层避免 AgentLoop 反向依赖 UI 适配层；本层与 src/types.ts 平级、保持零依赖。

### 4.7 domains/ —— 19 个业务域工厂
每个域导出 `createXxxDomain(options): DomainHandler`，通过"结构化小接口"（真实后端类结构兼容）依赖后端能力，可独立测试、可替换实现。职责概览：

| 域 | 主要方法 | 依赖的后端（桥接层注入） |
|----|----------|--------------------------|
| config | get/getAll/set/merge/reset/schema；订阅 change 事件 | RuntimeConfigCenter（ConfigCenterLike，save 持久化）；dispose 不可枚举 |
| session | list/resume/create/delete/batchDelete/export/getLatest/switch | SessionManager + AgentLoop(switchSession)；export 用 util/zip 打包 |
| model | getActive/listProviders/switch/setThinking/listChannels/upsert/remove/setChannelModel/setChannelRole/sources/local* | ModelChannelRegistry + ProviderManager + LocalModelModule + loop.switchProvider |
| message | chat/stop/askUserResolve；`ProtocolOutputHandler` 把 OutputHandler 回调转事件 | AgentLoop + PendingRequestRegistry + historyProvider(events.jsonl) |
| state | get（StateSnapshot 组装 TurnInfo+路由+provider）/subscribe/unsubscribe | LoopLike + StatsManager |
| permission | resolve；`PendingRequestRegistry`（permission + ask_user 共用请求-应答表） | loop.onPermissionRequest/onAskUser |
| command | list/execute（后端生效命令委托 executor，UI-only 标 unsupported） | CommandRegistry + 注入 executor（createBackendExecutor） |
| kb | get/setEnabled/setZone4（双写对象开关+配置持久化） | KnowledgeBase + ConfigCenter |
| process | list/kill | BackgroundProcessRegistry |
| orchestrator | get/setEnabled | BypassManager（/orchestrator） |
| context | previewZone/manifest/setZoneEnabled | loop.previewContextZone + ManifestLike（载 ManifestLoader） |
| tool | list/toggle/bundles | ToolRegistry + ToolBundleRegistry |
| bundle | list/create/delete/activate/deactivate/addTools/removeTools | ToolBundleRegistry（持久化 json） |
| mcp | list/enable/disable/add/remove/reconnect（以配置文件为准） | MCPSystem |
| plugin | list（内核插件挂载状态，B-4） | loop.pluginHost.list() |
| companion | get/activate/deactivate/voices/voiceBind/voiceRegister/…. 切换流程与 companion_mode 工具逐行对齐 | ContextProfile(switchRouter) + CompanionSessionManager + VoiceLibrary/VoiceGenStore/SayHistoryStore/SceneReader（全部注入，协议层零业务依赖） |
| schedule | list/（写操作可选） | HeartbeatScheduler（loop.getScheduler） |
| meta（内建） | get（版本/能力协商） | 协议服务器自身 |

工具域还提供 `util/zip.ts` 的 `buildZip`（session.export 用，纯 Node deflate + 标准 ZIP 结构，零第三方依赖）。

### 4.8 与模块外的依赖方向（ui-protocol/）
- 被使用：`channels/builtin/ui-protocol-session.ts`、`channels/builtin/ui-ws-session.ts`、`channels/builtin/http-webhook.ts` 是主要生产装配方；`gateway/tui.ts` 以 InProc 方式把它接入 TUI 本地模式（与 WebUI 对称）。
- 向内引用：`orchestrator/loop`（OutputHandler/AskUserQuestion）、`memory/session`（SessionManager/StatsManager）、`runtime/config-center`、`provider/model-channel-registry`、`provider/config`、`local-model`（LocalModelModule 类型）、`hot-reload/manifest-watcher`、`tools/ask-user`、`companion/*`（voice-library/voice-store/say-history）、`generation`（scene dir）、`memory/events`（事件读取）、`events.ts`、`logging/logger`。均为"桥接层注入接口/闭包"而非协议层硬编码。

---

## 五、src/webui/ —— 浏览器端 WebUI

### 5.1 定位
纯静态前端资源，无后端逻辑，被 `http-webhook.ts` 通过 @fastify/static（`webuiRoot`）托管，通过 `/ui` 或 `/desktop` WebSocket 端点连接 ui-protocol 协议层。

文件：
- `index.html`（117KB）：单页入口，`<div id="app-shell">` 承载全部 UI，引入 `/theme.css`、`/app.css`、`/app.js`，加载 vendor 的 tailwind-browser.js 与 lucide.min.js；内含 tailwind `@theme inline` 主题变量（hyacinth-* 色彩变量）与 Telegram 兼容样式。
- `app.js`（135KB）：前端应用逻辑（JS/客户端渲染，对接 ui-protocol WS 协议：发起 request、接收 event、渲染聊天/设置/陪伴等界面）。
- `app.css`（23KB）+ `theme.css`（28KB）：应用样式与主题 CSS 变量。
- `vendor/`：第三方前端库（tailwind-browser.js、lucide.min.js 图标库）。
- `assets/`：静态资源——concept-art.svg（favicon）、rainy-study.svg、sample-audio.wav、video-poster.svg、`bg/`（主题背景图目录，README 说明按主题文件名放图即可自动作为最上层背景，2560×1440 横版、中央 60% 低对比构图）。

### 5.2 数据流（WebUI 视角）
浏览器加载静态资源 → JS 打开 `/ui`（或 `/desktop`）WebSocket → `WsAdapter` 接入协议服务器 → 前端发 `request`（chat/config/session/…）、收 `response` 与 `event`（message.text/thinking/state.update/companion.say 等）渲染界面。

---

## 六、贯穿数据流小结

1. **多渠道入站**：各渠道（TUI/HTTP WS/飞书/ClawBot）把用户消息规范化为 `ChannelMessageEvent` → `ChannelManager.onEvent` 回调 → `handler.handleMessage`（各渠道自管 session/AgentLoop/回复）。
2. **UI 协议出站**：凡走 ui-protocol 的界面（TUI 本地 InProc、WebUI/桌面/远程 TUI 的 WS），`ProtocolOutputHandler` 把 AgentLoop 回调转成 `message.*` 等事件广播给所有 UI；权限/ask_user 经 `PendingRequestRegistry` 转成带 id 的请求-应答。
3. **跨渠道借道**：任何会话里的 Agent 可调 `send_channel_message` 工具 → `MessageDispatcher` → 目标渠道 `handler.send()`，"纯借用"发送能力（不建 session、不写历史、不改渠道内部状态）。
4. **事件契约解耦**：`src/events.ts` 承载业务核心与 UI 共享的事件契约，`ui-protocol/types.ts` 只 re-export，保证依赖方向正确。

## 详细 业务机制

> 覆盖模块：machine（Flow 状态机引擎）、schedule（定时任务调度）、rollback（回合记录 + Git 逐回合回滚）、repair（自修复）、evolution（Git 封装）、dependency（依赖分析）。
> 本文档只描述结构（职责 / 类型 / 关系 / 数据流 / 依赖方向），不展示实现代码。

---

## 0. 模块关系总览

六个模块相对独立，各自通过少量"基础设施"依赖耦合：

| 模块 | 向外依赖的基础设施 | 说明 |
| ---- | ---- | ---- |
| machine | prompts/loader（loadPrompt）、logging/logger（createLogger） | 提示词外部化，状态机引擎无业务依赖 |
| schedule | setup/config（SystemScheduleConfig）、runtime/config-center（RuntimeConfigCenter） | 运行时动态改配置 |
| rollback | evolution/git-manager（GitManager）、tools/interface（Tool）、logging/logger | 依赖 evolution 提供的 Git 能力；以 Tool 形式注册 |
| repair | types（ToolCall） | 纯逻辑，仅依赖全局类型 |
| evolution | node:child_process（execFile） | 无项目内依赖，最底层 |
| dependency | evolution/git-manager（GitManager，可选）、utils/misc（toProjectKey） | 可选地借助 evolution 做增量更新 |

依赖层级大致为：evolution（最底层）被 rollback、dependency 消费；logging、prompts/loader 是被多数模块消费的基础设施。rollback 将自身封装成 Tool 供外部工具注册表消费。

---

## 1. src/machine/（Flow 状态机引擎）

### 1.1 目录构成（7 文件，975 行）

| 文件 | 职责 |
| ---- | ---- |
| machine/index.ts | 桶导出：重组导 type 与类 |
| machine/types.ts | 通用状态机类型定义（与业务无关的纯基础设施） |
| machine/runner.ts | MachineRunner 状态机执行引擎 + MachineRunnerState 序列化结构 |
| machine/registry.ts | MachineRegistry 注册表，管理多 Flow 生命周期 + flow-state.json 持久化 |
| machine/flows/types.ts | Flow 层类型：FlowController 统一接口 |
| machine/flows/todo.ts | TodoFlow：任务拆分 / 逐步执行状态机 |
| machine/flows/spec.ts | SpecFlow：需求规格 → 执行 → 验证状态机 |

分两层：
- 通用层（runner/types/registry）：不含 LLM 概念，纯事件驱动状态机 + 注册表。
- Flow 层（flows/）：在通用层基础上叠加 getInjection（Zone 5 上下文注入）、业务数据结构与文件解析。

### 1.2 通用层 — types.ts

核心概念全部为纯数据接口：
- `MachineContext`：状态机携带的任意数据（`[key: string]: unknown`），由 Flow 层定义具体结构（如 TODO 的 steps、stepIndex、task；Spec 的 specDir）。
- `GuardResult`：守卫返回值 `{ ok, reason? }`，reason 会通过工具返回值反馈给模型。
- `StateDef`：状态定义，含可选 `name/label`、`onEnter`/`onExit` 副作用（fire-and-forget）。
- `TransitionDef`：转移定义 `{ from(单或多), to, event, guard?, onTransition? }`，按定义顺序匹配（跳过 guard 不通过的）。
- `MachineDef`：状态机定义（纯数据无行为），含 `id/initial/states/transitions/terminalStates/onComplete`。
- `MachineStatus`：`'idle' | 'active' | 'completed'`。
- `HistoryEntry`：`{ from, to, event }` 单次转移记录。
- `MachineSnapshot`：对外只读视图（currentState、label、availableEvents、context、status、isTerminal、最近 20 条 history）。供 bypass agent 感知主线状态机，决定是否介入。
- `AdvanceResult`：advance() 返回值 `{ ok, reason?, to?, isTerminal? }`，ok=false 表示被拒绝。

### 1.3 通用层 — runner.ts（MachineRunner）

包装 MachineDef 的执行引擎，对外提供：
- 生命周期：`activate(ctx)`（合并上下文、重置历史、置 active、触发初始态 onEnter）、`deactivate()`（触发当前态 onExit、置 idle）。
- 核心推进：`advance(event)`。执行流程：找第一个 from 匹配且 event 匹配、且 guard 通过的 TransitionDef → 执行旧态 onExit → 执行 onTransition（同步）→ 更新 currentState → 执行新态 onEnter → 追加 history（超 20 条裁剪）→ 若达 terminalStates 则 status=completed 并异步触发 onComplete（失败不影响状态）。
- 查询：`getAvailableEvents()`、`getSnapshot()`、`isComplete()`。
- 持久化：`toJSON()` 返回纯数据 `MachineRunnerState`；`restoreState()` 从数据恢复，不触发任何副作用、清空重建 context。
- 上下文突变：`updateContext(patch)`（非转移操作，供 add_todo_step 在 planning 阶段累积 steps）。

辅助函数 `safeFire`：吞掉喂传入副作用（同步/异步）的所有异常，副作用失败不影响状态机。

`MachineRunnerState`：`{ machineId, currentState, status, context, transitionHistory }`。

### 1.4 注册表 — registry.ts（MachineRegistry）

管理多个 FlowController 的生命周期，同一时间只有一个 Flow 活跃（激活新 Flow 前自动停用当前活跃）。

- `register/get/getActive`：按 id 存取 Flow；getActive 仅当 runner.status==='active' 时返回。
- `activate(id, context)`：停用当前 → 激活指定 → 触发 save()。`deactivate()`：停用并 save()。
- `getContextInjection()`：Flow 状态对模型的唯一可见通道。活跃 Flow 返回其 getInjection() 步骤提示词；无活跃但刚完成时返回一条绑定本次 plan 的完成通知（防止模型误以为 flow 还在而反复调用 flow_complete 造成死循环）；否则返回空串。
- `consumePendingCompletion()`：消费并清空「最近完成 Flow」描述，一次性避免重复注入完成通知。
- 步骤完成回调：`onStepComplete()`（已标记 deprecated）、`onAdvanceSucceeded(flowId, isTerminal)`（推荐路径，advance 由 flow_complete 工具内部完成，此处只做 post-advance 清理：terminal 时记录 pendingCompletion 并置 activeId=null）。
- 持久化：`setPersistenceDir(dir)`（factory 在 sessionDir 确定后调用）。`save()` 写入 `flow-state.json`（无活跃 flow 或非 active → 删除文件，避免重启误恢复已完成的 flow；有活跃则写入 runner.toJSON()）。`load()` 在 session 确定、首次 run 之前由外部调用：读文件 → 解析校验（machineId/currentState 存在）→ 查 flow → `flow.runner.restoreState()` 纯数据恢复 → 置 activeId；文件损坏或 flow 未知则删除文件忽略。

注：registry 直接存储 FlowController（而非 MachineRunner），使 ContextSource 可直接取 getInjection() 免映射。

### 1.5 Flow 层 — flows/types.ts（FlowController）

所有 Flow 的统一接口：
`{ id, runner, activate, deactivate, advance, getSnapshot, getInjection, isComplete, addItem?(description) }`。
- getInjection() 返回字符串（Zone 5 注入文本）或 null。
- addItem 可选：TODO 加执行步骤、plan 模式加计划章节、spec 不需要。

### 1.6 Flow 层 — flows/todo.ts（TodoFlow）

两阶段状态机（id='todo'）：
- States：planning | executing | __completed__；Initial=planning；Terminal=__completed__。
- 转移表（按优先级）：
  1. planning + flow_complete → executing（guard：steps.length>0，onTransition 重置 stepIndex=0）
  2. planning + flow_complete → __completed__（guard：steps.length===0，无步骤直接结束）
  3. executing + flow_complete → executing（guard：还有更多步骤，onTransition 使 stepIndex++）
  4. executing + flow_complete → __completed__（guard：isLastStep，即 stepIndex+1>=steps.length）

关键设计：flow_add 是 context 突变（走 TodoFlow.addItem → runner.updateContext，不触发状态转移、绕过 guard）；flow_complete 是事件（触发 guard → 转移）。

- `addItem(description)`：仅 planning 阶段有效，生成 `todo-step-N` id，追加到 context.steps。
- `getInjection()`：planning 返回 planningPrompt（替换 {{task}}）；executing 返回 executionPromptTemplate（替换 {{task}}/{{current}}/{{total}}/{{description}}）；非 active 返回 null。
- 提示词通过 loadPrompt('flows/todo-planning') / loadPrompt('flows/todo-execution') 加载（外部化）。

### 1.7 Flow 层 — flows/spec.ts（SpecFlow）

三阶段状态机（id='spec'），Guard 通过解析 markdown 文件中 - [ ] / - [x] 判断进度：
- States：define | executing_tasks | executing_checklist | __completed__；Initial=define。
- 文件：`.agent/specs/{task}/tasks.md`、`checklist.md`（specDir 由 activate 时的 task 名输入卫生化生成）。
- 转移：
  1. define + flow_complete → executing_tasks
  2. executing_tasks self-loop（guard：tasks.md 含未完成项）
  3. executing_tasks → executing_checklist（guard：tasks.md 全部勾选）
  4. executing_checklist self-loop（guard：checklist.md 含未验证项）
  5. executing_checklist → __completed__（guard：checklist.md 全部勾选）
- 工具型辅助函数：`parseCheckItems`（解析 [ ]/[x]）、`firstUnchecked`（第一个未完成项）、`formatItemList`（条目列表格式化）、`specDir`（规约 spec 目录）。
- `getInjection()`：define 返回 spec-define 提示词；executing_tasks 返回含任务进度 `done/total` 与当前项的提示词；executing_checklist 类似展示验收进度。

### 1.8 machine 数据流

1. factory 确定 sessionDir 后调用 `registry.setPersistenceDir()`，随后首次 run 前调用 `registry.load()` 恢复上次未完成的 Flow 状态。
2. 模型回合中，工具（如 flow_add / flow_complete）通过 registry 获取活跃 Flow，调用 addItem / advance。
3. advance 驱动状态转移与 guard；terminal 时记录 pendingCompletion。
4. orchestrator 在下一轮注入前调用 `registry.getContextInjection()`，将 Flow 当前步骤提示词或完成通知注入模型上下文（Zone 5）。

### 1.9 machine 对外依赖

- `../../prompts/loader.js` 的 `loadPrompt`：loadPrompt 查找顺序 = 项目 .agent/prompts → 全局 ~/.agent/prompts → dist/prompts（外部优先），有内部缓存。
- `../logging/logger.js` 的 `createLogger`：注册表日志。
- 无对 rollback/schedule/dependency 等的反向依赖。

---

## 2. src/schedule/（定时任务调度）

### 2.1 目录构成（5 文件，1084 行）

| 文件 | 职责 |
| ---- | ---- |
| schedule/index.ts | 桶导出 |
| schedule/types.ts | 五类调度配置、任务、动作、记录、状态等类型 |
| schedule/cron.ts | CronExpression：5 字段标准 cron 表达式解析器 |
| schedule/persistence.ts | SchedulePersistence：tasks.json 持久化存储 |
| schedule/scheduler.ts | HeartbeatScheduler：心跳驱动调度器 + Random 策略实现 |
| schedule/schedule.test.ts | 调度器测试 |

### 2.2 类型层 — types.ts

- `ScheduleType`：`'interval' | 'cron' | 'daily' | 'fixed-time' | 'random'`。
- 五种调度配置：
  - `IntervalConfig`：intervalMs（间隔毫秒）。
  - `CronConfig`：expression（5 字段标准 cron，分 时 日 月 周）。
  - `DailyConfig`：time（HH:mm）。
  - `FixedTimeConfig`：runAt（ISO 8601，一次性）。
  - `RandomConfig`：periodMs（周期时长）、count（固定触发次数）、countRange?（min/max + distribution=uniform|extremes）、minIntervalMs?（最小间隔，防过近，默认 0）、timeWindow?（时间窗口，跨午夜用 end<start 表达）、timeWeights?（时间概率权重控制点数组：`{time, weight}`，控制点间线性插值，权重 1.0=基准）。
- `ScheduleConfig`：上述配置的联合类型。
- `TaskAction`：`{ type: 'callback'|'skill'|'command'|'scheduled', target, payload? }`。
- `ScheduledTask`：任务定义，含 id、name、scheduleType、schedule、action、enabled、mode?（normal|companion）、createdAt、lastRunAt、nextRunAt、runCount、errorCount、tags、periodStartAt?（random 当前周期起点）、pendingSlots?（random 本周期已生成未触发时刻列表）、channel?、sessionId?（多会话渠道如飞书回消息用）、fallback?（渠道降级链）。
- `TaskExecutionRecord`：单次执行记录（taskId、taskName、executedAt、durationMs、success、error）。
- `SchedulerConfig`：heartbeatMs（默认 5000）、maxConcurrent（默认 10）、taskTimeoutMs（默认 5 分钟）、maxRecords（默认 1000）、storagePath?、channelFallback?（全局降级链，默认 ['feishu']）。
- `SchedulerStatus`：running、startedAt、taskCount、enabledTaskCount、recentExecutions、uptime。
- `SerializedSchedulerData`：`{ version, tasks, records }`。

### 2.3 cron.ts（CronExpression）

- 解析 5 字段，字段支持：`*`（全部）、`N`、`N-M`（范围）、`N,M`（列表）、`step-N`（如 `*/N`、`N-M/N`）。
- 关键方法：
  - `next(from)`：从下一分钟起按分钟推进查找匹配时刻，最多迭代 525600 分钟（约一年），超时返回 null。
  - `nextN(from, count)`：多次执行时刻列表。
  - `matches(date)`：匹配检查；日与周若都不是全匹配则为「或」关系（dayOfMonth 命中或 dayOfWeek 命中其一即过）。

### 2.4 persistence.ts（SchedulePersistence）

- 存储路径默认 `~/.agent/scheduler/tasks.json`，可注入自定义路径（测试隔离）。
- 关键设计：`load()` 每次调用都重新读磁盘（不永久缓存内存副本），原因——多个 Agent 实例（TUI/Feishu/WebUI）共享同一 tasks.json，若缓存旧副本会在 save() 整文件重写时让其他实例删除的任务"复活"。
- API：`load/getAllTasks/saveTask/deleteTask/getTask/addRecord（自动裁剪 maxRecords）/getRecentRecords/clear`。

### 2.5 scheduler.ts（HeartbeatScheduler + Random 策略）

核心类 `HeartbeatScheduler`，职责：固定心跳间隔检查到期任务 → 计算下次执行时间 → 持久化 → 记录执行历史；支持五种策略。

- 注册：`setHandler(handler)` 注册 TaskHandler `(task)=>Promise<void>`。
- 配置：构造函数合并 DEFAULT_CONFIG + SystemScheduleConfig + 用户 config。`subscribeConfig(configCenter)` 订阅 `schedule.heartbeatMs`（变化时 restartHeartbeat）、`schedule.maxConcurrent`、`schedule.taskTimeoutMs`、`schedule.maxRecords`（RuntimeConfigCenter 动态改）。
- 生命周期：`start()`（去重同名任务保留最新、清理过期 fixed-time、重算 nextRunAt、补执行离线错过且 nextRunAt 距现在>30 分钟的任务、启动心跳 + 立即 tick）、`stop()`（清定时器、最多等 5 秒进行中任务完成）。
- 任务管理：addTask（同名自动更新而非新增，用 crypto.randomUUID 生成 id）、updateTask、deleteTask、getTasks/getTask、enableTask/disableTask（enable 重算 nextRunAt）、getRecentRecords。
- 跨实例同步：`getTasks()` 每次调用检查 tasks.json 的 mtime，若大于上次加载 mtime 则从磁盘重新加载（配 lastLoadMtime 追踪）。
- 心跳 `tick()`：筛出 enabled 且 nextRunAt<=now 的到期任务，受 maxConcurrent 限制逐条 executeTask。
- 执行 `executeTask(task)`：activeCount++ → Promise.race(runHandler, taskTimeoutMs 超时) → 记录成功/失败、runCount/errorCount/lastRunAt → **random 类型先 shift 已消费的 slot 再计算下次**（顺序关键，否则同一 slot 重复触发）→ calculateNextRun → 持久化任务 + 记录。
- 计算下次执行 `calculateNextRun(task)`：
  - interval：from(lastRunAt 或 now)+intervalMs，若早于 now 则取 now+intervalMs。
  - cron：new CronExpression(expression).next(now)，解析失败返回 null。
  - daily：取当天 HH:mm，若<=now 则推到下一天。
  - fixed-time：runAt 晚于 now 则返回，否则 null（一次性，过期不再执行）。
  - random：见下方专项。

### 2.6 Random 策略（scheduler.ts 底层函数 + 逻辑）

Random 在每个 `periodMs` 周期内随机生成 count（或 countRange 随机）个时间点（slots），成升序，依次触发。

- 周期滚动：以 periodStartAt 为原点，now 越过新周期则按整周期对齐滚动（不会逐周期累积漂移），并清空 pendingSlots 触发重新生成。
- 无有效 slot（count=0 或窗口为空）时跳到下一周期。
- slot 已过期则丢弃，全部过期则滚到下一周期。
- 模块级辅助函数：
  - `parseTimeOfDay(hhmm)`：HH:mm → 当天毫秒偏移。
  - `pickCountFromRange(range)`：uniform 均匀取整；extremes（U 形）40% 取 min、40% 取 max、20% 均匀分布于中间。
  - `buildWeightInterpolator(weights, effectiveStart, windowMs)`：把控制点映射到窗口相对偏移，返回 (msOffset)→weight 的线性插值函数；控制点跨天环绕处理。
  - `generateRandomSlots(cfg, periodStart, minInterval)`：确定触发次数（countRange 优先）→ 计算时间窗口有效区间（含跨午夜分支）→ 若窗口太小放不下则均匀降级 → 否则带权重拒绝采样（拒绝比例 w/maxWeight）生成随机偏移，过滤过近（<minInterval），排序转 ISO 字符串。

### 2.7 schedule 数据流

add_task 创建任务 → saveTask 持久化 → 心跳 tick 发现到期 → executeTask 执行 handler → 成功后按类型计算 nextRunAt → 记录 execution record → 保存。random 任务通过 periodStartAt + pendingSlots 在多次重启间保持周期连续性。

### 2.8 schedule 对外依赖

- 内部：cron.js、persistence.js、types.js、config（SystemScheduleConfig）。
- `../setup/config.js` 的 `SystemScheduleConfig` 类型（构造参数合并）。
- `../runtime/config-center.js` 的 `RuntimeConfigCenter`（只依赖其 `watch(path, cb)` 接口做动态配置订阅；返回 `configUnsubscribers` 数组）。
- 使用 node:crypto / node:fs / node:path / node:os。
- 无对其他业务机制模块的依赖。

---

## 3. src/rollback/（回合记录 + Git 锚点逐回合回滚）

### 3.1 目录构成（5 文件，504 行）

| 文件 | 职责 |
| ---- | ---- |
| rollback/index.ts | 桶导出 |
| rollback/types.ts | 回合 / 文件变更 / 回滚摘要类型 |
| rollback/turn-store.ts | TurnStore：环状缓冲区 + JSON 持久化 |
| rollback/turn-recorder.ts | TurnRecorder：回合生命周期追踪 |
| rollback/rollback-tool.ts | 两个 Tool 工厂：rollback_status + rollback |

术语：回合(Turn) = 用户一条消息 → 模型执行全部工具调用 → 模型回复；回滚(Rollback) = 撤销指定回合中模型做的所有文件变更。

### 3.2 类型层 — types.ts

- `ChangedFile`：`{ path（相对项目根）, action:'modified'|'created'|'deleted', oldContent? }`。
- `TurnRecord`：`{ turnId（全局递增）, timestamp, preCommit（回合开始前 git hash，非 git 仓库时空串）, changedFiles, commands }`。
- `RollbackStatusResult` / `RollbackStatusEntry`：当前回合、最大存储数、可用回合列表（contain 文件摘要）。
- `RollbackIndex`：环状缓冲区索引 `{ turns:number[]（升序）, lastTurnId }`。

### 3.3 turn-store.ts（TurnStore）

- 存储：`.agent/rollback/turn-{id}.json` + index.json；最多保留 20 个回合（MAX_STORED_TURNS），超限淘汰最旧。
- API：`save(record)`（写单个回合文件→更新索引→环状淘汰）、`load(turnId)`、`list()`（按 turnId 升序）、`deleteRange(fromTurnId)`（删除 fromTurnId 起的记录，回滚后清理）、`getDir()`。

### 3.4 turn-recorder.ts（TurnRecorder）

职责：在每个回合生命周期内自动记录文件变更。构造注入 `(gitManager: GitManager, turnStore: TurnStore, projectDir)`。

- 回合开始 `startTurn(turnId)`：若 git 仓库则（处理上一回合残留未提交变更的提示逻辑后）`gitManager.commit('auto: pre-turn-{turnId}')` 生成回滚锚点 + `git tag -f rollback-turn-{turnId}` 轻量 tag 便于查找；非 git 则 preCommit=''；初始化 currentRecord、清空 recordedPaths。
- 工具执行前 `recordPreState(absolutePath)`：在 write/edit/multi_edit 工具执行前调用；转为相对路径；用 recordedPaths 去重（只记首次拦截）；读旧内容存 oldContent（二进制读取失败则跳过）；action 按文件是否存在为 modified/created。
- `recordCommand(command)`：追加 bash 命令记录。
- 回合结束 `endTurn()`：先 `enrichFromGitDiff()` 用 `git diff --name-status <preCommit>` 补充检测遗漏文件（bash rm 等未被拦截操作），复用 recordedPaths 去重，状态码 M/A/D→modified/created/deleted、R/C→modified；然后写入 TurnStore，重置内部状态，返回记录。

辅助函数 `statusToAction`、`toRelativePath`（绝对→项目相对，规范化 /）。

### 3.5 rollback-tool.ts（两个 Tool 工厂）

实现 `Tool` 接口（tools/interface）注册为模型可用工具。工厂注入 (turnStore, gitManager, getCurrentTurn)。

- `createRollbackStatusTool`：查看可回滚回合列表（无参数）。列出每一回合的 ID、时间戳、文件数、命令数、文件摘要（前 3 个 + 更多计数），标注 current 回合，并提示 rollback({turns})。
- `createRollbackTool`：回滚最近 N 个回合（turns：1-10，默认 1）。流程：确定目标回合 targetTurnId=currentTurn-N+1 → 找最近的 ≤targetTurnId 的已存储记录（不足则提示最早的 ∎）→ 有 preCommit 则 `gitManager.resetHard(preCommit)` 精确恢复 + 删除被回滚回合的 rollback-turn-* tags → `turnStore.deleteRange(targetTurnId+1)` 清理缓存 → 构建报告（变更文件去重列表 + 提醒被回滚回合执行过的命令可能有副作用 + config 变更需手动检查）。非 git 仓库时明确报错：基于 Git 的回滚需要 git 仓库。

### 3.6 rollback 数据流

Through 一条生命周期：
TurnRecorder.startTurn（git 锚点）→ 各工具执行中 recordPreState / recordCommand（前置状态采集）→ endTurn（git diff 补全 + 落盘 TurnStore）。
用户或模型调用 rollback 工具 → 读取 TurnStore 找目标记录 → git reset --hard preCommit 恢复 → deleteRange 清理后续记录。

### 3.7 rollback 对外依赖

- `../evolution/git-manager.js` 的 `GitManager`（isRepo/hasUncommittedChanges/commit/git/resetHard）——direction：rollback 消费 evolution。
- `../tools/interface.js` 的 `Tool` 接口——rollback 以工具形式注册到外部工具注册表。
- `../logging/logger.js` 的 `createLogger`。
- node:fs / node:path。

---

## 4. src/repair/（自修复）

### 4.1 目录构成（3 货源文件 + 1 测试）

| 文件 | 职责 |
| ---- | ---- |
| repair/loop-guard.ts | LoopGuard：死循环 / 重复输出检测器（ToolGuard + TextGuard） |
| repair/storm.ts | 向后兼容层，re-export ToolGuard as StormBreaker / isMutating（deprecated） |
| repair/scavenge.ts | 会话垃圾清理：从 thinking/text 回收遗漏的工具调用 |
| repair/loop-guard.test.ts | LoopGuard 测试 |

### 4.2 loop-guard.ts

两层检测，每次用户输入时调用 reset() 清零计数，同一轮内累积检测；外部在每轮 runTurn 后检查 guardCount 超阈值则强制 stop。

- 常量：工具窗口 6 / 阈值 3；文本窗口 6 / 阈值 3、最短 30 字符、Jaccard 相似度阈值 0.90。`MUTATING_TOOLS`（write/edit/bash/delete/multi_edit）、`MCP_SIDE_EFFECT_KEYWORDS`（拟判断 mcp__ 工具是否有副作用）。
- `LoopGuardConfig`：tool/text 两组开关与参数 + exemptTools（工具豁免白名单）。`DEFAULT_LOOP_GUARD_CONFIG` 提供默认值。
- helper：`isMutating(name)`（内建变更工具名或 mcp 副作用关键词词边界匹配）、`argsSignature(input)`（排序键 JSON）、`wordJaccard(a,b)`（单词级 Jaccard 相似度）。
- `TextGuard`：检测 assistant 文本输出循环。`check(text)`：与窗口内前文比最大相似度；连续超过相似度阈值则 streak++，重点检测文本循环（streak>=threshold 返回 true）；`reflectionPrompt()` 静态返回反思提示词。
- `ToolGuard`（原 StormBreaker）：检测工具调用风暴（重复调用相同工具+相同参数）。`check(calls)`：exemptTools→仅记录不抑制；isMutating 工具→清空窗口（允许新变更序列）；同名同参数在窗口中达到 threshold-1 次则抑制（返回被抑制的 ToolCall id 集合），否则记录。`reflectionPrompt(call)` 返回反思提示。
- `LoopGuard`（统一门面）：组合 toolGuard + textGuard，持有连续触发计数 `guardCount` 与上限 `maxTriggers`（默认 5），`escalated` 判断是否达上限。`checkToolCalls` 供工具调用检查，`checkTextOutput` 供文本检查，均会在触发时递增 guardCount 并携带反思提示。
- `LoopGuardEvent`：'tool_storm' | 'text_loop'；`LoopGuardCheckResult` 汇总触发类型、被抑制 id、反思消息映射。

### 4.3 scavenge.ts（会话垃圾清理）

解决某些模型（如 DeepSeek R1）把完整工具调用 JSON 写进 thinking/reasoning 块却忘了在正式 tool_calls 声明的问题。

- `TOOL_CALL_PATTERNS`：多种 JSON 风格正则（name+arguments/input 对象、<tool_call>、<function=...>、json code fence）。
- 核心 `scavengeToolCalls(thinkingParts, textParts, existingCalls, allowedNames?)`：合并 thinking+text → 正则抽取 JSON 对象 → 校验 name 字符串 → allowedNames 白名单过滤 → 与 existingCalls/scavenged 双层去重（同 name+同参数）→ 生成新 id（scvg_ 前缀 + 参数长度 + 时间戳）并入返回合并数组。
- `isScavengeEnabled(config)`：默认开启（enabled!==false）。

### 4.4 repair 对外依赖

- `../types.js` 的 `ToolCall` 类型（唯一业务依赖）。
- 纯逻辑，无文件系统 / 外部服务依赖，因此可独立测试。

---

## 5. src/evolution/（Git 封装）

### 5.1 目录构成（2 文件，276 行）

| 文件 | 职责 |
| ---- | ---- |
| evolution/index.ts | 桶导出 GitManager 与 CommitInfo |
| evolution/git-manager.ts | GitManager：Git 命令封装 + 上下文检索 |

最底层模块，支撑回滚锚点、上下文条目等功能，无项目内依赖（仅 node:child_process 的 execFile）。

### 5.2 git-manager.ts（GitManager）

构造注入 repoPath，所有命令在此目录以 `git <args>` 执行（execFile + maxBuffer 10MB）。

- `git(args)`（底层公共方法，供 TurnRecorder 等外部使用）：执行并返回 stdout/stderr；失败时把 stderr 拆分为 error/warning/other，错误行保留、warning 按归一化模式去重聚合、其他行有上限截断，构造精简错误消息（最大 20k 字符截断）。
- 仓库与状态：`isRepo()`（rev-parse --git-dir）、`init()`、`hasUncommittedChanges()`（status --porcelain）。
- 提交与分支：`commit(message)`（add -A 后 commit，正则取 [分支 hash]），`createBranch/checkout/merge/abortMerge/deleteBranch/getCurrentBranch`。
- Diff 与日志：`diff(ref?)`、`diffNames(ref?)`（默认 HEAD~1）、`diffStat(ref?)`、`log(limit)`、`logFile(file)`、`logGrep(pattern)`（跨分支 + egrep + 解析 %D 的 branch/tag）。
- 变更恢复：`resetHard(ref)`（回滚用）、`revertCommit(hash)`、`stash()/stashPop()`。
- 上下文条目：`searchContext(keywords, currentBranch, limit)`：OR 逻辑把关键词合并为 grep 模式 → logGrep 找提交 → 每个提交 diffNames 取文件 → 组装 `GitContextEntry{hash(8位), message, date, branch, files}` → 同分支结果优先排序。供"上下文条目"数据源使用。
- 类型：`CommitInfo`（hash/message/date/branch）、`GitContextEntry`（+files）。
- `gitSafe`：不抛错的变体（内部辅助）。

### 5.3 evolution 对外方向

- 被 rollback（TurnRecorder/RollbackTool）与 dependency（incrementalUpdate 可选 git diff 判定变更文件）消费。
- 自身仅依赖 node:util/node:child_process/node:path。

---

## 6. src/dependency/（依赖分析）

### 6.1 目录构成（6 文件，757 行）

| 文件 | 职责 |
| ---- | ---- |
| dependency/index.ts | 桶导出 + initDependencyAnalyzer 初始化辅助 |
| dependency/types.ts | 依赖图 / 影响面类型 |
| dependency/parser.ts | DependencyParser：文件级 import/require/动态 import 解析 + 目录扫描 |
| dependency/function-parser.ts | FunctionParser：符号定义 / 被调用点 / 函数体范围解析（行级正则） |
| dependency/data-flow-tracker.ts | DataFlowTracker：变量数据流点追踪 |
| dependency/analyzer.ts | DependencyAnalyzer：图构建 / 缓存 / 增量更新 / 影响面查询 |

### 6.2 类型层 — types.ts

- `FileDependency`：`{ from, to（绝对路径）, importType:'static'|'dynamic'|'require', symbols[] }`。
- `DependencyGraph`（内存结构，含 Set/Map）：`{ rootDir, files:Set, dependencies:FileDependency[], dependents:Map<文件→它依赖的列表>, dependees:Map<文件→依赖它的列表> }`。
- `SerializedDependencyGraph`（持久化形式）：version、rootDir、builtAt、files[]、dependencies[]、dependents/dependees（Record）、fileHashes（相对路径→content hash，供增量检测）。
- `ImpactResult`：sourceFile、symbol?、directImpacts（深度1）、indirectImpacts（深度2+）、allImpacts（按深度排序）。

### 6.3 parser.ts（DependencyParser）

- `parseFile(filePath, rootDir)`：用三类正则分别抓静态 import（含 type/命名/默认/namespace 形式）、require（解构/变量）、动态 import；解析出导入符号；每条调用 `resolveModule` 解析相对路径并附加 importType。
- `resolveModule(modulePath,...)`：只解析 `./` `../` 相对路径；尝试 .ts/.tsx/.js/.jsx 后缀 → 尝试 index 文件。
- `scanFiles(dir)`：递归扫描 .ts/.tsx/.js/.jsx（跳过 .d.ts），跳过 node_modules/dist/.git/coverage。

### 6.4 function-parser.ts（FunctionParser）

基于行级正则的轻量语义分析（非完整 AST）：
- `FunctionDef`：name、file、line、kind（function/method/arrow/class/interface/type）、signature、isAsync、isExported。
- `CallSite`：name、file、line、text、receiver?、isNew。
- `findDefinitions(symbol, files)`：定位指定符号定义（含 function/class/interface/type/arrow/method 六种识别）。
- `findCallees(functionName, file)`：找到函数定义起始行 → 抽取其花括号块 → 解析块内每行的函数调用（`name(` 或 `receiver.name(` 调用、`new Name(` 构造）→ 去重（name:line）。
- `findFunctionBodyRange(functionName, file)`：返回函数体 startLine/endLine。
- 内部支持：`extractBlock`（花括号配对，处理字符串/模板/注释/注释块）、`parseLineForDefinition`、`parseLineForCalls`（KEYWORDS 集合过滤语言关键字/内建对象如 console/process/Math/JSON 等误判）。

### 6.5 data-flow-tracker.ts（DataFlowTracker）

- `DataFlowPoint`：`{ file, line, kind:'declaration'|'assignment'|'read'|'argument'|'return'|'destructuring', text, context[] }`。
- `trace(variableName, file)`：行级正则对每行分类，输出最多 50 个点（常数 MAX_RESULTS）；跳过注释行；分类优先级：destructuring > declaration > return > assignment > argument > read；context 每侧取 2 行（CONTEXT_LINES）。

### 6.6 analyzer.ts（DependencyAnalyzer）

- 缓存：`~/.agent/cache/dependency-graph.json`，CACHE_VERSION=1，版本不符自动失效；fileHashes 用 content hash（md5 12 位）做增量更新检测。
- `analyze(rootDir)`：优先 loadCache（需 rootDir 匹配）→ deserialize；否则 fullBuild。
- `fullBuild()`：scanFiles → 逐文件 parseFile → 收集 fileHashes → buildIndexes → saveCache。
- `incrementalUpdate(changedFiles?, gitManager?)`：可选经 gitManager.diffNames('HEAD~1') 取变更文件；过滤实际哈希变化的文件；移除旧 from 边 → 重新解析 → 引入可能的 to 新文件 → buildIndexes → saveCache。
- `buildIndexes`：构造 files Set、dependents（from→to 去重）、dependees（to→from 去重）。
- `getImpact(file, symbol?)`：BFS 沿 dependees（反向边）传播，depth0 为 directImpacts、depth>0 为 indirectImpacts；若给 symbol 则只统计该 import 边确实包含该符号的依赖；带 visited 去重；路径反斜杠规一回 "/"。
- 序列化/反序列化：`serialize()` / `deserialize()`（Set↔[]、Map↔Record 互转）。
- 辅助：`contentHash`、`getCachePath`、`toProjectKey`（来自 utils/misc）。
- index.ts 提供 `initDependencyAnalyzer(rootDir)`（封装 analyze、异常时返回 undefined）供 CLI/TUI 调用。

### 6.7 依赖分析数据流

入口 initDependencyAnalyzer(rootDir) → analyze 走缓存或全量构建 → CLI/TUI 查询 getGraph / getImpact / incrementalUpdate（借助 GitManager diff）。符号级：FunctionParser 定位定义/被调用点，DataFlowTracker 追变量数据流，三者共同支撑影响面分析。

### 6.8 dependency 对外依赖

- `../utils/misc.js` 的 `toProjectKey`（生成项目缓存键）。
- `../evolution/git-manager.js` 的 `GitManager`（可选，incrementalUpdate 时判断变更文件）——direction：dependency 消费 evolution。
- node:fs / node:path / node:os / node:crypto。

---

## 7. 关键耦合点与设计一致性

- **evolution 是最底层**：不依赖任何业务机制模块，被 rollback 与 dependency 双向消费（rollback 依赖其为回滚锚点能力；dependency 可选依赖其做增量变更检测）。
- **外部化原则（收益于 设计哲学 §2.1）广泛体现**：machine 的 Flow 提示词、schedule 的心跳/并发/超时参数、repair 的检测窗口阈值均通过配置/提示词文件外部化。
- **跨实例一致性设计**：schedule 的 SchedulePersistence 每次重读磁盘、HeartbeatScheduler 用 mtime 检测外部修改，避免多渠道实例互相覆盖。machine 的 flow-state.json 在删除/损坏/未知类型时安全降级。
- **面向模型的可观测通道**：machine 的 getContextInjection / 快照，repair 的反思提示词（[LoopGuard] 前缀规避 injection-filter），rollback 的可读报告，均以"给模型看信息"为目标。

## 详细 元认知层与子 Agent

> 本文为纯结构说明：只描述每个关键文件的职责、关键类/接口/函数、它们之间的关系、数据流，以及模块间的依赖方向。不展示代码片段（除极少数关键符号名/签名，仅供定位）。
>
> 覆盖范围：`src/bypass/`（含 `agents/` 与 `agents/orchestrator/`）、`src/agents/`、`src/world-engine/`、`src/companion/`（5 个非测试文件）。并对照 `src/plugins/`、`src/gateway/bypass-wiring.ts`、`src/orchestrator/loop.ts` 等外部集成点给出依赖方向。
> 结论基于对上述每个文件的逐字阅读，非臆测。

---

## 0. 四模块全景与纵览

本批四个模块构成 Hyacinth 的「旁路智能体（元认知层）+ 子Agent 委托 + 世界模拟 + 陪伴表达」横向家族。按内置的两条红线组织：

- **元认知安全红线**（`bypass/base.ts` 头部）：旁路智能体运行在主循环的 preTurn/postTurn，结果直接注入主 Agent 上下文，出错即带偏主 Agent，是**风险最高的一层**。因此其工具被严格限制为「极其专一化」的窄工具（`memory_*`/`inject_hint`/`cluster_assign`/`world_*`），强制禁止 bash/read/write/edit/http_request 等通用工具。此红线约束落在 `orchestrator`、`world-engine`、`bypass` 三个层面重复声明。
- **模块化自包含原则**：world-engine 是一个独立功能模块，经 bypass 插件的 register 能力「挂靠」旁路体系，而不是硬编码进去；companion 是纯表达层，不持有世界状态。

模块间关系一句话：
- `bypass` 定义旁路智能体基座与调度器（BypassAgent 接口 / BypassAgentBase / BypassManager）。
- `orchestrator`（在 bypass/agents 内）与 `world-engine`（独立模块）都实现 `BypassAgent` 并注册进 `BypassManager`，由它统一启停与 preTurn/postTurn 调度。
- `world-engine` 是陪伴模式的世界模拟：状态存储 WorldStore、时间/天气/NPC 推进 WorldTicker、动态对象演化 sim.ts、工具面 WORLD_TOOLS、旁路智能体 WorldEngine。
- `companion` 是陪伴模式的表达层（台词规范化 / 台词历史 / 音色库 / 生成语音库 / 语音合成），**不依赖 world-engine**；它由 loop.ts 与 companion Router、companion_say 工具驱动，服务于「把陪伴角色的台词说/写出来」，而世界状态由 bypass 侧的 WorldEngine 维护——两模块通过「同属陪伴模式、各自产出一个注入环/一个表达链」横向协作，不互相 import。

依赖方向（从外到内，符合零侵入可插拔哲学）：
- 元认知基座：`base.ts` <- `types.ts`（接口）；`manager.ts` -> `base.ts`/`types.ts`；具体的旁路智能体（orchestrator、world-engine）-> `BypassAgentBase`/`BypassManager`。
- 挂载回主系统：`gateway/bypass-wiring.ts` -> `plugins/bypass-plugin.ts` -> `bypass/manager.ts`；`plugins/world-engine-plugin.ts` 依赖 `bypass.manager` 服务键。
- 数据/存储层（world-engine 内部）：`agent.ts` -> `store.ts`/`ticker.ts`/`tools.ts`/`types.ts`；`ticker.ts` -> `store.ts`/`sim.ts`；`tools.ts` -> `store.ts`。
- companion 内部：`voice.ts` -> `voice-store.ts`/`voice-library.ts`；`loop.ts` -> `say-history.ts`/`voice.ts`。companion 对外的共同依赖是 `events.ts`（UI 事件契约）与 `generation/`（TTS 生成）。

---
## 1. `src/bypass/` —— 旁路智能体（元认知层）基座

四个文件 + 一个子目录（`agents/`）。职责定位：旁路智能体**独立于主 Agent 运行的后台观察者**，在主对话流前后介入——`preTurn` 产出注入内容（compose 之前），`postTurn` 观察并更新内部状态。与主 Agent 的差异（文件中明确声明）：独立模型通道（不抢主 Agent 上下文预算）、异常隔离（任何错误不影响主流程）、状态持久化（跨轮保持内部状态）。

### 1.1 `src/bypass/types.ts` —— 接口与数据结构契约
零业务逻辑，只定义旁路体系对外/对内共享的类型。关键类型：
- `PreTurnContext`：preTurn 输入，含 `userInput`、`recentHistory`（最近 N 轮原始消息）、`contextBudget {used,total}`、`recentToolCalls`、`sessionId`。
- `PostTurnContext`：postTurn 输入，含 `userInput`、`assistantOutput`、`history`、`toolCallsThisTurn`、`isLastIteration`（是否 loop 最后一次迭代）、`sessionId`、`fullArchiveLineCount`（conversation_full.jsonl 行数，供簇归类定行号范围）。
- `Injection`：注入到上下文 section 的结构，字段 `section`/`content`/`role`（system|assistant|user）/`mode`（replace|append）。
- `PreTurnResult`：preTurn 返回，含 `transformedInput?`（WorldEngine 剥离 `[[...]]` 用）、`injections[]`、`intent? {capability, confidence}`（orchestrator 产出，供 AgentLoop 做意图簇过滤）。
- `BypassAgent`：旁路智能体接口，只读字段 `name`/`modes`（如 `['companion']` 或 `['*']`）/`modelChannel`；生命周期 `start()`/`stop()`；可选钩子 `preTurn?`/`postTurn?`。

### 1.2 `src/bypass/base.ts` —— BypassAgentBase 基座
提供所有旁路智能体的通用能力，声明本模块的最高安全红线。关键点：
- 顶部大段 **安全红线注释**：旁路智能体 = 元认知层；只允许专一化窄工具；禁止通用工具；新增工具前的「三问自问清单」；并特别澄清「输入是被动的」——旁路智能体上下文由主 Agent 通过 ctx 注入，工具只用于输出侧（写外部文件时才调用）。
- `ProviderLike` / `ModelRouterLike`：结构化接口，只依赖创建流的 `createStream(messages, tools?, signal?)` 与按 role 取 Provider 的 `getProvider(role)`，不耦合具体 provider 实现。
- `BypassAgentConfig`：子类提供的配置，含 `name`/`modes`/`modelChannel`/`tools`（工具定义列表，重审窄工具红线）/`executeTool(name, input)`（工具分发器）。
- 类 `BypassAgentBase implements BypassAgent`：抽象类。字段 `tools`（protected）、`modelRouter`（protected）、`_manager`（BypassManager 引用，由 register 注入）。方法 `setModelRouter()`、`getProvider()`、`callLLM(systemPrompt, userPrompt)`（单次 LLM 调用、无工具循环、try/catch 吞错返回空串）、`callLLMWithTools(systemPrompt, userPrompt, maxIters=5)`（带工具循环：LLM->并行执行工具->结果喂回->直到无工具调用或达上限；同样吞错）。两个调用都「旁路失败不影响主流程」。

### 1.3 `src/bypass/manager.ts` —— BypassManager 调度器
管理所有旁路智能体的注册/启停/调度，由 Loop 在每轮对话前后调用。职责：
- 内部结构：`registry`（Map name->agent）、`active`（当前激活列表）、`modelRouter`（共享引用）、`_pendingInjections`（运行时注入队列）。
- 生命周期 API：`setModelRouter`（注入并传播给所有已注册 agent）、`register(agent)`（并注入 `_manager` 引用）、`unregister`、`activateForMode(modeName)`（先停用全部，再按 modes 匹配 `'*'` 或指定模式启动）、`activateAgent`/`deactivateAgent`/`deactivateAll`（TUI 命令用）、`isActive`、`getAgent`（用于直取 Agent 特有方法，如 orchestrator 的 `lastClusterAssign`）、`getActiveNames`。
- 注入通道：`inject(agentName, injection)`（按 section 去旧存新）与 `consumeInjections()`（Loop 在 compose 前调用消费清空）。
- 调度钩子：
  - `preTurn(ctx)`：**阻塞**，顺序遍历活跃 agent 调用其 preTurn，收集所有 injections；`transformedInput` 取最后一个非 undefined；**orchestrator 是意图的权威来源**（`agent.name === 'orchestrator'` 且返回 intent 时才采纳）；单 agent 失败仅告警不中断。
  - `postTurn(ctx)`：`Promise.allSettled` 并行调度所有 agent 的后台观察，不阻塞主流程，逐个 try/catch。

### 1.4 `src/bypass/index.ts`
薄导出壳：re-export types 与 `BypassAgentBase`/`BypassManager`、相关配置类型。

### 1.5 安全红线的落实方式（本模块跨三层重复声明）
`index.ts`、`base.ts`、`manager.ts`、`orchestrator/index.ts`、`world-engine/agent.ts` 均在头部重复同一段安全声明。其工程含义：这是**约定 + 代码注释自约束**层面的红线，靠「工具面只装窄工具 + manager/loop 不把旁路工具放进全局注册表」来落地——具体旁路智能体的工具集是显式传入的（`ORCHESTRATOR_TOOLS`、`WORLD_TOOLS`），绝不经全局 tool registry 暴露给主 Agent 或旁路智能体。

---
## 2. `src/bypass/agents/orchestrator/` —— ContextOrchestrator（普通模式旁路智能体）

单文件 `index.ts`（约 41KB，本批最小单元中逻辑最重的一个）。实现类 `ContextOrchestrator extends BypassAgentBase`，维护主 Agent 的记忆文件，普通模式（modes=['normal']）下运行。职责三件套：
- preTurn：意图识别 ->（必要时）调 `inject_hint` 工具注入提醒。
- postTurn：观察对话 -> 偏离纠偏（inject_hint）+ 记忆维护（memory_*）+ 簇归类（cluster_assign）。
设计原则（文件注释）：显式工具调用注入（不依赖隐式返回值解析）、沉默是默认（无价值不注入不写入）、异常隔离。

### 2.1 提示词体系（六套角色剧本）
- `PRETURN_SYSTEM`：「元认知层」，输出 `[CAPABILITY: coding|chat|tool_use|reasoning|general]` + `confidence: 0.X` + 意图分析文本；仅当记忆约束与当前操作直接相关才调 inject_hint；大多数时候不注入。
- `POSTTURN_SYSTEM`：「记忆维护者」，只记真正底层/跨会话的约束（用户行为偏好、工作习惯、环境约束）；先 `memory_search` 去重再写；高门槛，宁可不记。
- `REVIEW_SYSTEM`：「监督者」，审查主 Agent 本轮回复是否偏离原定意图；意图为空则直接 OK；仅审查文本，工具调用本身不算偏离；偏离时常调 inject_hint 注入纠正。
- `CLUSTER_SYSTEM`：「会话归档员」，判断本轮归入已有簇还是新建簇，调 cluster_assign；不确定宁可新建簇。
- `BACKFILL_SYSTEM`：「历史归档员」，对早期未分类历史补做归类，严格一行输出 `cluster_id=... capability=... summary=...`；无法归类则 `legacy_general/general/早期历史杂项`。

### 2.2 工具面（白名单）—— `ORCHESTRATOR_TOOLS`
6 个工具，全部是只读写本 Agent 自己记忆文件的窄工具：
- `inject_hint(text)`：向主 Agent 上下文注入一条提醒（写 Zone 5 Live 区），仅直接相关时调用。
- `memory_add(text)` / `memory_update(old_text,new_text)` / `memory_remove(text)` / `memory_search(query)`：记忆文件的增改删查，先 search 去重。
- `cluster_assign(cluster_id, summary)`：将本轮归入意图簇，cluster_id 用英文下划线命名。
这些工具**绝不允许扩展为通用工具**（bash/read/write/edit/http_request）。

### 2.3 记忆文件操作
`readMemory`（按 `- ` 前缀解析内存文件为字符串数组）、`writeMemory`（写回 `- ` 行格式）、`searchMemory`（大小写不敏感包含匹配）、`createMemoryExecutor`（返回一个按 tool name 分派的 async 执行器，实现 memory_* 五个 case）。

### 2.4 内部状态结构
- `ClusterIndex`：簇索引条目（id/capability/summary/line_start/line_end）。
- `BypassContext`：每 session 的运行时状态，含 `intent`/`capability`/`confidence`/`iterationCount`/`consecutiveDeviations`/`lastInjectionIteration`/`clusters`/`backfilledUpto`。
- 多 session 隔离：`_sessions` Map + `_defaultCtx`（无 sessionId 时用）；上限保护 `MAX_SESSIONS=100`；用常量正则 `SESSION_ID_RE`/`CLUSTER_ID_RE` 做安全校验（白名单字符集与长度）。
- 关键半公开通道字段：`lastClusterAssign`（最近一次簇归类结果，loop.ts 消费后写 events.jsonl + markCluster）、`_pendingClusterCtx`（cluster_assign 工具调用时的上下文，LLM 调用前设置、工具内部消费后清空）。

### 2.5 核心流程
- `preTurn(ctx)`：取 session ctx -> 重置迭代状态 -> 读记忆 -> 组近 8 轮对话与用户输入 -> `callLLMWithTools(PRETURN_SYSTEM, ..., 3)` -> `parseIntentCapability` 解析结构化意图（正则提取 capability/confidence，白名单归一）-> 存 sc -> 返回 `{ injections:[], intent:{capability,confidence} }`（注入已由 inject_hint 工具完成，故这里不重复返回）。
- `postTurn(ctx)`：`iterationCount++`；若 `isLastIteration` -> `reviewAndRemember`（审查 + 记忆写入 + 簇归类），否则 -> `reviewOnly`（仅纠偏审查）。
- `reviewOnly`：组 prompt -> `callLLMWithTools(REVIEW_SYSTEM, 2)`；verdict 为 OK 则清零偏离计数；否则 `consecutiveDeviations++`，当 `shouldInject`（偏离>=2 且距上次注入>=3 轮冷却）成立时截取 correction 调 `_handleInjectHint` 写 `[纠正]...`。
- `reviewAndRemember`：读记忆 -> 判断是否有值得长期记住的信息并调 POSTTURN 工具 -> 若 `fullArchiveLineCount>0` 则 `classifyCluster`。
- `classifyCluster`：(a) 从 `~/.agent/sessions/{sessionId}/cluster-index.json` 读已有簇索引；(b) 以注入的已有簇 + 当前意图 + 本轮输入/回复组 prompt；(c) 设置 `_pendingClusterCtx` + 置空 `lastClusterAssign`；(d) `callLLMWithTools(CLUSTER_SYSTEM, 2)`，模型在调用期间经 `_handleClusterAssign` 直接写盘；(e) 若无工具但文本中出现 `cluster_id=`，走**正则回退路径**补写盘。两条路径都更新 `lastClusterAssign` 并同步内存簇索引。
- `_handleClusterAssign`（工具实现）：白名单校验 cluster_id -> 校验在 `_pendingClusterCtx` 上下文内 -> 防同轮重复（lastClusterAssign 已设置则拒绝）-> `_writeClusterFiles` 写 `cluster-index.json` + `summaries/cluster_{id}.md` -> 设 `lastClusterAssign` -> 清空 `_pendingClusterCtx`。

### 2.6 写盘与行号
- `_writeClusterFiles`：写 `cluster-index.json`（合并/新建条目，新簇 line_start 取 `max(1, lineEnd-5)` 估算）与 `summaries/cluster_{id}.md` 初始摘要。
- `_writeFile(sessionId, relPath, content)`：落到 `~/.agent/sessions/{sessionId}/{relPath}`，是簇相关文件的唯一写入点。
- `_updateMemoryClusters`：与文件同步更新 BypassContext 内的簇索引。
- 历史回填（方案 A）—— `backfillUnclassified(sessionId)`：orchestrator 开启晚时对早期未分类历史补归类。**幂等设计**：基于 `BypassContext.backfilledUpto` 增量扫描，只处理无 `_cluster_id` 标记的连续块；单批最多 30 条消息控制 LLM 成本；LLM 正常时兜底归 `legacy_general`（方案 E）；失败静默跳过。直接写 `cluster-index.json`（同簇合并取最小 line_start / 最大 line_end）与摘要文件，**不使用 lastClusterAssign 通道**（避免与本轮归类冲突），返回结果数组供 loop 消费 markCluster。辅助 `getBackfillUpto(sessionId)` 供 loop 预判是否需真正回填。

### 2.7 对 loop.ts 的耦合（意图权威 + 簇消费）
`loop.ts`（1030-1230 行）明确：
- `manager.getAgent('orchestrator')` 直取实例读 `lastClusterAssign`，带跨 session 污染防护（`ca.session_id !== currentSessionId` 则丢弃）；有效则写 events.jsonl（`cluster_assign` 事件）+ `conversationStore.markCluster` 打 `_cluster_id` + `maybeCompressCluster`（分簇压缩）。
- 仅当 `isActive('orchestrator')` 时才调 `backfillUnclassified`（避免未激活时阻塞 LLM）。
- `loop._currentIntent` 由 bypass 的 preTurn 返回的 intent（`bt.intentLabel`）驱动，作意图簇过滤。

---
## 3. `src/agents/` —— 子Agent 委托系统

五个文件（含一个 registry 重导出壳）。职责：主 Agent 通过 `delegate_to_agent` 工具把任务委派给**独立上下文/独立工具集/独立 Provider 的隔离工作单元**（子Agent），支持 delegate/adversarial/parallel 三模式 + 异步后台 + 会话复用。

### 3.1 `src/agents/index.ts`
薄导出壳：re-export `AgentRegistry`/`createBuiltinAgents`/`DelegateToAgentTool`/`createSubAgentLoop`/`destroySubAgentSession`/`interruptSubAgentLoop`/`registerRunningLoop`/`unregisterRunningLoop`/`loadAgentConfigs`。

### 3.2 `src/agents/registry.ts`
仅一行：re-export `AgentRegistry` from `../registry/agent.registry.js`。真正的 AgentRegistry（持有 AgentDefinition -> get/getAll/getByInstanceId/create 等）位于 registry 模块，本文件只是委派系统的类型/入口透传。

### 3.3 `src/agents/builtins.ts` —— builtin 子 Agent 定义
`createBuiltinAgents(config?)` 返回默认 `AgentDefinition[]`（fallback 用），内含三个：
- `code-reviewer`：代码审查专家，allowedTools=[read,glob,grep]，maxTurns=10，adversarial。
- `security-auditor`：安全审计专家，同工具面，adversarial。
- `test-writer`：测试编写专家，allowedTools=[read,write,glob,grep,bash]，maxTurns=15，delegate。
systemPrompt 来自 `loadPrompt('agents/<name>')`；`config?` 可按 name 覆写 maxTurns/allowedTools/collaborationMode。

### 3.4 `src/agents/config-loader.ts` —— 子 Agent 配置加载
`loadAgentConfigs(cwd, configOverride?)` 按优先级加载 `agents.json`：`AGENTS_CONFIG_PATH` 环境变量（最高）> 项目级 `.agent/agents.json` > 全局 `~/.agent/agents.json` > 内置 builtins fallback；后加载同名覆盖先加载。`AgentConfigEntry` 结构含 name/description/promptFile/allowedTools/maxTurns/collaborationMode/modelPreference?/sessionTtlMinutes?。逐条经 `loadPrompt(entry.promptFile)` 编译 systemPrompt，循环充入 `AgentDefinition`。辅助 `loadJsonConfig`。

### 3.5 `src/agents/delegate-tool.ts` —— 委托核心（约 28KB，重头）
两层组织：**模块级运行管理** + **DelegateToAgentTool 工具**。

模块级状态与管理函数：
- `ProgressEvent` 类型（text/tool_call/tool_result/turn/status）。
- `SubAgentContext`：父 Agent 委托子 Agent 所需的注入环境，含 modelRouter/toolRegistry/sessionDir/maxContextTokens/dependencyAnalyzer?/onProgress?/sandboxRoot?（设置后 read/write/edit/grep/glob 被限制、bash 禁用）/`createSubProvider(userId)`（创建独立 userId 的 Provider，子Agent 间及与主Agent 的 KVCache 隔离）/`pendingAsyncResults?`（主 loop 的异步结果推送队列）。
- `runningLoops` Map + `registerRunningLoop`/`unregisterRunningLoop`/`interruptSubAgentLoop`（按 instanceId 定位，调 `loop.interrupt()`）。
- 异步任务注册表：`AsyncSubAgentTask` 接口 + `asyncTasks` Map + `registerAsyncTask`（返回 `sub_001` 风格 handle）/`completeAsyncTask`/`failAsyncTask`/`listAsyncTasks`/`getAsyncTask`/`waitForAsyncTasks`（优雅关闭，轮询等待运行中任务）。
- `destroySubAgentSession`：删 `{parentSessionDir}/sub-agents/{instanceId}` 目录。

核心 `createSubAgentLoop(agentDef, task, parentContext)` —— 创建或复用子 Agent 的 AgentLoop：
- instanceId 缺省 `${name}-default`；session 目录固定在 `sub-agents/{instanceId}`，多次 delegate 复用同一 session（保留完整对话历史）。**并发保护**：同一 instanceId 已有活跃 loop 时抛错，迫使用职权化为 spawn_sub_agent 克隆实例。**TTL**：读 meta.json 的 createdAt，超过 `sessionTtlMinutes`（默认 10）则清理重建；复用 session 时更新 mtime 重置 TTL 倒计时。
- 装配步骤：FilteredToolRegistry（按 allowedTools 过滤）-> 若有 sandboxRoot 则包 `createSandboxedTool` -> 独立 `LayeredContextComposer` + `registerPromptSection('sub-agent-role', priority:0, content: systemPrompt, {{task}} 已替换)`（结构化输出追加 JSON schema 指令）-> 独立 ConversationStore/EventStore/StatsManager/SummaryStore -> `ToolExecutor(过滤注册表)` -> `createSubProvider(subAgentUserId(name, instanceId))` 独立 Provider -> TokenCounter/ModelRouter/StructuredSummarizer/CompressorOrchestrator 复用主 Agent 路由做压缩 -> PlanStore/LLMOrchestrator -> 静默 OutputHandler（有 onProgress 则转发，权限请求一律自动批准 `'yes'`）-> `new AgentLoop({...},{sessionDir,maxTurns,maxContextTokens})`（**不使用 Skill/MCP**）。
- 返回 `{loop, sessionDir, isNew}`。

`DelegateToAgentTool implements Tool`：
- `name='delegate_to_agent'`，inputSchema：agent_name?/instance_id?/task(必填)/context?/async?(默认 false)/across_turns?（异步结果是否允许跨 turn；false 时结果自动注入当前回合）。
- `execute`：解析 agent（优先 instanceId）-> 异步模式仅支持 collaborationMode='delegate'（adversarial/parallel 需逐个 spawn + 各自 async=true 委派）-> 按模式分派：
  - `executeAsync`/`runAsyncInBackground`：registerAsyncTask -> 后台跑 loop，完成后 `completeAsyncTask`，非 across_turns 则推送 `pendingAsyncResults`（当前回合结果自动注入）。
  - `executeDelegate`：同步阻塞，single agent，收集结果。
  - `executeAdversarial`：找 `collaborationMode==='adversarial'` 且不同名的对抗方；两者各自独立跑同一任务，综合两方视角输出。无对抗方则退化为单 Agent 审查。
  - `executeParallel`：所有 parallel 模式子 Agent `Promise.all` 并行执行，逐项收集摘要合并列出。<=1 个时退化为 delegate。
- 结果收集：`collectAgentResult` 直接读 `sub-agents/{instanceId}/conversation.jsonl` 解析——跳过 LoopGuard/Storm suppressed 注入消息统计轮次；追踪 tool_use 中的 write/edit/bash 记录 filesModified；summary 取最后一条 assistant 文本。`collectConversationSummary`/`collectResult` 是其上层封装。

### 3.6 依赖方向
- `agents/delegate-tool.ts` 大量依赖内核：`orchestrator/loop`（AgentLoop）、`context/composer`、`context/compressor`、`context/tokenizer`、`tools/filtered-registry`、`tools/path-sandbox`、`tools/executor`、`memory/*`（conversation/events/stats/summary）、`orchestrator/planner`、`orchestrator/plan-store`、`provider/model-router`、`tools/interface`、`dependency/analyzer`、`provider/user-id`。它被 `gateway/agent-assembly`（创建 DelegateToAgentTool 并注入 SubAgentContext）、`tools/runtime-control/subagent.ts`、`lifecycle/supervisor.ts`、`orchestrator/loop.ts` 消费。
- `agents` 依赖正确的类型 `AgentDefinition/AgentResult/CollaborationMode`（来自 types）。

---
## 4. `src/world-engine/` —— 陪伴模式世界模拟

六个文件。职责：维护陪伴模式的世界模型，世界从对话中「长出来」（初始为空，后置 WorldAgent 逐渐建地点/物品/NPC）。文件类型全部带所有权注释，明确每字段写者。

### 4.1 `src/world-engine/types.ts` —— 世界数据结构与 schema
定义 `world.json` 结构，含**写入者所有权契约**（由工具层强制）：
- `ambient`（Ambient）—— **WorldTicker 独占写**：time(ISO)/period(语义时段)/weather/season/temperature。
- `locations`（Record<id, WorldLocation>）—— WorldAgent 创建/精修：desc/objects/layout(ObjectPlacement[]：object 在 anchor 的 relation 处)/visible(临近可见，读取只带一层摘要防递归)/connects/owner?。
- `npcs`（Record<id, WorldNpc>）—— **desc/persona/home/roaming/mobility 由 WorldAgent 创建后只读；location 由 WorldTicker 概率放置；state 由 WorldAgent 写**。字段含 aliases?/race?（种族=属性非身份，同族不同个体各建各记录）/note?（认知留痕）/persona/home/roaming(0..1)/mobility(anchored|free)/location/state。
- `relationships`（Relationship[]，有向边）—— 由 observe agent 依对话更新，不随时间自动变化；对称关系（朋友/恋人…）只记一条，宠物等有方向语义。
- `simObjects`（Record<id, SimObject>）与 `customKinds`（Record<kind, KindSpec>）—— 框架维护的动态对象与声明式自定义动态类型（KindSpec 用 ratePerHour/tempFactor/max/removeAtOrBelow/start/phases 描述，让 LLM 用规则而非代码定义新动态类型）。
- `state`（WorldState）—— **WorldAgent 独占写**：location（主角所在地）/companionLocation（陪伴角色所在地，narrate 以其为场景）/sceneOverrides（临时环境变更）/recentEvents（上限）/characters（Record<name, CharacterInfo>，动态身份补充：race/aliases/note，与配置身份叠加）。
- `EnvironmentSnapshot`：readEnvironment() 返回的当前地点环境快照（location/userLocation/userPresent/desc/owner/objects/layout/sceneOverrides/ambient/visible/npcs/relationships/characters/simObjects/recentEvents）。
- 顶层 `World`：聚合 meta+ambient+locations+npcs+relationships+simObjects+customKinds+state。
- 纯函数：`periodOf(hour)`（按小时推导时段标签，因世界时间经 timeScale 折算、与现实时钟脱钩，模型不能凭数字判断昼夜）、`createEmptyWorld(id,name,now)`。

### 4.2 `src/world-engine/sim.ts` —— 框架维护的动态对象行为
「LLM 负责造出来，框架负责养着」——动态对象由 Ticker 按世界时间+环境自动演化，不需要 LLM 逐帧管理。关键结构：
- `SimBehavior` 接口：`init(sim)` + `tick(sim, ambient, worldHours): boolean`（返回 false 即移除）。
- 内置行为三种：`snow`（受温度影响融化，>0 度按 meltFactor 化得快、<=0 度缓慢升华，化尽即移除）、`plant`（按 growthRate 生长到 100 成熟；采摘由 store.harvestSim 处理）、`timer`（按 durationHours 推进到 100% 变「完成」后保留待 LLM 处理）。集中在 `BEHAVIORS` 表，新增 kind 只需加一条规则。
- 声明式自定义类型通用解释器：`phaseFor`（按 amount 阈值匹配阶段标签）、`initCustom`/`tickCustom`（有效速率 = ratePerHour + tempFactor×温度，removeAtOrBelow 触发移除）。
- 入口：`initSim(sim, customKinds)`（内置->自定义->默认量）、`evolveSim(sim, ambient, worldHours, customKinds)`（返回是否保留）、`listSimKinds()`。

### 4.3 `src/world-engine/store.ts` —— WorldStore 读写层
纯数据、零 LLM、可独立测试。**并发模型：读并发、写串行**（写先改内存、再进队列顺序持久化，用临时文件+rename 保证磁盘始终完整）。数据落 `~/.agent/companion/<角色名>/world.json`，一个角色 = 一个世界（构造拒绝保留名 `default`）。
- 读 API：`loadOrCreate`（加载或建空世界，返回是否新建）、`getWorld`、`readEnvironment(mainCharacters[])`（组装当前地点快照；邻近 visible 只带一层 desc；关系只取双方都在当前场景——避免关系网变大性能开销；simObjects 过滤当前地点取）；`hasContent`、`npcsAt(location)`、`listWorlds`。读数据时做旧文件兼容迁移（relationships/simObjects/customKinds/companionLocation/characters 兜底）。
- 写 mutate 方法（全部 `mutate` 先改内存再 `persist`）：`setAmbient`（Ticker）、`placeNpc`（Ticker）、`upsertLocation`/`upsertNpc`（世界从对话增长，upsertNpc 后续字段丰富合并，aliases 并集去重）、`defineKind`/`spawnSimObject`（initSim 初始化）/`removeSimObject`、`placeObject`/`moveObject`/`removeObject`（静物与 simObject 通吃，清掉原布局边）、`harvestSim`（多茬生归零重长/一茬生删除）、`setRelationship`（**对称关系自动归一化**——同对任一方位已存在则原地更新，保证一对人只留一条；自指跳过）、`removeCharacter`/`setCharacter`（动态身份只增补不覆盖）+ `removeRelationship`/`removeNpc`、`moveUser`/`moveCompanion`/`moveBoth`、`setSceneOverride`、`addEvent`（截断 MAX_EVENTS=30）。
- `batch(fn)`：批量修改合并一次持久化，**仅供受信任内部模块（Ticker 每次心跳）调用，绕过按方法所有权约束**。
- 存档：`save(label)` 写 `saves/{label}.json`。
- 内部：`mutate` -> `persist`（enqueue 串行）-> `atomicWrite`（tmp+rename）；`flush()` 等待所有挂起写完成（stop 时保证落盘）。

### 4.4 `src/world-engine/ticker.ts` —— WorldTicker 环境自动推进
世界的自动管理程序，自包含定时器（不依赖任务调度器，start 起 / stop 清），定时器 unref 不阻进程退出。选项：heartbeatMs（默认5s）/timeScale（世界:现实 流速，默认1）/weatherAvgHours/overcastHoursBeforeRain。
- `tick(now)`：每次心跳，`worldHours = heartbeatMs×timeScale/3.6e6`，在**一次 batch** 内依次 `advanceTime`->`maybeChangeWeather`->`evolveSimObjects`->`placeNpcs`，并更新 weatherDwellHours（驻留时长，按世界时间计）。
- `advanceTime`：世界时间 = 创建时刻 + 现实流逝×timeScale（timeScale=1 与现时精确 1:1，无累积漂移）；推导 period/season；`seasonalizeWeather` 换季修正；`driftTemperature` 平滑趋近「季节基准+昼夜偏移」（每次最多±1 度）。
- `maybeChangeWeather`：按世界时间计算变天概率（weatherAvgHours 缩放）；只在相邻天气状态间跳转（WEATHER_TRANSITIONS 表，防「晴->暴雨」突变）；降水前提是阴天酝酿足够（overcastHoursBeforeRain）。
- `evolveSimObjects`：遍历 simObjects 调 `evolveSim`，返回 false 则删除。
- `placeNpcs`：概率锚定 home 放置——当前场景（陪伴所在地）里的 NPC 不挪走（防对话中途消失）；anchored 且已在 home 者小概率出门（roaming）；free/不在 home 按 roaming 决定出门或回家，`pickRoamTarget` 只走 `connects` 一步。

### 4.5 `src/world-engine/tools.ts` —— WORLD_TOOLS 与执行器
模块内定制工具，**不进全局 tool.registry、不被主 Agent 看见**，直连 WorldStore。共 12 个窄工具 + `executeWorldTool(store, name, input)` 分发器：
- `world_upsert_location` / `world_upsert_npc` / `world_set_character` / `world_remove_npc` / `world_remove_character`（世界/身份维护）。
- `world_set_relationship`（增/改/删，remove=true 删除，对称自动去重）。
- `world_move`（who=both|user|companion）、`world_scene_change`（临时环境变更）、`world_note_event`（记录有意义事件）。
- `world_define_kind`（声明自定义动态类型）、`world_spawn_sim`（生成框架维护的动态对象）、`world_object`（move/remove/harvest/place 物体交互，harvest 校验植物类型与成熟度）。
执行器做输入校验与分发到 WorldStore 各写方法。这些工具全部符合「只读写世界模型自身存储文件、固定 schema」的窄工具约束。

---
### 4.6 `src/world-engine/agent.ts` —— WorldEngine（BypassAgent 实现）
陪伴模式的旁路智能体，继承 `BypassAgentBase`，`modes=['companion']`、`modelChannel='narration'`，工具面 = `[...WORLD_TOOLS, SCENE_RENDER_TOOL]`（scene_render 来自 `generation/scene-render`，场景显著变化时更新视觉背景，重复调用自动跳过）。文件头同样声明元认知安全红线。
- 配置来源：`world-engine.json`（~/.agent/companion/<角色>/world-engine.json），含 enabled/worldId/worldName/protagonist/companion/relationships/ticker，经 readConfig 严格解析。
- 生命周期：`start()` —— 读配置 -> `store.loadOrCreate` -> 若新建则写入配置声明的、涉及本角色的初始 relationships -> 组装 identities（companion 名固定为 characterName）-> `new WorldTicker` 并 start；`stop()` —— 停 ticker -> await observeQueue -> `store.flush()` -> 清 pendingNarration。
- **遗留 API（CompanionRouter 直接使用，不经 BypassAgent 接口）**：
  - `narrate()`：若 enabled 且 hasContent，读环境快照 -> `renderEnvironment` 组环境文本（+pendingNarration 用户旁白）-> `callLLM(NARRATE_SYSTEM,...)` 生成旁白。
  - `setPendingNarration(text)` / `observe(userInput, mainOutput)`（串行化 observe 队列，防并发冲突）/ `_observe`（组 prompt -> `callLLMWithTools(OBSERVE_SYSTEM, 5)` 更新世界）。
- BypassAgent 接口：`preTurn(_ctx)` —— `narrate()` 产旁白，注入 `section:'timestamp'`、`role:'assistant'`、`mode:'replace'`（无旁白返回空 injections）；`postTurn(ctx)` —— 调 `observe(ctx.userInput, ctx.assistantOutput)`。
- 渲染辅助：`buildIdentityPreamble`（角色身份规则前言，强调主角/陪伴≠NPC、种族≠身份、别名汇拢）、`buildNarrateIdentityNote`、`renderEnvironment`（环境快照->文本）、`renderScene`（含身份叠加渲染）、`renderRoster`（世界概况）；`parseNarration`（剥离 `[[...]]` 旁白与对话，供 transformedInput）。
- exports：重导出 WorldStore/WorldTicker/types、CharacterIdentity/AgentIdentities、parseNarration。
- 安全性质：工具全来自 world-engine 自身数据面，不触碰用户文件，不提供通用工具。

### 4.7 内外依赖方向
- 内部：agent -> store/ticker/tools/types；store -> types/sim；ticker -> types/store/sim；tools -> types/store。**均不反向依赖 bypass**；agent.ts 依赖 `bypass/base.ts`（BypassAgentBase/BypassAgentConfig）与 `generation/scene-render.ts`。
- 外部：`plugins/world-engine-plugin.ts`（deps:['bypass']，require 'bypass.manager' -> register(WorldEngine)，并对外服务 'world-engine.agent'/'world-engine.createAgent'）；`gateway/bypass-wiring.ts` 在陪伴模式下 `activateForMode('companion')` 驱动其启停；`tools/runtime-control/companion.ts`、`context/router.ts`（CompanionRouter）消费 narrate/observe。

---

## 5. `src/companion/` —— 陪伴模式表达层

十个文件，其中 5 个非测试文件：`normalize.ts`、`say-history.ts`、`voice-library.ts`、`voice-store.ts`、`voice.ts`（另含 5 个 `.test.ts`，本次不展开）。核心定位：**负责「把陪伴角色的台词写出来/说出来」的表达链**，明确 **不依赖 world-engine**（世界状态由 bypass 侧 WorldEngine 维护）；它通过 `events.ts` 与 `generation/` 与主系统协作，被 loop.ts / companion Router / companion_say 工具驱动。

### 5.1 `src/companion/normalize.ts` —— 台词 -> TTS 输入规范化
纯函数、确定性变换、不走 LLM。`MAX_TTS_TEXT_LEN=500`。`normalizeForTts(input, maxLen)` 依次剥离：代码块/行内代码、URL/链接（保留 markdown 文本）、markdown 结构符号（标题/列表/引用/强调）、`（动作）`/`(停顿)` 舞台指示、emoji 与装饰符号（Unicode 范围）、表格分隔线、收敛空白；超长截断加省略号。语义级改写（书面语->口语）不在这里做，由 companion_say 工具描述引导主 Agent 直接用口语写台词。

### 5.2 `src/companion/say-history.ts` —— SayHistoryStore 台词历史
补齐「companion_say 表达实时推 UI 但不落盘」导致的文字台词无历史数据源缺口。数据：`~/.agent/companion/say-history.sqlite`，表 `say_history`，say_id 与 COMPANION_VOICE 事件 sayId 对齐。`SayHistoryEntry`（sayId/character/mode(speak|think)/text/tone?/think?/action?/at）。`append`（**幂等**：同 sayId 已存在跳过，防兜底路径与工具路径双写；每角色按 `DEFAULT_SAY_HISTORY_KEEP=500` 裁剪）、`listByCharacter`（角色维度时间倒序，before 分页游标）、`clearByCharacter`。`getSayHistoryStore()` 全局单例。写入口有二：companion_say 工具 execute 与 loop 兜底路径（模型未调工具时）。

### 5.3 `src/companion/voice-library.ts` —— VoiceLibrary 音色库（TTS 输入侧）
「资产目录」级别的参考声音：数量少、低频变更、人工可编辑 + JSON 索引，不用 sqlite。结构：`~/.agent/companion/voices/`（参考音频 3~10s 干净人声 wav/mp3）+ `voices.json` 索引（id/file/desc/bind/createdAt）；索引在新位置（voices/ 内部），读取兼容旧位置（父级 voices.json）并自动迁移。`VoiceEntry`。API：`list/get`/`fileOf`/`sizeOf`、`register`（复制音频进库，校验大小与扩展名、id 缺省=去扩展名、重复 id 抛错）、`bind`（绑定角色默认音色，同角色旧绑定自动解除）、`delete`（索引+文件）、`resolveForCharacter(character)`（角色 bind 解析）、`resolveRef(ref)`（条目 id/文件名/绝对路径均可）。解析链：voice 参数 -> 角色 bind -> config 兜底。**管理入口只在协议层**（companion.voices/voiceRegister/voiceDelete/voiceBind 设置页）——模型只能「选用」音色，不能增删改。`getVoiceLibrary()` 全局单例。

### 5.4 `src/companion/voice-store.ts` —— GeneratedVoiceStore 生成语音库（TTS 输出侧）
缓存而非资产：台词文本仍在，删除后同句重合成。音频本体不进 sqlite，库存**元数据+相对路径**，文件按角色分目录。三级索引：一级 character -> 二级 text_hash + emotion_key -> **唯一键 (character, text_hash, emotion_key, voice_id)**（天然去重/缓存命中；provider/model 不入唯一键，换供应商重新合成、旧条目保留可切回）。`GeneratedVoiceRow` / `InsertGeneratedVoice`。API：`find`（唯一键查询命中）、`get`、`listByCharacter`（倒序重放列表）、`insert`（收纳文件进 `<baseDir>/<角色>/<id>.<ext>`，唯一键冲突幂等返回已有——`makeId` 必须覆盖完整唯一键防 PRIMARY KEY 冲突）、`filePathOf`、`stats`（总条数/字节/按角色分布）、`prune`（按角色保留最近 keepN，条数与文件一并删）。常量 `DEFAULT_KEEP_PER_CHARACTER=300`（约 30~70MB）。`getGeneratedVoiceStore()` 全局单例。

### 5.5 `src/companion/voice.ts` —— CompanionVoiceService TTS 合成
陪伴台词语音合成的服务层 + 契约层。关键结构：
- `VoiceNotify`：类型收紧的合成事件回调，`(type, payload) => void` 且 type 锁定为 `UI_EVENT.COMPANION_VOICE`（历史「整条链路零约束导致字段漏传」的教训，一处收紧约束全部调用点）。
- `CompanionTtsConfig`：configCenter 的 companion.tts 节（enabled/voice?/provider?/keepPerCharacter?）。
- `VoiceOverride`：每次表达的音色覆盖（voiceId?/voice?/tone?/sayId?；sayId 用于前端丢弃「过期语音」——TTS 异步合成可能迟到数分钟）。
- `VoiceServiceDeps`：依赖最小接口（registry/service/cwd，store 可注入做测试）。
- 类 `CompanionVoiceService`：构造注入 deps。`onTurnEnd(text, character, notify, cfg, overrides?)` —— fire-and-forget：**串行队列、忙时只保留最新台词**，绝不抛出、不阻塞回合。`synthesizeOnce`：取 provider（cfg.provider 或 registry default `audio_tts`）-> 音色解析链（overrides.voice || cfg.voice；voiceId 标 `config:` 前缀区分）-> textHash -> `store.find` 唯一键命中直接复用并 notify ready(cached) -> 否则 `service.generate(req)` 合成 -> `store.insert` 落库 -> `pruneIfNeeded`（按角色 keepPerCharacter 默认 300 治理）-> notify ready(url=/api/companion/voice/{id}/file)。失败 notify error，静默不炸主流程。
- `normalizeEmotion` 规范化情绪索引值。
- 依赖：`generation/index.js`（GenerationRegistry/GenerationService）、`generation/interface.js`（GenerationRequest）、`voice-store`/`voice-library`、`logging/logger`、`events.js`（UI_EVENT/CompanionVoiceEvent）。

### 5.6 与 world-engine 的关系（重点）
- **两者均属陪伴模式但职责正交、无代码级相互依赖**：world-engine 维护「世界是什么」（bypass 侧 preTurn 注入环境旁白 / postTurn observe 更新世界）；companion 维护「台词怎么说/说出来」（companion_say 表达 -> say-history 落盘 + TTS 合成语音 -> UI 事件）。它们通过共享主循环（loop.ts）与配置（~/.agent/companion/）协同，不互相 import 类型。
- 数据落点不同但是**同根目录布局**：world-engine 用 `.agent/companion/<角色>/world.json`、saves/、world-engine.json；companion 用 `.agent/companion/say-history.sqlite`、voices/、generated/。
- 实际接线点：loop.ts 在旁路 postTurn 后处理「陪伴表达契约」——`companionExpressions`（companion_say speak）作为真正「表达」，普通 text 是内心独白、不驱动世界、不自动 TTS；模型未按契约调用 companion_say 时走**兜底路径**：把普通文本当作台词呈现（emit COMPANION_SAY + SayHistoryStore.append + CompanionVoiceService.onTurnEnd）。
- 配置/路由层把二者并置：`gateway/bypass-wiring.ts`（挂 world-engine 插件 + activateForMode('companion')）与 `tools/companion-say.ts`/`tools/runtime-control/companion.ts`（companion 表达）都由同一 loop 装配链驱动；`context/router.ts` 的 companion Router 同时可访问 WorldEngine（narrate）与表达链。

---

## 6. 关键数据流汇总（两套主链路）

### 6.1 普通模式 —— orchestrator（意图 -> 记忆 -> 纠偏 -> 簇）
输入 -> loop.run -> preTurn：loop 调 `bypassManager.preTurn(ctx)` -> orchestrator 解析意图（capability/confidence）返回 intent -> loop 消费 intent 做意图簇过滤；preTurn 期间经 inject_hint 注入主上下文 -> loop.postTurn（每次迭代 reviewOnly 纠偏，isLastIteration=false；回合末 postTurn(isLastIteration=true) 触发 reviewAndRemember）-> 最终轮：记忆维护(memory_* 写记忆文件) + 簇归类(cluster_assign 写 cluster-index.json/summaries/) -> loop 读 `lastClusterAssign` 写 events.jsonl + markCluster `_cluster_id` + 分簇压缩；backfillUnclassified 补早期历史。

### 6.2 陪伴模式 —— WorldEngine（世界） + Companion（表达）双轨
启用：gateway 挂 bypass 插件 + world-engine 插件，`activateForMode('companion')` -> WorldEngine.start 起 WorldTicker，按心跳推进时间/天气/NPC/动态对象（batch 写 store）。
回合内：loop.preTurn -> WorldEngine.preTurn -> narrate()（读环境快照->LLM 旁白）-> 注入 timestamp section（assistant, replace）；主 Agent 回复并按 companion_say 发表情/台词 -> loop.postTurn -> WorldEngine.postTurn -> observe（串行队列，LLM+WORLD_TOOLS 更新世界）+ 表达兜底路径 -> SayHistoryStore.append + CompanionVoiceService.onTurnEnd（TTS 合成/命中缓存）-> UI 事件（companion.say / companion.voice）。

---

## 7. 本批模块的对外契约汇总（改动影响面）
- `bypass/types.ts` 的 `BypassAgent` 接口是旁路体系的**稳定插件接口**——新增旁路智能体只需实现该接口 + `BypassAgentConfig`，交给 `BypassManager.register/activateForMode`。orchestrator 与 world-engine 都依赖此接口，令二者可替换。
- `BypassManager.inject/consumeInjections` 是 orchestrator->loop 注入提醒的通道；`_pendingInjections` 由 loop 的 compose 前消费。
- WorldEngine 暴露两类 API：BypassAgent 接口（preTurn/postTurn）与遗留 narrate/setPendingNarration/observe（供 CompanionRouter）。
- DelegateToAgentTool 依赖 SubAgentContext（由 gateway 装配注入），是子Agent 委托的**唯一对外工具面**；异步结果经 pendingAsyncResults 回流主 loop。
- 安全红线实现观：三个元认知实现（orchestrator、world-engine）+ 基座（base/manager/index）都不把任何通用工具装进旁路工具面；world-engine 工具甚至不进全局 tool registry。

## 详细 辅助设施

> 本文档为纯结构文档：只描述各模块/文件的职责、关键类、类型、数据流与外部依赖方向，不展示代码。覆盖：`src/multimodal`、`src/media`、`src/hot-reload`、`src/setup`、`src/cli`，以及一组基础设施小模块（`src/env`、`src/logging`、`src/prompts`、`src/utils`、`src/update`、`src/types`）。

## 0. 公共依赖基线

本组模块共享的几个基础设施依赖点（后文不再重复展开）：

- `src/logging/logger.ts` 的 `createLogger(module)` —— 几乎每个模块都创建自己的模块级 logger。
- `src/types.ts`（顶层类型文件，非 `src/types/` 目录）—— 定义 `Message`、`MessageContent`（text/thinking/tool_use/tool_result/image 联合）、`ImageContent`、`ImageSource`（base64/url）、`SkillDefinition`、`AgentDefinition`、`CollaborationMode`、`AgentResult` 等核心跨模块类型。
- `src/runtime/config-center.ts` 的 `RuntimeConfigCenter` —— 提供 `get/set/load/isSaving`，是配置的运行时权威来源（供 hot-reload、model-catalog、env 等）。
- `src/runtime/defaults.ts` 的 `getDefaultConfig()` —— 内置默认配置。
- `src/tools/sqlite.ts` 的 `Database` —— 内置 node:sqlite 的薄封装。
- `src/provider/config.ts` 的 `DEFAULT_PROVIDERS`（Provider 元数据单一事实源：名称、默认模型、envKey）。

---

## 1. src/multimodal/（1 文件 —— index.ts）

**职责**：用户输入图片的完整处理管线 —— 检测、压缩、索引、构建模型消息、以及一个供 Agent 重看的 `view_image` 工具工厂。输出直接面向 `../types.js` 的 `MessageContent`。

**文件：`index.ts`（约 207 行）**

- **常量 `IMAGE_MIME_MAP`**：文件扩展名 → MIME 类型的映射（png/jpg/gif/webp/bmp/svg/ico/tif/tiff）。
- **类 `ImageStore`（会话级图片内存索引）**：
  - 内部维护 3 个结构：`images: Map<id, ImageRecord>`（真实数据：base64、media_type、source_path、description、byteSize、indexedAt）、`_hashIndex`（内容指纹 → id 的去重索引）、`_cachedList` + `_dirty`（`listForContext` 的懒缓存）。
  - 内容指纹 `_contentHash` 用 base64 的头部 512 字节 + 尾部 512 字节 + 长度 + 类型拼接而成（近似去重）。
  - 关键方法：`store()`（按指纹去重，生成 `img_001` 递增编号）、`get()`、`setDescription()`、`list()`（完整元数据列表）、`listForContext()`（生成未配描述图片的挂起提示文本，仅在脏时重算）。
  - **数据流**：多模态/渠道模块调用 `store()` 写入 → Agent 通过 `view_image` 工具读取 → `listForContext()` 把"待看图片"注入上下文提示。
- **函数 `compressImageIfLarge(buf, mime)`**：超 300KB 才处理；动态 `import('sharp')`（缺失则原样返回）；长边超 2048 则 `resize(fit:'inside')`；带 alpha 的 PNG 走 PNG palette 压缩，否则转 JPEG 质量 80。任何异常静默回退原始字节。
- **函数 `detectImagePaths(text)`**：正则匹配 Windows/Unix/相对路径 + 图片扩展名，再用 `fs.statSync` 校验真存在且是文件。
- **函数 `buildUserContentWithInlineImages(...)`**：渠道已下载 base64 时直接构造 `MessageContent[]`（image 块 + 文本标注块 + 原输入），并把图片写入 imageStore。
- **函数 `buildUserContentWithImages(userInput, imageStore)`**：从文本检测本地磁盘图片路径 → 读取 → 超 500KB 压缩 → base64 → 入 store → 拼 image 块 + token 估算警告文本块。
- **函数 `createViewImageTool(imageStore, pendingInjections)`**：返回标准 `Tool` 形状对象（name=`view_image`、description、inputSchema、execute）。`execute` 支持三态：无参/'list'/'all' 列出所有；有效 id 回填 base64 到 `pendingInjections` 数组（供下一轮注入上下文）；未知 id 报错并列出可用项。
- **对外依赖方向**（只进不出）：`node:fs`、`node:path`、`../types`（只读类型）。`pendingInjections` 数组由外部（循环/上下文构造器）持有并读取，故本模块把图片内容"推"出到外部。

---

## 2. src/media/（3 文件：index 导出 + media-store + 测试）

**职责**：媒体库 `MediaStore` —— 独立于知识库（kb.sqlite）的媒体索引 + 文件本体管理。存储约定：数据库 `~/.agent/media/media.sqlite`，文件 `~/.agent/media/files/`。供 scene_render 产物、generate_image/video 产物回填，WebUI 经 serve 端点查询。

**文件：`index.ts`（barrel 导出）**：对外重导出 `MediaStore` 类、4 个路径/辅助函数（`getMediaDir`、`getMediaDbPath`、`getMediaFilesDir`、`inferMediaType`、`recordMediaFile`）及 5 个类型（`MediaType`、`MediaSource`、`MediaEntry`、`MediaRecord`、`MediaFilter`）。

**文件：`media-store.ts`（核心实现）**

- **类型**：`MediaType = 'image'|'video'|'audio'`；`MediaSource = 'scene'|'generation'|'user'`；`MediaEntry`（业务字段：type/source/character/taskType/signature/prompt/meta/createdAt）；`MediaRecord`（= MediaEntry + id + relPath）；`MediaFilter`（type/source/character/limit）。
- **构造函数**：自动 `mkdir` 数据库目录与 `files/` 子目录，用 `Database(dbPath)` 建库并 `exec` 建表 + 三个索引（type/source/character）。
- **类 `MediaStore`** 方法：`close()`、`importFile(srcPath, entry)`（把外部文件 `copyFileSync` 进 `files/<uuid><ext>` 并写索引，源不存在则抛错）、`register(relPath, entry)`（只登记不复制，针对已在 media 目录的文件）、`get(id)`、`findBySignature(signature, source, character?)`（去重查询）、`list(filter)`（动态 WHERE + ORDER BY created_at DESC + LIMIT）、`remove(id, deleteFile=true)`（可选物理删文件）、`count()`、`resolvePath(rec)`（依据 relPath 还原绝对路径）。
- **模块级辅助函数**：
  - `rowToRecord`：SQLite 行 → `MediaRecord`（snake_case 字段 → TS 驼峰）。
  - `inferExt`：类型 → 默认扩展名（png/mp4/mp3）。
  - `inferMediaType(mime)`：从 MIME 前缀推断 media 分类。
  - `recordMediaFile(srcPath, entry, dbPath?)`：**失败不抛错**的落库辅助 —— 新建一个临时 MediaStore、import、关闭；任何异常只 warn 并返回 null。设计意图：媒体索引是附属能力，落库失败不阻断生成主流程。
- **对外依赖方向**：`node:fs/path/os/crypto`（randomUUID）、`../tools/sqlite.js`（Database）、`../logging/logger.js`。不依赖知识库模块，刻意与 kb.sqlite 隔离。

**文件：`media-store.test.ts`**：对 MediaStore 的单元测试（导入/查重/列表/删除等）。

---

## 3. src/hot-reload/（17 文件 —— 热重载管理器）

**职责**：实现"配置变更即时生效，不重启"的项目原则。所有外部化内容（MCP、Skill、Agent、Workflow、Provider、Config、Tools、Plugins、Commands、Prompts、Model Catalyst、Channels、Context Manifest、Tool Bundles、Extension Registry）通过各自 watcher 监听变化并自动重载。核心思想是把所有 watcher 的公共样板（fs.watch/watchFile + debounce + mtime 去重 + try/catch + logger）收敛到 `watcher-base.ts`，14 个业务 watcher 只管声明 spec。

### 3.1 骨架与核心类型

**文件：`watcher-base.ts`（统一骨架）**

- **接口 `WatcherSpec`**（watcher 的声明式契约）：`name`（日志标识）、`paths()`（返回监听路径数组，函数式延迟解析）、`reload(trigger)`（业务唯一差异点，骨架统一保护错误）、`mode:'watch'|'poll'`（默认 watch）、`pollIntervalMs`、`debounceMs`、`recursive`、`filter`（防抖前 filename 过滤，省 CPU）、`shouldSkip()`（防抖后、reload 前判断，用于竞态保护如 configCenter.isSaving）。
- **接口 `WatcherTrigger`**：`filename`（watch 模式为文件名，poll 模式恒为 null）+ `dir`。
- **接口 `WatcherHandle`**：统一 `close()` 归一化（供 HotReloadManager.stop()）。
- **函数 `createWatcher(spec): WatcherHandle[]`**：按 mode 分发到 `createEventWatcher`（fs.watch，每路径独立防抖计时器、支持 recursive、静默跳过无法监听路径）或 `createPollWatcher`（fs.watchFile stat 轮询 + `lastMtimes` mtime 去重 + 全局 `reloadLock` 防异步重入；关闭用 `fs.unwatchFile`）。
- 公共执行器 `runReload`：`shouldSkip → reload → 统一 catch/logger`。
- 注释明确两模式适用场景：watch 适合目录递归；poll 适合 `.agent/` 密集目录下的独立配置文件（Windows 上 fs.watch 误触发多）。

**文件：`hot-reload-config.ts`（配置出口）**

- 注入机制不变式：模块级 `_configCenter` 由 `injectHotReloadConfigCenter(cc|null)` 写入（factory.ts 初始化后调用，传 null 供测试还原）；`getHotReloadConfig(key, fallback)` 读取 `hotReload.{key}`，未注入/异常回退 fallback。`pollIntervalMs()` 返回 `hotReload.pollIntervalMs`（默认 5000）。
- **依赖方向**：只读依赖 `../runtime/config-center.js` 的类型。

**文件：`manager.ts`（装配与生命周期中心）**

- **接口 `HotReloadDeps`**：一个巨型依赖袋 —— toolRegistry、skillRegistry、agentRegistry、pluginManager、configCenter、contextComposer（LayeredContextComposer）、mcpSystem、bundleRegistry、channelRegistry（可选）、cwd、providerConfigLoader、modelCatalog。
- **接口 `WatcherSpecEntry`**（装配条目，防屎山核心）：`flag`（configCenter 开关 `hotReload.*`；undefined=默认启用）、`load`（**动态 import** 返回 `{watch}` 模块，消除静态循环依赖）、`build`（由 deps + debounceMs 组构造参数，返回 null 表示前置不满足而跳过注册）。
- **类 `HotReloadManager`**：
  - 内部 `handles: WatcherHandle[]`、`logger`、`started` 标志。
  - 静态工厂 `create()`：构造 + start。
  - `watcherSpecs()`：**14 条装配表**的单一事实源。
  - `start()`：读 `hotReload.enabled`，关闭则直接返回；逐条 spec 校验 flag → 动态 `load()` → `build()`（null 则跳过）→ `registerWatcher(watch, ...args)`。
  - `stop()`：遍历 handles close，清空数组。
  - `registerWatcher(fn, ...args)`：统一把单句柄/数组归一化入 handles，异常由 logger 捕获。
- **与业务 watcher 的接线点（数据流）**：
  - skill-watcher 的 `onSkillLoaded` 回调内补注册 `skill-{name}` 的 lazy_expand ContextSource（contextComposer）。
  - model-catalog-watcher 传入 `currentModel`（从 configCenter 读 `session.provider`/`session.model`）用于 maxContext 同步。
  - channel-watcher 与 provider-watcher 共用 `hotReload.watchProviders` 开关；channelRegistry 缺失时 build 返回 null。
  - watchCommands/watchContextManifest 的缺省启用由 defaults 承担，用户显式 false 才跳过。

### 3.2 14 个业务 Watcher（均基于 createWatcher 声明 spec）

| 文件 | 监听目标 | 模式 | reload 行为 | 外部依赖 |
|---|---|---|---|---|
| `mcp-watcher.ts` | 3 处 MCP 配置（~/.agent/mcp.json、.mcp.json、.agent/mcp.json，路径复用 `getMCPConfigPaths`） | poll | `mcpSystem.reload()` | ../mcp/system、../mcp/config |
| `plugin-watcher.ts` | 用户 + 项目 plugins 目录（不存在则创建） | watch | `pluginManager.loadAll()`（幂等） | ../plugins/manager |
| `prompt-watcher.ts` | 内置 + ~/.agent/prompts 的 .md（recursive） | watch | `clearPromptCache()` | ../prompts/loader |
| `agent-watcher.ts` | agents.json（env 变量 > 项目 > 全局去重） | watch | 二次 loadAgentConfigs + 三方 diff（added/removed/changed），增量注册/注销/更新，并对每个 agent 同步 `agent-{name}` lazy_expand ContextSource | ../agents/registry、../agents/config-loader、../context/composer |
| `config-watcher.ts` | 全局 + 项目 config.json | watch | `configCenter.load()`；`shouldSkip=configCenter.isSaving` 防自写竞态 | ../runtime/config-center |
| `tool-watcher.ts` | ~/.agent/tools/（recursive） | watch | 三轨扫描同步 BasicTool(.js)/ModuleTool(子目录 dist/index.js)/PythonTool(.py 走 PythonToolBridge)；mtime 去重防误触发；初始扫描不标 hotAdded（进 Zone2 tool_rules），变更扫描才标（进 Zone5 session-tools） | ../tools/registry、../tools/interface、../tools/python-bridge |
| `skill-watcher.ts` | 用户 + 项目 skills 目录 .md | watch | 初始 scanSkillsDir；变更文件存在→loadSkillFile 重载，删→unregister；onSkillLoaded 钩子 | ../skills/registry、../skills/loader |
| `command-watcher.ts` | 项目根 commands.json（监听父目录 + filename 过滤） | watch | 动态 import CommandRegistry 后 reload（存在性检查覆盖 rename 场景） | ../ui/command-registry |
| `provider-watcher.ts` | ~/.agent/providers.json | poll | `getProviderConfigLoader().reload()` | ../provider/config |
| `model-catalog-watcher.ts` | ~/.agent/providers.json | poll | `modelCatalog.reload()` + 依 `getModelContextWindow` 同步 `session.maxContext`（用户值在模型上限内则保留） | ../provider/catalog、../setup/model-defaults、../runtime/config-center |
| `manifest-watcher.ts` | .agent/context-manifest.json | watch | `getManifestLoader(cwd)`（按 resolve 路径缓存实例）省二次 .load()/reload() | ../context/manifest-loader |
| `channel-watcher.ts` | 全局 + 项目 model-channels.json | watch | `channelRegistry.reload()` | ../provider/model-channel-registry |
| `bundle-watcher.ts` | ~/.agent/tool-bundles.json（监听父目录 + filename 过滤） | watch | `registry.reload()` | ../tools/bundle-registry |
| `extension-registry-watcher.ts` | 全局 + 项目 extension-registry.json | poll | 重载名单注入 ExtensionRegistry（校验失败保留旧值）+ 插件裁决 diff（名单 enabled 与挂载态不一致时 deactivate/activate） | ../supervisor/extension-registry、../plugins/manager |

**特殊说明（tool-watcher）**：自身定义 `ResolvedEntry`（trackingKey/filePath/label/factory）与 `scanAndSync`、`resolveToolEntries`、`loadAndRegister` 内部函数，维护 `fileMap`/`mtimeMap`；对外暴露 `watchTools(deps)`。

**index.ts（barrel）**：导出 `HotReloadManager`/`HotReloadDeps`、`createWatcher`/`WatcherSpec`/`WatcherHandle`/`WatchTrigger`、以及 9 个 `watch*` 工厂函数。

**测试文件**：`watcher-base.test.ts`（骨架行为）、`hot-reload-config.test.ts`（配置注入/回退）。

---

## 4. src/setup/（6 文件）

**职责**：初始化配置体系 —— 配置向导（SetupWizard）、生成能力向导（GenerationWizard）、persona 文件引导、ConfigManager 配置持久化、模型默认值查询。

### 4.1 config.ts —— 配置管理与持久化（核心，约 400 行）

- **大量"外部化配置"的类型定义**（用户可改的配置形状）：`SafetyConfig`（危险/白名单工具、白名单命令、denyTools）、`ContextConfig`（压缩阈值）、`ScheduleConfig`（调度）、`AgentOverrideConfig`/`AgentsConfig`（按 Agent 名覆写）、`ModelSourceConfig`/`ModelsConfig`（assessment/planning/compression 模型路由）、`LocalModelConfig`、`FeishuChannelConfigEntry`/`ClawbotChannelConfigEntry`/`ChannelsConfig`、以及主聚合类型 `AgentConfig`（provider/model/maxTurns/maxContext/retry/circuitBreaker/fallbackProviders/personaDir/safety/context/schedule/agents/models/local/channels/memoryFile/bypass/kb/ui）。注释强调新增字段需同步 `runtime/config-schema.ts` 与 `defaults.ts`。
- **常量**：`DEFAULT_CONFIG`（深默认值对象，channels 内含飞书/ClawBot 全套默认）、`DEFAULT_MAX_CONTEXT_TOKENS=200000`、`API_KEY_MAP`（从 `DEFAULT_PROVIDERS` 派生，单一来源）。
- **类 `ConfigManager`**：
  - 路径访问器：`getConfigDir/getSessionsDir/getConfigPath/getEnvPath/getProjectConfigPath/getProjectEnvPath`。
  - `isFirstRun()` / `ensureDir()`。
  - `load()`：三层合并 **默认 → 全局 config.json → 项目级 config.json**（项目级覆盖）。
  - `save()`：剥离 `ui` 用户偏好单独走全局；其余按"项目级配置存在则写项目、否则写全局"的策略落盘。
  - `saveUserSection(partial)`：局部合并写全局（只覆盖传入顶层键，用于 theme 等）。
  - `saveProjectConfig(partial)`。
  - `.env` 相关：`loadEnvKeys()`（全局 + 项目级，项目覆盖）、`loadEnvFile`（解析 KEY=VALUE）、`saveApiKey(provider, key)`（按 API_KEY_MAP）、`saveApiKeyToEnv(envKey, key)`（更新或追加，同步写 process.env）、`getApiKey(provider)`、`getApiKeyEnvName(provider)`。
- **依赖方向**：`node:fs/promises`、`node:path`、`node:os`、`../provider/local-config`（getLocalProviderConfigLoader）、`../provider/config`（DEFAULT_PROVIDERS）、`../runtime/defaults`（getDefaultConfig）。

### 4.2 persona-bootstrap.ts —— Persona 初始化与状态管理（约 380 行）

- **常量**：`PERSONA_FILE_NAMES = ['SOUL.md','IDENTITY.md','USER.md','PartnerSoul.md','PartnerMemory.md']`；状态文件 `.state/persona-state.json`，`PERSONA_STATE_VERSION=1`。
- **类型**：`PersonaFileName`、`PersonaState`（version/setupCompletedAt）、`PersonaFile`、`PersonaValidationResult`（complete/missing/templateFiles）。
- **路径辅助**：`getGlobalPersonaDir`（`~/.agent/prompts/persona`）、`DEFAULT_PERSONA_DIR`。
- **模板加载 `loadTemplateContent`**：按 `src/prompts/persona` → `cwd/src/prompts/persona` → `cwd/dist/prompts/persona` 顺序搜索，找不到抛错。
- **状态管理**：`readState/writeState`（版本不符重置）。
- **文件操作助手**：`writeFileIfMissing`（`flag:'wx'` 原子创建，EEXIST 返回 false）、`fileContentDiffersFromTemplate`。
- **`ensureGlobalPromptDir(name)`**：通用 prompt 同步（attention.md 等非 persona 内置文件）——复制 `.md` 到 `~/.agent/prompts/{name}/`。
- **`ensurePersonaFiles(personaDir)`**：mk 目录 → 读状态 → **自动检测**（IDENTITY/USER 已改动但 state 未记录 → 自动标记完成）→ 逐个写入缺失模板 → 二次检测 → 写状态。返回 `{needsSetup, filesCreated, state}`。
- **`ensureGlobalPersonaFiles(configHome?)`**：包装为全局目录版。
- **`validatePersonaFiles`（异步）/`validatePersonaFilesSync`**：检查 SOUL/IDENTITY/USER 是否缺失或仍为模板（内容≠模板即视为已填写，容忍模型不同格式）。
- **`loadPersonaFiles(personaDir, cwdFallback?)`**：加载 5 个文件，支持 cwd 覆盖版（模板/缺失时用 cwd 版替换）。
- **`getPersonaState`**：读出状态。
- **依赖方向**：`node:fs/promises`、`node:os`、`node:path`、`node:url`、`../logging/logger`。

### 4.3 wizard.ts —— 主配置向导（约 500 行）

- 基于 `@clack/prompts` + `picocolors` 的交互式 CLI 向导。
- 常量：`PROVIDERS`（从 DEFAULT_PROVIDERS 派生 + 特殊 `local` 项）、`KEY_URLS`（各 Provider 取 Key 的官方链接）。
- `buildModelOptions(provider)`：从 `PROVIDER_MODELS` 生成模型选项（context 格式化如 200K/1.0M）。
- **接口 `SetupResult`**：`{config, apiKey?, enterTui}`。
- **类 `SetupWizard`**：持有 `ConfigManager`；`run(existingConfig?)` 主循环：
  1. `stepProvider`（含 `__skip__` 保持现有）→ 2. `stepApiKey`（检测已有 key 可保留，校验前缀）→ 2.5 `stepLlamaCpp`（仅 local：检测 libs/llama.cpp，可自动跑 `scripts/setup-llamacpp.ps1`，含 `runSetupLlamaCpp` spawn 实时输出，及 `stepModelDownload` 下载指引）→ 3. `stepModel`（下拉 + 自定义输入）→ 4. `stepMaxContext`（依 `getModelContextWindow` 推荐可改）→ 4.5 `stepFeatureDefaults`（orchestrator/kb 默认开关）→ 5. `stepConfirm`。
  - 保存：`configManager.save(config)` + `saveApiKey` + `ensurePersonaFiles(DEFAULT_PERSONA_DIR)`。
  - 尾部询问是否进入 TUI。
  - `cancel()` 返回空配置退出。
- **依赖方向**：`@clack/prompts`、`picocolors`、`node:child_process`、`node:fs`（existsSync）、`node:path`、`node:url`、`./config`、`../runtime/defaults`、`./model-defaults`、`./persona-bootstrap`、`../provider/config`。

### 4.4 generation-wizard.ts —— 生成能力配置向导（独立模块）

- **设计要点**（文件头注释）：能力清单不硬编码（taskTypes 全部来自厂商 `getCapabilities()`）；模态→taskType 展开用命名约定辅助函数（纯 UI 映射）；凭证统一走 `.env`；独立于 wizard.ts。
- **纯函数（可测试）**：
  - `suggestEnvKey(adapterType)`：按厂商类型建议 envKey（volcengine→ARK_API_KEY 等，fallback `{TYPE}_API_KEY`）。
  - `MODALITY_TASKS`（私有常量）：模态→taskType 固定映射。
  - `expandModalities(selectedModalities, supportedTaskTypes)`：展开并取交集。
  - `buildGenerationConfig(providerName, adapterType, models, apiKeyEnv?)`：构造 `GenerationConfig`（providers + defaults）。
- **接口 `GenerationWizardResult`**：`{skipped, config, envKey}`。
- **`runGenerationWizard(configManager)`**：选厂商（BUILTIN_ADAPTERS）→ 配 key（写全局 .env，复用 ConfigManager）→ 模态多选（从 capabilities 动态）→ 每 taskType 配模型 → 写全局 `~/.agent/generation.json`（合并保留其他厂商）。失败路径统一返回 skipped。
- **依赖方向**：`@clack/prompts`、`picocolors`、`node:fs/path/os`、`../generation/adapters/index`（BUILTIN_ADAPTERS）、`../generation/interface`、`../generation/config`（getGlobalGenerationConfigPath）、`./config`（ConfigManager）。

### 4.5 model-defaults.ts —— 模型默认值查询

- 常量 `PROVIDER_ALIAS`（google→gemini）。
- **接口 `ModelMeta`**：id/name/contextWindow/maxOutputTokens/reasoning。
- `buildProviderModels()`：经 `getModelCatalogLoader().getAll()` 构建 `provider → ModelMeta[]` 缓存。
- **`PROVIDER_MODELS`**：**已废弃**的 Proxy 对象，动态读 provider models（保留兼容）。
- `getModelContextWindow(provider, model?)` / `getModelMaxTokens(provider, model?)`：按 provider/模型从 catalog 查窗口或输出上限，带 `__default__` 特殊 id 与回退值。
- **依赖方向**：`./config`（DEFAULT_MAX_CONTEXT_TOKENS）、`../provider/model-catalog-loader`（getModelCatalogLoader）。

**index.ts（barrel）**：导出 ConfigManager/AgentConfig、SetupWizard、runGenerationWizard/suggestEnvKey/expandModalities/buildGenerationConfig/GenerationWizardResult、以及 persona 相关？—— 从代码看 index 导出 config、wizard、generation-wizard（persona-bootstrap 未在 index 公开，但 wizard.ts 直接 import './persona-bootstrap.js'）。

**测试文件**：`config.test.ts`（ConfigManager）、`persona-bootstrap.test.ts`、`generation-wizard.test.ts`（纯函数）+ `generation-wizard.integration.test.ts`（向导流程）。

---

## 5. src/cli/（1 文件 —— doctor.ts，约 310 行）

**职责**：`hyacinth doctor` 系统诊断 + 自动修复。纯 CLI，无 GUI。

**文件：`doctor.ts`**

- **数据结构**：`CheckResult`（label/ok/detail/fix）、`DoctorOptions`（fix/showPrompts）。
- **内部检查函数**（每个返回一个 CheckResult）：
  - `checkNodeEnv`：Node ≥22.5（node:sqlite 门槛）。
  - `checkEncoding`：Windows 终端 CODEPAGE 65001。
  - `checkPersona`：SOUL/IDENTITY/USER 是否存在。
  - `checkDeps`：`require.resolve` 检查 sharp/chokidar。
  - `checkNativeModule`：内存版 node:sqlite 自检（建表/插入）。
  - `checkConfig`：config.json 存在性 + JSON 可解析性。
  - `checkKnowledgeBase`：kb.sqlite + files/ 情况，读 docs 计数。
  - `checkApiKeys`：环境变量 + config.json 两路检测。
- **`loadOriginalPrompts()`**：从 `src/prompts/persona` 或 `dist/prompts/persona` 读取原始模板（不内嵌）。
- **`runDoctor(opts)`**：`--prompts` 显示原始提示词；默认跑 8 项检查，逐项打印 ✅/❌；汇总修复建议；`--fix` 时自动创建 persona 文件 + 缺失时 `pnpm install`，随后重跑 deps/persona/sqlite 三项验证。
- **依赖方向**：`node:os/fs/path/child_process`、`../tools/sqlite.js`。

---

## 6. 基础设施小模块

### 6.1 src/env/（2 文件）—— 系统环境收集与环境 section 构建

**`env-collector.ts`（约 280 行）**

- **接口 `SystemEnvInfo`**：os/arch/cpuModel/cpuCores/totalMemoryGB/gpu/python/nodeVersion/shell。
- **内部安全执行器 `safeExec(cmd, fallback)`**：execSync + 5s 超时，异常回退。
- **平台检测函数**：`detectGPU()`（优先 nvidia-smi；Windows 回退 Get-CimInstance，过滤虚拟显卡；linux/macOS 各一方案）、`detectPython()`、`detectShell()`、`detectCPUModel()`。
- `collectSystemInfo()`：模块级结果缓存（`cachedInfo`），一次性采集全部。
- `getSystemInfo()`：只读缓存。
- **接口 `ChannelsInfo`**：渠道名称/显示名/连接模式/DM/群组策略/requireMention/sessionId/isGroup。
- `formatEnvInfo(info, channels?)`：转发到 `buildEnvironmentSection`。
- **`buildEnvironmentSection(info, channels?, {cwd})`**：拼接三段 —— ① 静态模板文件（`loadEnvironmentStaticFiles`：读 `prompts/environment/environment.md`，走 `loadPrompt(skipCache:true)` 实现热加载，手动渲染 `{{cwd}}`/`{{globalConfigDir}}`）② 动态系统信息（`formatDynamicEnvInfo` markdown 列表）③ 渠道信息（`formatChannelsInfo`）。
- **依赖方向**：`node:os/path/child_process`、`../logging/logger`、`../prompts/loader`（loadPrompt/clearPromptCache/renderPrompt）。
- **`index.ts`**：导出 collectSystemInfo/getSystemInfo/formatEnvInfo/buildEnvironmentSection 及 SystemEnvInfo/ChannelsInfo 类型。
- **关键依赖方向**：本节直接被 prompt/环境 section 构造（runtime）消费，产出会注入 System Prompt 的 environment section。

### 6.2 src/logging/（2 文件）—— 结构化日志

**`logger.ts`（约 170 行）**

- **类型**：`LogLevel`（debug<info<warn<error）、`LogEntry`（ts/lvl/mod/msg/ctx/err）、`Logger` 接口（debug/info/warn/error/child）。
- **级别解析**：模块级 `_explicitLogLevel` + `_loggingOff`；`getMinLevel()` 优先级 **显式 setLogLevel > LOG_LEVEL env > info**。
- `setLogLevel(level | 'off')`：由 factory 在 RuntimeConfigCenter 初始化后调用，使配置中心成为日志级别权威来源；`'off'` 置 Noop 标志。
- **类 `ConsoleLogger`**：level 过滤 → 组装 LogEntry → **写 stderr**（stdout 预留给 Agent 输出，JSON lines 机器可读）；`child(extraModule, extraCtx)` 拼接模块名 + 合并默认 context 派生子 logger。
- **类 `NoopLogger`**：全空实现（测试/关闭时），并 `_NoopLogger` 重导出供测试引用。
- `createLogger(module)`：`LOG_LEVEL=off` 或 `_loggingOff` 时返回 Noop，否则返回 ConsoleLogger。
- **`index.ts`（barrel）**：导出 createLogger/ConsoleLogger/NoopLogger 及 Logger/LogLevel/LogEntry 类型。

### 6.3 src/prompts/（2 文件）—— 提示词加载器

**`loader.ts`（约 99 行）**

- 外部化原则：所有面向模型的提示词经此加载，不硬编码。
- 内部 `promptCache: Map` + `__dirname`。
- **`getExternalPromptsDir()`**：`~/.agent/prompts`。
- **`loadPrompt(name, {skipCache})`**：查找顺序 —— 外部目录精确路径 → 外部子目录 `{name}/{name}.md` → 外部递归 → 内置 dist 精确 → 内置子目录 → 内置递归；命中写缓存；`skipCache:true`（热加载时用）每次读盘；找不到抛错。
- **`tryLoadFromDir(dir, name)`**：三态精确/子目录/递归查找；`findPromptFile` 递归遍历 .md。
- `clearPromptCache()`：清空（被 prompt-watcher 调用）。
- `getPromptsDir()`：内置目录。
- `renderPrompt(template, vars)`：替换 `{{var}}` 占位符。
- **`summary.md`**：非代码文件 —— 供"按历史生成结构化摘要"的提示词模板（已完成/进行中/决策/文件变更/发现/时间线/状态分节）。

### 6.4 src/utils/（2 文件）—— 零依赖通用 helper

**`misc.ts`**（集中了从 dependency/analyzer、memory/session、gateway/cli、loop.ts 下沉的重复实现）：
- `hasTextContent` / `hasToolUseContent`（判定消息是否含文本 / tool_use）。
- `isSameTextMessage(a,b)`（按块序列比对 role + content 类型，image 分 base64/url 比较）——供 orchestrator/stages 复用避免循环依赖。
- `toProjectKey(cwd)`：把工作目录路径归一化为项目标识。
- `extractTextContent(content)`：提取纯文本跳过多余块。
- `formatDate` / `formatTimestamp`（YYYY-MM-DD / YYYY-MM-DD HH:mm，时间戳避免循环依赖下沉）。
- `computeProtectCount(messages, tokenBudget)`：从末尾累加 token 估算算保护条数（≥2）。
- `summarizeToolInput(input)`：工具输入摘要（key=截断值 80 字符）。
- **依赖方向**：仅 `../types`（Message 类型）。

**`diff.ts`**：文件 diff 计算（供 TUI 渲染，不进模型 context）。
- 类型 `DiffLineKind`（header/context/add/del）、`DiffLine`（kind/text/oldLine/newLine）。
- `computeDiff(oldText,newText,filePath)`：CRLF 归一化 → diff 包 `diffLines` → 逐行打标签与行号；超 50 行折叠打印前 20 行 + 省略信息。
- **依赖**：`diff`（npm 包）。

### 6.5 src/update/（6 文件）—— 自动更新

职责：从 GitHub 检查/下载/安装新版本。

- **`types.ts`**：`UpdateConfig`（repo/sourcePath）、`VersionInfo`（current/latest/publishedAt/needsUpdate）、`DownloadProgress`（percent/downloaded/total）。
- **`config.ts`**：`~/.agent/update.json` 的 `loadConfig`/`saveConfig` + `CONFIG_PATH`。
- **`check.ts`**：`checkForUpdate(repo, currentVersion, onStatus)`，请求 GitHub releases/latest，提取 tag 与 `.zip` asset，比较当前版本返回 `CheckResult/ null`。
- **`download.ts`**：`downloadWithProgress(url, destDir, onProgress)`，stream 读取 + 进度回调，写 `release.zip`。
- **`install.ts`**：`findExtractedDir(tmpDir)`（解开唯一子目录）、`installUpdate(extractedDir, installDir, onStatus)`（校验 dist/package.json → rm + cp 替换 dist → 比较 dependencies，有变则 cp package.json + `pnpm install --prod`）。
- **`index.ts`**（barrel）：重导出全部 + 类型。
- **依赖**：`node:fs/path/os/child_process`、node:fetch。

### 6.6 src/types/（1 文件 —— sharp.d.ts）

**职责**：`sharp` 的类型声明。声明模块 `sharp` 默认导出为 `any` 的缓和类型（避免项目缺少该原生模块类型时 TypeScript 报错），是 multimodal 动态 `import('sharp')` 的类型兼容层。这里与顶层 `src/types.ts`（承载业务核心类型）完全分离，该目录只做第三方模块的类型兜底。

---

## 7. 模块间关系与依赖方向汇总

**数据流总览**：

- **配置写路径**：`setup/wizard.ts`（用户交互）→ `setup/config.ts#ConfigManager.save/load` → `~/.agent/config.json` → `RuntimeConfigCenter`（运行时权威）→ `hot-reload/config-watcher`（监听）→ `configCenter.load()` 反向喂回。
- **热加载闭环**：外部文件变化 → 各 `watch*` watcher（watch/poll 模式经 `watcher-base`）→ reload 回调 → 对应 Registry/System/Composer 重载 → `HotReloadManager` 生命周期管理句柄。
- **多模态图片数据流**：用户输入 → `detectImagePaths`/压缩（`compressImageIfLarge`）→ `ImageStore.store`（去重索引）→ `buildUserContentWithImages(s)` 构造 `MessageContent` → Agent `view_image` 经 `pendingInjections` 回注。
- **媒体数据流**：生成工具/场景渲染产物 → `recordMediaFile`（失败不阻断）→ `MediaStore.importFile` → `media.sqlite + files/` → WebUI/serve 查询。
- **环境信息流**：`env-collector.collectSystemInfo` → `buildEnvironmentSection`（拼接静态模板 + 动态系统信息 + 渠道信息）→ 注入 System Prompt 的 environment section。

**依赖方向（只进不出 = 基础设施；双向 = 业务耦合）**：
- 纯粹的**被依赖基础设施**：`src/logging`（几乎全体依赖）、`src/types.ts`（类型）、`src/utils`（多模块）、`src/prompts/loader`（env/hot-reload 依赖）。
- **横向耦合**：`hot-reload/model-catalog-watcher` 依赖 `setup/model-defaults`；`setup/wizard` 依赖 `hot-reload`？否（wizard 依赖 persona-bootstrap、model-defaults、provider/config、runtime/defaults）；`hot-reload` 大量依赖各业务 Registry/System（agents/skills/tools/mcp/plugins/context/composer/provider/model-channel/bundle）。
- **刻意隔离**：`media` 与知识库（kb）完全隔离，是独立的可插拔模块（符合模块化原则：删除不影响主流程，落库失败不阻断）。
- `src/multimodal`、`src/update`、`src/cli` 依赖面窄、本身近乎自包含（仅依赖 logging/types/第三方工具），可独立测试、可移植性高。
