# 用户指南

## 安装

```bash
# npm 全局安装
npm install -g hyacinth-ai

# 或从源码构建
git clone https://github.com/yunru709/hyacinth
cd hyacinth
pnpm install
pnpm build
node dist/index.js        # 或 npm link 后使用 hyacinth 命令
```

## 快速开始

```bash
# 首次配置（交互式向导：API Key、默认 Provider、persona 初始化）
hyacinth setup

# 系统诊断（--fix 自动修复）
hyacinth doctor

# 交互模式 / 单次提问
hyacinth
hyacinth "解释这个项目的架构"

# 指定 Provider 和模型
hyacinth -p openai -m gpt-4o "review 这段代码"
```

## CLI 命令

### 基础用法

```
hyacinth [options] [prompt]
```

| 选项 | 简写 | 说明 |
|--------|-------|-------------|
| `--provider <type>` | `-p` | Provider：anthropic / openai / deepseek / gemini / qwen / zhipu / minimax / mimo / volcengine / groq / xai / mistral / openrouter / moonshot / local / ollama / llamacpp（17 种） |
| `--model <name>` | `-m` | 模型名（按 provider 默认值） |
| `--interactive` | `-i` | 强制交互模式 |
| `--tui` | | 全屏终端界面 |
| `--max-turns <n>` | | 最大轮数（默认 100） |
| `--max-context <n>` | | 最大上下文 token（默认 200000） |
| `--max-messages <n>` | | 最大消息数（默认 10000） |
| `--continue` | | 恢复最近会话 |
| `--session <id>` | | 恢复指定会话 |
| `--start-model` | | 启动时拉起本地模型服务 |
| `--skip-setup` | | 跳过首启向导 |

### 子命令

| 命令 | 说明 |
|---|---|
| `hyacinth setup` | 交互式配置向导 |
| `hyacinth setup-generation` | 生成能力向导（图/视频/音频厂商配置） |
| `hyacinth doctor [--fix]` | 环境依赖/API Key/知识库等 7 项诊断 |
| `hyacinth tui` | 全屏 TUI（斜杠命令、Markdown 渲染） |
| `hyacinth serve` | HTTP API 服务器（见 [API 参考](api.md)） |
| `hyacinth webui` | WebUI（自动开浏览器） |
| `hyacinth session list/delete/export` | 会话管理（`--project` 指定项目、`-o` 导出路径） |
| `hyacinth config get/set/schema/reset` | 配置管理（dot-path 读写） |
| `hyacinth model switch/list/info` | Provider 与模型切换 |
| `hyacinth skill enable/disable/list` | 技能开关（黑名单机制） |
| `hyacinth tool enable/disable/list` | 工具开关 |
| `hyacinth arch list/get/toggle` | 架构可替换点查看与插件启停（serve 运行中热生效） |
| `hyacinth plugin install/list/uninstall` | 插件管理（本地目录或 git URL） |
| `hyacinth supervisor-status` | Guardian 守护状态诊断 |
| `hyacinth backup [label]` | git bundle + tag 快照备份 |
| `hyacinth update` | 自更新（GitHub Release / 本地源） |

守护进程默认启用（异常退出自动重启）；`--no-guardian` 可跳过。

## 配置

### 环境变量

| 变量 | 用途 |
|----------|--------------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `GROQ_API_KEY` / `XAI_API_KEY` / `MISTRAL_API_KEY` / `OPENROUTER_API_KEY` / `MOONSHOT_API_KEY` | OpenAI 兼容厂商 |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini |
| `DASHSCOPE_API_KEY` / `ZHIPU_API_KEY` / `MINIMAX_API_KEY` / `MIMO_API_KEY` | 国内厂商 |
| `HYACINTH_API_KEY` / `AGENT_API_KEY` | serve 模式 API 认证 |
| `LOG_LEVEL` | 日志级别：debug / info / warn / error / off（默认 info） |

`.env` 放项目目录或 `~/.agent/` 下，密钥自动注册进安全内核（防泄入子进程）。

### 配置文件

- **全局 `~/.agent/config.json`** — 主配置，项目 `.agent/config.json` 覆盖
- **`.agent/extension-registry.json`** — 扩展名单（replacements / plugins / orders）
- **`.agent/context-manifest.json`** — 5-Zone 上下文结构覆盖
- **`.agent/model-channels.json`** — 模型角色通道
- **项目根 `commands.json`** — 斜杠命令（模型可自行修改并热重载）

```json
{
  "provider": {
    "type": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "fallbacks": [
      { "type": "openai", "model": "gpt-4o" },
      { "type": "deepseek", "model": "deepseek-chat" }
    ]
  }
}
```

主 Provider 失败（retry + 熔断后）自动按序降级 fallback。

### MCP 服务器

在 `.agent/mcp.json` 或项目根 `.mcp.json`（Cursor/Claude 约定）配置：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.js"],
      "env": { "KEY": "value" }
    },
    "remote-server": {
      "url": "https://example.com/sse",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

支持 stdio（command）与 SSE（url）双传输，崩溃自动重连；工具以 `mcp__{server}__{tool}` 注册。

## 自定义技能（Skills）

在 `~/.agent/skills/`（用户级）或 `.agent/skills/`（项目级）创建带 YAML frontmatter 的 `.md` 文件，同名时项目级覆盖用户级：

```markdown
---
name: my-skill
description: 我的工作流技能
tools: read, bash, glob
---

根据用户请求执行以下任务：

{{task}}
```

保存即热重载，经 `use_skill` 按需注入上下文。

## 子 Agent 委托

内置子 Agent：

| Agent | 职责 |
|-------|------|
| `code-reviewer` | 代码审查（只读工具：read/glob/grep） |
| `security-auditor` | 安全审计（只读工具） |
| `test-writer` | 编写测试（read/write/glob/grep/bash） |

对 agent 说"让 code-reviewer 审查这个文件"即可触发 `delegate_to_agent`。协作模式：

- **委托** — 单 Agent 独立完成返回
- **并行** — `spawn_sub_agent` 克隆多实例并发调度
- **异步** — `async=true` 立即返回句柄，回合内自动注入或跨轮次 `get_sub_agent_result` 获取

会话按 instanceId 固定目录，TTL（默认 10 分钟）内复用完整对话历史。

## 本地模型

```bash
pnpm run setup:llamacpp     # 一键编译 llama.cpp

hyacinth -p local --start-model --model "qwen2.5-coder:7b"
hyacinth -p local           # 连接已运行的本地服务
```

支持 llama.cpp / Ollama / vLLM / LM Studio 后端（OpenAI 兼容协议，按端口自动推断）。

## 插件

插件放在 `.agent/plugins/<id>/`（`hyacinth plugin install` 安装目标）或项目 `plugins/`（开发用）。**manifest 文件为 `plugin.json`**：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "description": "示例",
  "entry": "./index.js",
  "deps": [],
  "enabledByDefault": true,
  "priority": 0,
  "architecture": {
    "tool:my-tool": { "impl": "createMyTool", "module": "./tools.js" }
  }
}
```

完整契约（PluginApi、可替换点、优先级裁决链）见 [plugin-sdk.md](plugin-sdk.md)。参考实现：项目自带 `plugins/example-greeter`（注册工具）与 `plugins/companion`（陪伴模式聚合插件，含架构替换声明）。

## 故障排查

- **"No sessions found"** — 先跑一次交互或显式创建会话
- **Provider 报错** — `LOG_LEVEL=debug` 看详细日志；检查 `.env` 密钥
- **MCP 连接失败** — 确认 command/url 可达；`mcp_status` 工具或 `hyacinth doctor` 检查
- **守护进程异常** — `hyacinth supervisor-status` 查看重启存档与标记残留
- **验证系统健康** — `pnpm test`（114 个测试套件）、`pnpm smoke`（装配链冒烟）
