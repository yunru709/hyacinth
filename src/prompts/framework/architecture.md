# Agent 框架配置指南

你收到的消息由多个 Zone 按编号顺序拼接而成。Zone 1-3 使用 `cache_control` 缓存，内容不变时不消耗 token 计费。压缩只影响对话历史 Zone，不影响身份/工具/Skill 等固定内容。

## 可修改的配置项

所有运行时配置通过 `config.json`（`.agent/` 目录下）持久化。大部分配置通过 `update_config` 修改后即时生效（热加载），仅 `channels` 配置需调用 `restart` 工具重启生效。

### 会话相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `session.maxContext` | 上下文窗口软限制（tokens），不是模型原生上限 | 200000 | `/context <tokens>` |
| `session.maxTurns` | 最大对话轮数 | 100 | `/turns <1-100>` |

### 压缩相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `context.compressThreshold` | 触发压缩的比例（Zone总量 > maxContext × 此值） | 0.75 | `/threshold <0.0-1.0>` |

### Provider 相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `provider.active` | 当前使用的 Provider（anthropic/openai/deepseek/gemini/local） | - | `/model provider <name>` |
| `provider.<name>.model` | 各 Provider 的默认模型名 | 按 provider 不同 | `/model switch <model-name>` |
| `provider.enableThinking` | 是否启用深度思考模式 | false | `/model thinking <on\|off>` |

### 安全与修复

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `safety.requireConfirmation` | 工具执行前是否需要确认 | true | `/confirm <on\|off>` |
| `repair.scavenge.enabled` | 回收修复开关 | false | `/scavenge <on\|off>` |
| `repair.storm.enabled` | 风暴保护开关 | false | `/storm <on\|off>` |
| `repair.storm.windowSize` | 风暴检测窗口大小 | - | `/storm-win <2-20>` |
| `repair.storm.threshold` | 风暴检测阈值 | - | `/storm-th <1-10>` |

### 其他

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `logging.level` | 日志级别 | info | `/log <debug\|info\|warn\|error\|off>` |
| `training.enabled` | 训练模式开关 | false | `/training <on\|off>` |

## 其他可编辑文件

| 文件 | 用途 | 修改方式 |
|------|------|---------|
| `context-manifest.json` | Zone 架构声明（section 增删改序） | 直接编辑 |
| `models-catalog.json` | 模型目录（上下文窗口、价格） | 直接编辑 |
| `providers.json` | Provider 配置（API Key、默认模型） | 直接编辑 |
| `models.json` | 本地模型配置 | `/model local register` 或直接编辑 |
| `agents.json` | 子 Agent 定义 | 直接编辑 |
| `skills/*.md` | Skill 提示词模板 | 直接编辑 |
| `commands.json` | 自定义斜杠命令 | 直接编辑 |

## 使用原则

1. 不要擅自修改用户设定的配置值（特别是 `session.maxContext`）
2. 修改配置前先告知当前值和将要改成的值
3. 用户设异常小的值时，先确认意图再操作
4. 修改配置后即时生效并自动持久化，重启后保持