# Hyacinth 🪻

> npm **v1.0.0** · MIT · TypeScript · Node.js **≥ 22.5**（ESM） · **109** 内置工具 · **19** Provider 类型 · [npm 包](https://www.npmjs.com/package/hyacinth-ai) · [GitHub 仓库](https://github.com/yunru709/hyacinth)

**Hyacinth（风信子）** 是一个跑在本地终端里的多 Provider AI Agent：读写文件、执行命令、搜索与交叉引用分析代码、调用 API、运行本地模型，并能在 TUI / 飞书 / 微信 / WebUI 等渠道之间主动联系你。它记得你的项目，从内核到插件全链路可替换。

```
用户输入 → 输入归一化 → 旁路注入 → 5-Zone 上下文组装 → LLM 调用 → 工具执行 → 回合收尾
             ↑________________________ 每一轮走完六个阶段 ________________________↓
```

***

## 目录

- [简介](#简介)
- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用](#使用)
- [架构](#架构)
- [项目结构](#项目结构)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

***

## 简介

Hyacinth 是一个**可编程、可扩展的智能体框架**。它把 Agent 的每个环节——工具、上下文、Provider、渠道、记忆、规划、插件——都抽象成可替换的模块，通过**注册表装配**而非硬编码连接。三条贯穿全项目的设计主线：

- **内核零业务**：`kernel/` 只提供管道 / 钩子总线 / 插件宿主 + 安全内核，业务能力全部以插件、贡献批、内核槽位的形式挂载。
- **注册而非硬编码**：所有可替换点集中在 `supervisor/extension-registry.ts`，装配顺序由 `gateway/assembly-graph.ts` 声明并用 Kahn 拓扑排序执行；分层约束（内核零业务依赖、装配层禁止直接 new 业务类）由 `scripts/verify-layers.mjs` 机器校验。
- **旁路 Agent 元认知层**：独立的意图识别 / 纠偏 / 记忆维护进程，异常隔离、工具白名单极窄，与主循环解耦。
- **渠道即能力**：消息可在任意已连接渠道间借道分发（`send_channel_message`），不创建会话、不写入记录。

***

## 特性

### 工具系统（109 个内置工具，另可动态接入 MCP / 插件工具）

- **基础文件 / 命令**：`read` / `write` / `edit` / `multi_edit` / `insert` / `bash` / `glob` / `grep` / `probe` / `diff_files` / `json_edit` / `archive` / `disk_usage` / `system_info` 等。
- **代码智能**：`xref_build` / `xref_query` / `xref_graph` / `xref_list`（基于 tree-sitter 的跨文件交叉引用索引，支持 10 种查询：引用 / 定义 / 调用 / 依赖 / 影响面 / 数据流），`verify_change`（类型检查 + 定向测试一条龙），`plan_execute`（结构化预测断言的批量执行）。
- **子 Agent 编排**：`delegate_to_agent` / `spawn_sub_agent` / `create_sub_agent` / `destroy_sub_agent`，支持委托、并行（克隆多实例）、异步（后台句柄）三种协作模式。
- **运行时控制**：`switch_provider` / `new_session` / `session_fork` / `create_bundle` / `add_task` / `rollback` / `flow_start` / `enter_goal` / `ask_user` / `interrupt` / `say` 等一整套自管理工具。
- **可扩展**：MCP（`mcp__{server}__{tool}` 动态注册）、Python 桥接（`docx_read` / `xlsx_read`）、目录插件与 `world_*` 动态注册。
- **大结果不塞爆上下文**：超阈值自动写磁盘缓冲，回传指针消息引导模型分段读取。
- **工具包机制**：14 个内置包（`all` / `common` / `coding` / `agent` / `admin` / `session` / `workflow` / `utility` / `companion` / `office` / `database` / `knowledge` / `schedule` / `media`），按需激活以控制每轮请求的 schema token 开销。

### 多 Provider（19 种类型）

`anthropic` / `openai` / `deepseek` / `groq` / `xai` / `mistral` / `gemini` / `openrouter` / `moonshot` / `qwen`（阿里百炼）/ `zhipu`（智谱）/ `minimax` / `mimo`（小米）/ `volcengine`（火山方舟）/ `opencode` / `commandcode`（聚合中转），以及本地三型 `local` / `ollama` / `llamacpp`。

- 弹性链：**重试 + 熔断 + 降级 + 工具参数自动恢复**；运行时可 `registerProviderFactory()` 外置扩展厂商，或用 `~/.agent/providers.json` 纯声明式零代码接入。
- 本地后端支持 llama.cpp / Ollama / vLLM / LM Studio / custom（OpenAI 兼容，按端口自动推断）。
- 模型通道（`model-channels.json`）把压缩 / 规划 / 评估 / 旁路 / 子 Agent 等角色映射到不同厂商模型。

### 多渠道

TUI / CLI / HTTP API（Fastify）/ WebUI，以及**飞书**（WebSocket 长连接）与**微信 ClawBot**（http-polling）两个插件渠道——统一经 `ui-protocol`（UI 契约层，23 个业务域）连接。

### 可观测与自管理

- **安全内核**：命令 / 进程 / 网络三裁决 + 环境变量密钥防护（防泄入子进程）+ 审计日志，安装先于一切业务模块。
- **回滚**：逐回合 git 锚点，`rollback` / `rollback_status` 精确回退文件变更。
- **自修复**：文本循环检测（滑动窗口 Jaccard）、工具风暴抑制、会话垃圾清理。
- **热重载**：15 个 Watcher（配置 / 插件 / 工具 / 技能 / MCP / 名单 / 记忆清单等），改文件即生效。
- **定时调度**：`interval` / `cron` / `daily` / `fixed-time` / `random` 五种，支持跨渠道主动推送。
- **记忆**：会话存储族 + 跨会话项目记忆 + 5-Zone 分层上下文 + 四阶段压缩。

***

## 安装

### 前置要求

- **Node.js ≥ 22.5**（`node:sqlite` 为内置模块，低于此版本启动即报错）
- **pnpm**（本仓库唯一受支持的包管理器）
- **Windows 从源码构建**还需：**VS Build Tools**（“使用 C++ 的桌面开发”工作负载）+ **Python 3** —— `tree-sitter-*`、`sherpa-onnx-node`、`sharp` 安装时走 node-gyp 编译，缺工具链 `pnpm install` 会失败。

### npm（全局）

```bash
npm install -g hyacinth-ai
```

要求 **Node.js ≥ 22.5**（知识库 / xref / db_query 依赖内置 `node:sqlite`）。

### 从源码构建

> 本仓库**必须用 pnpm**：`npm install` 会执行 `tree-sitter-cli` 的构建脚本并失败。

```bash
git clone https://github.com/yunru709/hyacinth
cd hyacinth
pnpm install
pnpm build
```

***

## 快速开始

```bash
hyacinth setup     # 交互式配置向导（含 persona 初始化）
hyacinth doctor    # 系统诊断（--fix 自动修复）
hyacinth tui       # 全屏 TUI
hyacinth "帮我看看这个项目是做什么的"
```

### 配置 API Key

在项目目录或 `~/.agent/` 下创建 `.env`：

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

密钥自动注册进安全内核，不会泄入子进程。

### 本地模型（可选）

```bash
pnpm run setup:llamacpp   # 一键编译 llama.cpp
hyacinth -p local --start-model --model "qwen2.5-coder:7b"
hyacinth -p local         # 连接已运行的本地服务
```

### 终端要求（Windows）

TUI 依赖 Unicode 渲染，推荐 [Windows Terminal](https://github.com/microsoft/terminal)（Win11 自带）。旧控制台（cmd/conhost）下 emoji 和框线可能乱码，可用 `pnpm start:win` 缓解。macOS / Linux 各终端开箱即用。

***

## 使用

### CLI 命令

| 命令 | 说明 |
| --- | --- |
| `hyacinth [prompt]` | 单次执行或进入交互（`-i` 强制交互、`-p/--provider`、`-m/--model`、`--session <id>`、`--continue`） |
| `hyacinth setup` / `setup-generation` | 配置向导 / 生成能力向导（图 / 视频 / 音频厂商） |
| `hyacinth doctor [--fix]` | 系统诊断 + 自动修复 |
| `hyacinth tui` | 全屏终端界面（`--guardian` 守护开关） |
| `hyacinth serve` | HTTP API（`--port 3000`、`--api-key`、`--lan`、`--webui`、`--webui-port 3100`，默认绑定 127.0.0.1） |
| `hyacinth webui` | 等价 `serve --webui`，自动开浏览器 |
| `hyacinth session list/delete/export` | 会话管理 |
| `hyacinth config get/set/schema/reset` | 配置管理（dot-path） |
| `hyacinth model switch/list/info` | Provider 与模型管理 |
| `hyacinth skill enable/disable/list` / `tool enable/disable/list` | 技能 / 工具开关（黑名单机制） |
| `hyacinth arch list/get/toggle` | 可替换点目录与插件启停（serve 运行中热生效） |
| `hyacinth plugin install/list/uninstall` | 插件管理（本地目录或 git URL → `~/.agent/plugins/`） |
| `hyacinth supervisor-status` | Guardian 状态 / 重启存档 / 残留诊断 |
| `hyacinth backup [label]` | git bundle + tag 双保险快照 |
| `hyacinth update [--rollback]` | GitHub Release / 本地源更新 |

隐藏旗标 `--no-guardian` 跳过守护进程直接运行主进程。

### 配置体系

- **全局 `~/.agent/`** — `config.json`（主配置）、`.env`（密钥）、`providers.json`（厂商）、`model-channels.json`（模型通道）、`tool-bundles.json`（工具包）、`agents.json`（子 Agent）、`mcp.json`、`plugins.config.json`、`extension-registry.json`（扩展名单）、`context-manifest.json`（上下文分层清单）、`models.json`（本地模型目录），以及 `modes/`、`prompts/`、`skills/`、`tools/`、`plugins/`、`sessions/`、`media/`、`knowledge/` 等。
- **项目 `<cwd>/.agent/`** — 仅**数据面**走项目级：`modes/`（同名覆盖全局）、`specs/`（Flow 规格）、`backups/`。**配置本身不设项目级**——`ConfigManager` 只读 `~/.agent/config.json`。
- **项目根 `commands.json`** — 斜杠命令，模型可经 write/edit 修改并热重载。

配置一律走**运行时配置中心**（`update_config` / `reset_config`），手改 `config.json` 会被内存快照覆盖。

***

## 架构

### 启动链

```
src/index.ts
  ├─ bootstrapSecurity()      # 安全内核先于一切业务模块（守卫 child_process/http/fetch，canary 校验）
  └─ 动态 import runCli()     # ESM 具名导入在守卫变异之后创建
       └─ executeAction()
            ├─ Provider 创建 → AgentLoop 装配（gateway/agent-assembly.ts）
            │    ├─ boot()                  # 配置加载 + 会话恢复三分支
            │    ├─ 贡献批依序装配            # base → infra → channel → context-chain → orchestrator → core
            │    │                           # → 插件管理 → arch 替换(provider/router/agent) → service/slot
            │    │                           # 替换 → 插件 → loop 依赖工具 → runtime → source 替换（最晚）
            │    └─ new AgentLoop(...)       # provider:main 替换必须在 Loop 构造前完成
            └─ Guardian 守护（默认启用）      # 退出码 42=重启 43=更新 44=插件热更新兜底
```

### 主循环：六槽管道

一轮 turn 的执行顺序（`orchestrator/loop.ts` 的 `runTurn()`）：

```
onTurnStart → TurnRecorder 回滚锚点 → Router 同步
  → slot:input    历史读入 + 输入归一化
  → slot:bypass   旁路 Agent 前置注入（意图识别、Zone5 动态注入）
  → slot:context  5-Zone 组装 + 压缩触发
  → slot:llm      Provider 调用（流式消费、fallback、stats 落盘）
  → slot:tools    工具执行（并行 + 权限门 + 结果缓冲）
  → slot:finalize Flow 状态机推进 + 文本循环检测
每轮迭代后：bypass postTurn 后台观察（不阻塞）
turn 结束后：簇归类消费 → 历史回填 → 图片回收
```

### 上下文：5-Zone 分层

按变化频率分离缓存（定义于 `context/manifest-defaults.ts`，可用 `~/.agent/context-manifest.json` 覆盖）：

| Zone | 内容 | 特征 |
| --- | --- | --- |
| **1 Anchor** | persona / tool_rules / tool_bundles / skills / agents / mcp / memory / attention | 稳定锚点 |
| **2 Manifest** | （默认关闭） | 供需要独立缓存断点的 Provider |
| **3 History** | project_context（`.agent.md` / `AGENTS.md`）/ history_summary / history | 对话历史 |
| **4 Context** | kb_context（知识库检索结果） | 可关闭省 token |
| **5 Live** | flow / channel_context / timestamp / user_input / orchestrator_hint | 每轮变化 |

### 监督与替换：架构注册表

`supervisor/extension-registry.ts` 维护 **47 个可替换点**（`REPLACEABLE_POINTS`）：6 个内核 pipeline 槽位、22 个 service、`provider:main`、2 个 router、10 个 context source，以及 `adapter:*` / `channel:*` / `tool:*` / `skill:*` / `agent:*` / `plugin:*` 六个动态族。

裁决链：**用户配置 > 插件 priority > 插件 ID > 内置基线**。替换在 `gateway/arch-assembly.ts` 应用（动态 import + 形状校验 + 记录生效/失败），名单文件 `~/.agent/extension-registry.json` 支持 serve 运行中热生效。

> 完整的逐文件拆解见 [docs/architecture.md](docs/architecture.md)。

***

## 项目结构

`src/` 下 **44 个模块目录**按域分组：

| 域 | 模块 | 职责 |
| --- | --- | --- |
| **启动与监督** | `gateway/` | 装配层：cli / tui / server 入口 + factory + agent-assembly + arch-assembly + 装配贡献批 |
| | `supervisor/` | 架构监督：assembly-registry 出厂图、extension-registry 名单裁决、guardian 守护、重启协议、优雅关闭 |
| | `kernel/` | 内核三件套（pipeline / hook-bus / plugin-host）+ `security/` 安全内核 |
| | `update/` `diagnostics/` `setup/` `env/` | 自更新；doctor 诊断 + 自动修复；首启向导（含 persona 初始化）；环境采集 |
| **内核执行链** | `orchestrator/` | AgentLoop 主循环 + 6 阶段 stages/ + TurnState + planner + plan-store |
| | `provider/` | 19 种 Provider 适配、路由、弹性链、模型目录 |
| | `context/` | 5-Zone、manifest、composer、compressor、router、cache-strategy、tokenizer |
| | `tools/` | 内置工具 + 运行时控制工具族 + 注册表 / 执行器 / 沙箱 / 结果缓冲 + `xref/` `plan-execute/` `python-bridge/` |
| | `registry/` `parser/` `prompts/` | GenericRegistry 基座 + Tool/Skill/Agent 三注册表；流式事件输出路由；提示词模板库 |
| **记忆与进化** | `memory/` `knowledge/` `evolution/` | 会话存储族 + 跨会话记忆 + 摘要；知识库（FTS5 + 结构化库 + watcher）；GitManager + AutoGit + bundle/tag 备份 |
| | `rollback/` `repair/` | 逐回合回滚账本；死循环检测 / 风暴抑制 / 垃圾清理 |
| **能力域（插件化）** | `plugins/` `plugin-sdk/` | 插件运行时（loader / manager / adapter + 内核插件）；插件契约面（自包含零内部 import） |
| | `bypass/` `agents/` | 旁路 Agent 基座（BypassManager + ContextOrchestrator）；子 Agent 定义 / 注册 / delegate |
| | `companion/` `world-engine/` `skills/` `mcp/` | 陪伴语音台词库；世界引擎；技能系统；MCP 桥接（stdio + SSE） |
| | `local-model/` `generation/` `media/` `multimodal/` | 本地模型托管与下载；生成供应商层（图 / 视频 / 音频）；媒体库；图片管线 |
| | `machine/` `schedule/` `dependency/` | Flow 状态机；定时调度；依赖分析 |
| **交互界面** | `channels/` | ChannelManager + TUI / HTTP 内置渠道 + feishu / clawbot 插件渠道 + 跨渠道分发 |
| | `ui/` `ui-protocol/` `webui/` | TUI 组件；UI 契约层：统一 RPC + 事件（23 域）；WebUI 静态前端 |
| **基础设施** | `hot-reload/` `lifecycle/` `runtime/` `logging/` `utils/` `shims/` | 15 Watcher 家族；受管进程状态；运行时配置中心；日志器；通用工具；类型兜底 |

### 关键数量（读一次源码即知，勿记快照）

- 内置工具 **109**（+ MCP / 插件动态工具）
- Provider 类型 **19**
- 模块目录 **44**，装配条目 **44**，可替换点 **47**，ui-protocol 域 **23**，热重载 Watcher **15**
- 测试文件 **231**（`vitest run` 输出为准）

***

## 文档

| 文档 | 说明 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构单源文档（总览 + 逐文件拆解） |
| [docs/plugin-sdk.md](docs/plugin-sdk.md) | 插件开发契约 |
| [docs/security-kernel.md](docs/security-kernel.md) | 安全内核设计 |
| [docs/api.md](docs/api.md) | HTTP API 参考 |
| [docs/user-guide.md](docs/user-guide.md) | 用户指南 |
| [docs/design/](docs/design/) | 设计决策记录（被代码注释按「文档名 §章节」引用，勿改名） |

## 参与贡献

> 本仓库**必须用 pnpm**（`packageManager: pnpm@10.25.0`）——`npm install` 会触发 `tree-sitter-cli` 的构建脚本并失败。

```bash
git clone https://github.com/yunru709/hyacinth
cd hyacinth
pnpm install
pnpm build          # tsc + clean-stale + copy-prompts + copy-webui + clean-tests + clean-maps + copy-grammars
pnpm dev            # tsc --watch 模式
pnpm test           # vitest（231 个测试套件）
pnpm smoke          # 真实装配链冒烟（stub provider）
pnpm verify:layers  # 分层约束机器校验
```

提交前请确保 `pnpm test` 与 `pnpm verify:layers` **同一次状态双绿**。分层约束是硬性规则（内核零业务依赖、装配层禁止直接 `new` 业务类），新增模块请先对照 [docs/architecture.md](docs/architecture.md) 的依赖边界。

## 许可证

[MIT](./LICENSE) · Copyright © 2026 孑遗
