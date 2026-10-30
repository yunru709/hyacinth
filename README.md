# Hyacinth 🪻

> 跑在你终端里的 AI Agent · MIT · TypeScript · Node.js ≥ 22.5 · **109** 个内置工具 · **19** 家模型厂商 · [npm](https://www.npmjs.com/package/hyacinth-ai) · [GitHub](https://github.com/yunru709/hyacinth)

Hyacinth（风信子）是一个跑在本地的 AI 助手。它不止能聊天——能**直接读写你的文件、敲命令、分析代码、跑本地模型**，还能在终端、浏览器、飞书、微信之间**主动联系你**，并且记得你的项目。

它不绑定某一家云服务：Anthropic、OpenAI、DeepSeek、Gemini、通义、智谱、Kimi 等 19 家厂商，以及本地 llama.cpp / Ollama 都行——换模型就是改一行配置。

---

## 三步开始

```bash
npm install -g hyacinth-ai   # 1. 安装
hyacinth setup               # 2. 配置向导（选厂商 → 填 API Key → 选模型）
hyacinth                     # 3. 开始对话
```

不知道能干嘛？直接问它：`hyacinth "看看这个项目是做什么的"`。

---

## 能做什么

**改代码 / 读项目**
- 读写文件、批量编辑、跨文件搜索，自动执行并汇报结果
- 代码交叉引用：谁调用了它、改了会影响哪些文件、变量在哪赋值
- 一条命令跑「类型检查 + 相关测试」（`verify_change`），改完就能验
- 每一步可回滚：按回合退回到改动前的文件状态

**跑命令 / 管系统**
- 执行 shell 命令、看系统信息与磁盘占用、压缩解压
- 定时任务（每 N 分钟 / 每天几点 / cron / 只跑一次）

**在任何地方用它**
- 终端全屏 TUI、浏览器 WebUI、HTTP API
- **飞书**（机器人）、**微信**（扫码登录）
- **Windows 桌面端**（独立窗口）
- 消息还能在渠道间借道转发

**自动化，不用一直盯着**
- 触发方式：定时，或「某个文件变了 / 某个进程退出了 / 某个端口开了 / 屏幕上某个窗口画面变了」
- 触发后可以自动跑一串工具；只有真需要动脑的步骤才唤醒模型（省 token）
- 例：进程一退出就通知你 / 日志出现关键字就自动分析 / 每天定时巡检

**记得你的项目**
- 跨会话的项目记忆，下次打开还认得
- 长对话自动压缩，不会把上下文撑爆

**可扩展**
- **MCP**：接入任意外部工具
- **插件**：本地目录或 git 地址安装
- **子 Agent**：把大任务拆给多个小 Agent 并行 / 后台做
- 自定义**工具包、技能、模型通道**（把不同任务分给不同厂商的模型）

**语音（可选）**
- 语音输入转文字（本地识别，模型按需下载）
- 文字转语音（多种音色）

**安全**
- 安全内核：命令 / 进程 / 网络三裁决，API Key 不外泄进子进程
- 逐回合回滚、文本死循环检测、会话垃圾清理

---

## 安装

### 前提

- **Node.js ≥ 22.5**
- **pnpm**（推荐）

> Windows 上从源码构建还需要 **VS Build Tools**（C++ 桌面开发）+ **Python 3**，因为个别原生依赖需要编译。

### npm 全局安装（推荐）

```bash
npm install -g hyacinth-ai
```

### 从源码构建

```bash
git clone https://github.com/yunru709/hyacinth
cd hyacinth
pnpm install
pnpm build
```

---

## 快速开始

### 配置 API Key

`hyacinth setup` 会引导你写进 `~/.agent/.env`。也可以手动配置：

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
```

密钥会登记进安全内核，不会泄露给子进程。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `hyacinth` / `hyacinth "问题"` | 交互对话 / 单次提问 |
| `hyacinth tui` | 全屏终端界面 |
| `hyacinth webui` | 浏览器界面 |
| `hyacinth serve` | 起 HTTP API（可加 `--webui`、`--lan`、`--api-key`） |
| `hyacinth setup` / `setup-generation` | 配置模型 / 配置图·视频·音频生成能力 |
| `hyacinth doctor [--fix]` | 体检 + 自动修复 |
| `hyacinth model switch/list/info` | 切换 / 查看模型 |
| `hyacinth session list/delete/export` | 管理会话 |
| `hyacinth config get/set/schema/reset` | 读写配置 |
| `hyacinth skill` / `tool enable/disable/list` | 开关技能 / 工具 |
| `hyacinth plugin install/list/uninstall` | 装 / 卸插件 |
| `hyacinth backup [label]` | 快照备份 |
| `hyacinth update [--rollback]` | 升级 / 回退 |

更多（`arch`、`supervisor-status`、`-p/-m/--session/--continue` 等）看 `hyacinth --help`。

### 本地模型（可选）

```bash
pnpm run setup:llamacpp                    # 一键准备 llama.cpp
hyacinth -p local --start-model --model "qwen2.5-coder:7b"
```

模型在运行期按需下载或配置（可用 `HYACINTH_MODELS_DIR` 或配置项 `models.modelsDir` 指向已有目录）。

### 终端要求（Windows）

TUI 靠 Unicode 渲染，推荐 **Windows Terminal**（Win11 自带）。旧 cmd/conhost 下 emoji、框线可能花屏。macOS / Linux 各终端开箱即用。

---

## 进阶

### 自动化：写一条规则

规则 = **触发** + **动作链**。用自然语言让模型帮你建，或直接调工具：

- 工具：`automation_create` / `automation_list` / `automation_remove` / `automation_validate`
- 触发：`time`（定时）/ `probe`（文件·HTTP·进程·端口·画面）/ `event`（事件）
- 动作：`invoke`（跑工具，零 LLM）/ `wake`（唤醒会话动脑）/ `gate`（判断走哪支）/ `loop`（重试）

### 多渠道

- **飞书**：在配置里填机器人 `app_id` / `app_secret`
- **微信**：启动后扫码登录 ClawBot
- **桌面端**：`pnpm run desktop:build` 构建 Windows 桌面壳

### 配置都放在哪

- `~/.agent/`：全局配置（`config.json`、`.env`、`providers.json`、`model-channels.json` 等）+ `sessions/`、`prompts/`、`skills/`、`plugins/`、`media/`、`knowledge/`
- 项目里的 `.agent/`：只放数据面（`modes/`、`specs/`、`backups/`）
- 一律改配置用 `hyacinth config` 或让模型改（手改 `config.json` 会被运行时覆盖）

### 架构（想深入了解）

内核零业务、所有能力以注册表 + 插件装配，全部可替换——一句话说不完，见 [docs/architecture.md](docs/architecture.md)。

---

## 文档

| 文档 | 说明 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 架构总览与逐文件拆解 |
| [docs/plugin-sdk.md](docs/plugin-sdk.md) | 插件开发 |
| [docs/security-kernel.md](docs/security-kernel.md) | 安全内核 |
| [docs/api.md](docs/api.md) | HTTP API |
| [docs/user-guide.md](docs/user-guide.md) | 用户指南 |
| [docs/design/](docs/design/) | 设计决策记录 |

## 参与贡献

```bash
pnpm install
pnpm build          # 编译 + 复制资源
pnpm test           # 测试
pnpm verify:layers  # 分层约束校验
```

提交前请确保 `pnpm test` 与 `pnpm verify:layers` 同一次状态双绿。

## 许可证

[MIT](./LICENSE) · Copyright © 2026 孑遗
