# 🪻 Hyacinth (风信子)

**多 Provider AI Agent 框架** — 可编程、可扩展、运行在本地的终端智能助手。

> TypeScript 6.0 · Node.js · 35 模块 · 82+ 工具 · 14+ LLM Provider

---

## 一句话

Hyacinth 是一个跑在终端里的 AI Agent。它可以**读写文件、执行命令、搜索代码、调用 API**——像一个有完全上下文感知能力的编程伙伴。

---

## 架构一览

```
用户输入 (TUI / CLI / 飞书 / 微信)
  │
  ▼
AgentLoop ── 主循环（每轮对话的核心引擎）
  │
  ├─ BypassManager.preTurn  ── 旁路Agent前置注入（意图识别、纠偏、世界引擎）
  ├─ ContextComposer         ── 5-Zone分层上下文组装（结构→历史→知识→时间→输入）
  ├─ Provider.callLLM        ── 多Provider适配（Anthropic/OpenAI/DeepSeek等14+）
  ├─ ToolExecutor            ── 工具执行（安全审查→执行→结果回传）
  └─ BypassManager.postTurn  ── 旁路Agent后置观察（记忆维护、偏差审查）
```

**核心设计原则：**

- **模块分层清晰** — 接口层 / 核心执行层 / Provider 层 / 工具层 / 基础设施层，依赖方向单向
- **上下文 5-Zone 体系** — Zone1 稳定身份 → Zone3 对话历史 → Zone4 知识库 → Zone5 实时输入，按变化频率分离缓存
- **旁路 Agent 独立运行** — 不占用主 Agent 上下文预算，异常隔离，状态跨轮保持
- **7 种上下文变更机制各司其职** — manifest 管结构、Router 管模式、Injection 管动态注入、Compressor 管预算保护、ContextSource 管数据供应、activeConditions 管条件开关、filterHistory 管消息过滤

---

## 能力

### 🤖 14+ LLM Provider

一键切换，无需改代码：

| Provider | 命令 |
|---|---|
| Anthropic Claude | `hyacinth --provider anthropic` |
| OpenAI GPT | `hyacinth --provider openai` |
| DeepSeek | `hyacinth --provider deepseek` |
| Google Gemini | `hyacinth --provider gemini` |
| 阿里通义千问 | `hyacinth --provider qwen` |
| 智谱 GLM | `hyacinth --provider zhipu` |
| MiniMax / MiMo / Groq / xAI / Mistral / OpenRouter / Moonshot | `--provider <name>` |
| 本地模型 (llama.cpp / Ollama) | `hyacinth --provider local --start-model` |

### 🛠 完整工具系统

| 层 | 来源 | 示例 |
|---|---|---|
| **内置工具** | 启动即注册 | `read` `write` `edit` `bash` `glob` `grep` `http_request` `git` `db_query` |
| **运行时控制** | AgentLoop 注入 | `switch_provider` `spawn_sub_agent` `toggle_tool` `add_task` `new_session` |
| **MCP 工具** | 动态桥接 | 第三方工具通过 MCP 协议接入，自动注册为可用工具 |

安全模型：危险工具（write/bash/http）需用户确认，支持白名单机制。

### 🤝 子 Agent 编排

三种协作模式：

| 模式 | 说明 |
|---|---|
| **委托 (delegate)** | 主 Agent 将任务分发给子 Agent，子 Agent 独立完成并返回结果 |
| **对抗 (adversarial)** | 两个子 Agent 从不同角度交叉审查同一任务 |
| **并行 (parallel)** | 同时启动多个子 Agent，各自处理不同子任务 |

每个子 Agent 拥有独立工具白名单、独立上下文、独立会话。主 Agent 负责规划和验收。

### 🔀 多渠道

| 通道 | 说明 | 状态 |
|---|---|---|
| **TUI** | 全屏终端界面（blessed），支持多面板、实时流式输出 | ✅ 稳定 |
| **CLI** | 命令行交互模式 + 单次执行 | ✅ 稳定 |
| **HTTP API** | Fastify Server，RESTful 接口 | ✅ 可用 |
| **飞书** | 飞书机器人，支持私聊和群聊 | ✅ 稳定 |
| **ClawBot** | 微信 AI 助手插件，二维码授权 | ✅ 可用 |

### 🔄 Flow 工作流

内置状态机引擎驱动结构化任务：

- **Todo 模式** — 任务拆解 → 步骤定义 → 逐个执行 → 完成验收
- **Spec 模式** — 需求规格撰写 → 任务清单 → 检查清单，三阶段推进

### 🔌 可扩展性

| 扩展方式 | 说明 |
|---|---|
| **Plugin** | `plugin.json` 声明 + PluginApi，可注册工具/Skill/MCP/渠道 |
| **MCP** | 标准 MCP 协议，stdio/SSE 双传输，崩溃自动重连，危险命令黑名单 |
| **Skill** | 可插拔的提示词模板，通过 `use_skill` 按需注入上下文 |
| **ContextSource** | 运行时注册数据源，runtime section 自动获取内容 |

### 🏗 基础设施

| 子系统 | 说明 |
|---|---|
| **上下文压缩** | 四阶段差分压缩（规则裁剪→结构化摘要→增量更新→保护区兜底），Token 预算保护 |
| **知识库** | SQLite FTS5 全文检索 + CJK bigram 分词 + Tag IDF 语义匹配 |
| **会话记忆** | 跨会话项目记忆，旁路 Agent 自动维护 |
| **热重载** | 8 个 Watcher：MCP/Plugin/Prompt/Config/Tool/Skill/Agent/Channel，修改即生效 |
| **定时调度** | Interval / Cron / Daily / Fixed-time / Random 五种调度策略 |
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
├── orchestrator/  # AgentLoop 主循环
├── provider/      # 14+ LLM Provider 适配
├── context/       # 5-Zone 上下文组装、压缩、Router、manifest
├── tools/         # 工具系统（内置 + 运行时 + MCP）
├── agents/        # 子 Agent 委托系统
├── bypass/        # 旁路 Agent（意图识别、纠偏、记忆维护）
├── memory/        # 会话/对话/事件/统计存储
├── knowledge/     # 知识库 FTS5 检索
├── plugins/       # 插件系统
├── skills/        # Skill 系统
├── mcp/           # MCP 协议集成
├── hot-reload/    # 热重载管理器
├── schedule/      # 定时任务调度
├── machine/       # Flow 状态机
├── channels/      # 多渠道消息处理
└── prompts/       # 提示词模板
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
