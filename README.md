# 🪻 Hyacinth (风信子)

**多 Provider AI Agent 框架** — 可编程、可扩展、运行在本地的终端智能助手。

> TypeScript 6.0 · Node.js · 35 模块 · 82+ 工具 · v0.9.33
>
> 📦 npm: [`hyacinth-ai`](https://www.npmjs.com/package/hyacinth-ai) · 🐙 源码: [github.com/yunru709/hyacinth](https://github.com/yunru709/hyacinth)

---

## 一句话

Hyacinth 是一个跑在终端里的 AI Agent。它可以**读写文件、执行命令、搜索代码、调用 API**——像一个有完全上下文感知能力的编程伙伴。它跑在你的机器上、记得你的项目、能跨渠道主动联系你。

---

## 架构一览

```
用户输入 (TUI / CLI / 飞书 / 微信 / WebUI)
  │
  ▼
AgentLoop ── 主循环（每轮对话的核心引擎）
  │
  ├─ BypassManager.preTurn  ── 旁路Agent前置注入（意图识别、纠偏、世界引擎）
  ├─ ContextComposer         ── 5-Zone分层上下文组装（结构→历史→知识→时间→输入）
  │                            └─ precision 精确模式 / 意图簇摘要
  ├─ Provider.callLLM        ── 多Provider适配（Anthropic/OpenAI/DeepSeek等14+）
  ├─ ToolExecutor            ── 工具执行（安全审查→执行→结果回传）
  └─ BypassManager.postTurn  ── 旁路Agent后置观察（记忆维护、簇归类、偏差审查）
```

**核心设计原则：**

- **模块分层清晰** — 接口层 / 核心执行层 / Provider 层 / 工具层 / 基础设施层，依赖方向单向
- **上下文 5-Zone 体系** — Zone1 稳定锚点（persona/工具规则/技能/MCP/记忆）→ Zone3 对话历史 → Zone4 知识库 → Zone5 实时输入，按变化频率分离缓存；Zone2(Manifest) 供需独立缓存断点的 Provider 使用
- **旁路 Agent = 系统元认知层** — 独立运行、异常隔离、工具白名单极窄（只给专一化工具，不给通用工具），直接注入主 Agent 上下文
- **7 种上下文变更机制各司其职** — manifest 管结构、Router 管模式、Injection 管动态注入、Compressor 管预算保护、ContextSource 管数据供应、activeConditions 管条件开关、filterHistory 管消息过滤
- **渠道即能力，会话即入口** — 消息可在任意已连接渠道间借道分发（飞书 → TUI → WebUI），不再受"请求-回复"限制

---

## 能力

### 🛠 完整工具系统

| 层 | 来源 | 示例 |
|---|---|---|
| **内置工具** | 启动即注册 | `read` `write` `edit` `bash` `glob` `grep` `http_request` `git` `db_query` |
| **运行时控制** | AgentLoop 注入 | `switch_provider` `spawn_sub_agent` `toggle_tool` `add_task` `new_session` `send_channel_message` |
| **MCP 工具** | 动态桥接 | 第三方工具通过 MCP 协议接入，自动注册为可用工具 |

安全模型：危险工具（write/bash/http）需用户确认，支持白名单机制。

### 🤝 子 Agent 编排

三种协作模式 + 异步后台执行：

| 模式 | 说明 |
|---|---|
| **委托 (delegate)** | 主 Agent 将任务分发给子 Agent，子 Agent 独立完成并返回结果 |
| **对抗 (adversarial)** | 两个子 Agent 从不同角度交叉审查同一任务 |
| **并行 (parallel)** | 同时启动多个子 Agent，各自处理不同子任务 |
| **异步 (async=true)** | 子 Agent 后台运行，主 Agent 立即拿到句柄继续干活，结果两种方式回收：回合内自动注入 / `get_sub_agent_result` 跨轮次手动获取 |

每个子 Agent 拥有独立工具白名单、独立上下文、独立会话，会话在 TTL 窗口内持久化可复用。主 Agent 负责规划和验收。

### 🔀 多渠道 + 跨渠道分发

| 通道 | 说明 | 状态 |
|---|---|---|
| **TUI** | 全屏终端界面（blessed），支持多面板、实时流式输出 | ✅ 稳定 |
| **CLI** | 命令行交互模式 + 单次执行 | ✅ 稳定 |
| **HTTP API** | Fastify Server，RESTful 接口 | ✅ 可用 |
| **飞书** | 飞书机器人，私聊/群聊 + 图片发送，chatId 持久化可主动推送 | ✅ 稳定 |
| **ClawBot** | 微信 AI 助手插件，二维码授权 | ✅ 可用 |

**跨渠道消息分发**（v0.9.20+）：Agent 可从任意会话借用任意已连接渠道的发送能力——比如在 TUI 里让飞书给你推个消息、在飞书会话里操作 WebUI。彻底打破"渠道 = 单一对话线"的限制。

### 🔄 Flow 工作流

内置状态机引擎驱动结构化任务：

- **Todo 模式** — 任务拆解 → 步骤定义 → 逐个执行 → 完成验收
- **Spec 模式** — 需求规格撰写 → 任务清单 → 检查清单，三阶段推进

Flow 状态持久化（v0.9.33+）：活跃 Flow 自动保存到 `flow-state.json`，进程崩溃/重启后自动恢复，不丢进度。

### 🧠 上下文智能

- **precision 精确模式** — 免检索的按相关性选历史：LLM 异步分析对话 → 提取全局关键词 + 每 turn 摘要 → 下次组装只保留相关旧消息，省 Token 不丢上下文
- **意图簇摘要** — 旁路 Agent 识别当前意图（coding/chat/tool_use/...），按簇注入对应摘要，替代通用 historySummary
- **trigger_compression deep 模式** — 需要激进释放空间时，用内置极度精简模板压缩，完成后自动恢复

### 🔌 可扩展性

| 扩展方式 | 说明 |
|---|---|
| **Plugin** | `plugin.json` 声明 + PluginApi，可注册工具/Skill/MCP/渠道 |
| **MCP** | 标准 MCP 协议，stdio/SSE 双传输，崩溃自动重连，危险命令黑名单 |
| **Skill** | 可插拔的提示词模板，通过 `use_skill` 按需注入上下文 |
| **ContextSource** | 运行时注册数据源，runtime section 自动获取内容 |
| **训练系统** | Python LoRA 微调管线（Unsloth + SQLite），把真实会话数据清洗成训练样本，微调结果可被本地模型热加载 |

### 🏗 基础设施

| 子系统 | 说明 |
|---|---|
| **上下文压缩** | 四阶段差分压缩（工具输出裁剪→结构化摘要→增量更新→保护区兜底），Token 预算保护 |
| **知识库** | SQLite FTS5 全文检索 + CJK bigram 分词 + Tag IDF 语义匹配（Node 内置 node:sqlite，零编译） |
| **会话记忆** | 跨会话项目记忆，旁路 Agent 自动维护；`conversation_full.jsonl` 全量存档永不压缩，供意图簇标记 |
| **热重载** | 13 个 Watcher：MCP/Plugin/Prompt/Agent/Config/Tool/Skill/Command/Provider/ModelCatalog/Channel/Manifest/Bundle，修改即生效 |
| **定时调度** | Interval / Cron / Daily / Fixed-time / Random 五种策略；Random 支持时间窗口、可变次数（U 形分布）、概率权重；多实例共享任务文件 |
| **回滚** | 按回合回滚文件变更（Git 驱动），支持 rollback/rollback_status |
| **自修复** | Loop 死循环检测、风暴抑制、会话垃圾清理 |
| **自更新** | GitHub Release / 本地编译两种路径 |
| **守护进程** | 子进程异常退出自动拉起 |

---

## 快速开始

```bash
# 安装
npm install -g hyacinth-ai

# 首次配置
hyacinth setup

# 启动 TUI
hyacinth tui

# 或直接对话
hyacinth "帮我看看这个项目是做什么的"
```

### 终端要求（Windows）

TUI 界面渲染依赖 Unicode 字符（emoji、框线、进度符号）。Windows 上**推荐使用 [Windows Terminal](https://github.com/microsoft/terminal)**：

- Windows 11 已自带，无需安装
- Windows 10 或旧系统：`winget install Microsoft.WindowsTerminal` 或 Microsoft Store 搜索 "Windows Terminal"

如果用**旧版控制台**（cmd 直接打开、经典 conhost）运行，emoji 和特殊符号可能显示成方块/乱码。启动时如果检测到旧终端，Hyacinth 会打印提示。也可通过 `start:win`（`chcp 65001` + UTF-8）缓解部分编码问题。

> 其他平台（macOS 的 Terminal/iTerm、Linux 各终端）一般无此问题，均开箱即用。

### 配置 API Key

在项目目录或 `~/.agent/` 下创建 `.env`：

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

---

## 开发

```bash
git clone <repo-url>
cd hyacinth

pnpm install
pnpm build
pnpm dev    # 开发模式（watch）
pnpm test   # 运行测试
```

**项目结构：**

```
src/
├── gateway/       # CLI/TUI 入口、Agent 工厂装配
├── orchestrator/  # AgentLoop 主循环、异步子Agent任务
├── provider/      # 14+ LLM Provider 适配、自动路由
├── context/       # 5-Zone 上下文、压缩、Router、precision、manifest
├── tools/         # 工具系统（内置 + 运行时 + MCP）
├── agents/        # 子 Agent 委托系统
├── bypass/        # 旁路 Agent（元认知层：意图识别、记忆维护、簇归类）
├── memory/        # 会话/对话/事件/统计存储
├── knowledge/     # 知识库 FTS5 检索
├── channels/      # 多渠道 + MessageDispatcher 跨渠道分发
├── machine/       # Flow 状态机 + 持久化
├── schedule/      # 定时任务调度（五策略 + 随机增强）
├── plugins/       # 插件系统
├── skills/        # Skill 系统
├── mcp/           # MCP 协议集成
├── hot-reload/    # 热重载管理器
├── world-engine/  # 陪伴模式世界模拟
└── prompts/       # 提示词模板

training/          # Python LoRA 微调管线（独立于 TS 主程序）
```

---

## 下一步计划

### 🖥 UI：WebUI 优先

下一步的设计重心是**用户界面**，首选 **WebUI** 形态。让 Hyacinth 从纯终端工具走向可视化产品，降低使用门槛。

### 🎨 多模态 Provider

同步推进 **provider 层支持图片/视频生成供应商**（如 DALL·E / Stable Diffusion / 视频生成类）。为可视化 UI 提供内容产出能力。

### 💬 陪伴模式可视化

在上述两者基础上，实现**陪伴模式的可视化**——世界模型、角色、场景从纯文本走向可视化呈现。

### 🧠 关于提示词工程

原本的计划是进一步调整、细化系统提示词。但实践中发现：**能力足够强的模型，似乎已经不太需要额外告诉它如何组合使用基建**。

随着模型能力的提高，灵活调用各类工具正在成为 LLM 元认知的一部分——工具组合不再是被"提示词教出来的"，而是模型自身推理能力的一部分。相信在不远的将来，绝大多数可被描述、可被执行的流程化步骤，都可以被模型吸收为元认知，而无需人工精心编排提示词。

---

## 许可证

[MIT](./LICENSE) · Copyright © 2026 孑遗
