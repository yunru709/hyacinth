# 🪻 Hyacinth (风信子)

**多 Provider AI Agent** — 可编程、可扩展、可信任的终端智能助手。

> TypeScript 6.0 · Node.js · 37 模块 · 82+ 工具 · 14+ LLM Provider

---

## 特性

### 🤖 多模型支持
14+ Provider 一键切换 — Anthropic、OpenAI、DeepSeek、Google Gemini、阿里通义千问、智谱 GLM、MiniMax、MiMo、Groq、xAI、Mistral、OpenRouter、Moonshot，以及本地模型（llama.cpp / Ollama）。

### 🛠 工具系统（三层架构）
| 层 | 来源 | 数量 | 示例 |
|---|---|---|---|
| **内置工具** | 启动即注册 | 17+ | `read`、`write`、`bash`、`grep`、`edit`、`glob`、`http_request`、`git` |
| **运行时控制** | AgentLoop 注入 | 35+ | `switch_provider`、`spawn_sub_agent`、`toggle_tool`、`session` 管理 |
| **MCP 工具** | 动态桥接 | 动态 | `mcp__chrome-devtools__navigate` 等第三方工具 |

所有工具通过统一注册表管理，支持热插拔、权限白名单、子 Agent 隔离。

### 🔀 多渠道
| 通道 | 类型 | 状态 |
|---|---|---|
| **TUI** | 全屏终端界面 | ✅ 稳定 |
| **Feishu (飞书)** | 机器人 | ✅ 稳定 |
| **ClawBot** | 消息通道 | ✅ 可用 |
| **HTTP Webhook** | Webhook 接入 | ✅ 可用 |

### 🤝 子 Agent 编排
- 委托式协作：主 Agent 将任务分发给子 Agent
- 对抗式协作：多 Agent 辩论验证
- 并行执行：同时处理多个子任务
- 独立工具白名单、独立上下文、独立 Session

### 🔄 Flow 工作流
内置 Flow 引擎驱动结构化任务执行：
- **Todo 模式** — 任务拆解 → 步骤定义 → 逐个执行
- **Spec 模式** — 需求规格 → 任务清单 → 验收检查

### 🔌 插件 + MCP + Skill
- **插件系统**：`plugin.json` + `PluginApi`，可注册工具/Skill/MCP Server/渠道
- **MCP 协议**：桥接第三方工具生态，stdio/SSE 双传输，崩溃自动重连
- **Skill 系统**：可插拔的提示词模板，按需注入上下文

### 🏗 基础设施
| 子系统 | 说明 |
|---|---|
| **MCP** | 第三方工具桥接，安全沙箱，危险命令黑名单 |
| **知识库** | SQLite FTS5 全文检索 + CJK bigram 分词 + Tag IDF 语义匹配 |
| **热重载** | 8 个 Watcher：MCP/Plugin/Prompt/Config/Tool/Skill/Agent/Channel |
| **调度器** | Interval / Cron / Daily / Fixed-time / Random 五种调度 |
| **回滚** | 按回合回滚文件更改 (git-driven) |
| **自修复** | Loop 死循环检测、风暴抑制、会话垃圾清理 |
| **自更新** | GitHub Release / 本地编译两种更新路径 |
| **守护进程** | 子进程退出 code 42 时自动拉起 |

### 📦 注册表体系
所有可扩展点共享同一基类 `GenericRegistry<T>`：

```
ToolRegistry     → 工具注册
SkillRegistry    → 技能注册
AgentRegistry    → 子 Agent 注册
PluginRegistry   → 插件注册
ProviderRegistry → Provider 注册
ChannelRegistry  → 渠道注册
MachineRegistry  → Flow 注册
```

## 快速开始

### 安装

```bash
# 全局安装
npm install -g hyacinth-ai

# 或直接用 npx
npx hyacinth-ai
```

### 首次使用

```bash
# 运行配置向导
hyacinth setup

# 启动 TUI 界面
hyacinth tui

# 直接对话
hyacinth "帮我检查一下这个目录"
```

### 配置 API Key

创建 `.env` 文件：

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=...
```

或通过命令行：

```bash
hyacinth --set ANTHROPIC_API_KEY=sk-ant-...
```

## 支持的 Provider

| Provider | 环境变量 | 默认模型 |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o |
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-V4 |
| Google Gemini | `GEMINI_API_KEY` | gemini-2.5-flash |
| 阿里通义千问 (Qwen) | `QWEN_API_KEY` | qwen-plus |
| 智谱 GLM (Zhipu) | `ZHIPU_API_KEY` | glm-4-plus |
| MiniMax | `MINIMAX_API_KEY` | minimax-text-01 |
| MiMo | `MIMO_API_KEY` | mimo |
| Groq | `GROQ_API_KEY` | llama-3.3-70b-versatile |
| xAI (Grok) | `XAI_API_KEY` | grok-2 |
| Mistral | `MISTRAL_API_KEY` | mistral-large-latest |
| OpenRouter | `OPENROUTER_API_KEY` | auto |
| Moonshot | `MOONSHOT_API_KEY` | moonshot-v1-8k |
| Local (llama.cpp) | — | 本地模型路径 |

## CLI 命令

```bash
hyacinth                        # 交互模式
hyacinth <prompt>               # 单次执行
hyacinth --provider deepseek    # 指定 Provider
hyacinth --tui                  # 全屏 TUI 模式
hyacinth serve                  # 启动 HTTP API Server
hyacinth setup                  # 配置向导
hyacinth doctor                 # 系统诊断
hyacinth session list           # 会话管理
hyacinth config get/set         # 配置管理
hyacinth model switch/list      # 模型管理
hyacinth skill enable/disable   # Skill 管理
hyacinth tool enable/disable    # 工具管理
hyacinth update                 # 自更新
```

## 开发

```bash
# 依赖安装
pnpm install

# 编译
pnpm build

# 开发模式（监听）
pnpm dev

# 测试
pnpm test

# Windows 启动
pnpm start:win
```

## 许可证

[MIT](./LICENSE)

Copyright © 2026 孑遗
