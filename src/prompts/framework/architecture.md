# Agent 框架配置指南

你收到的消息由多个 Zone 按编号顺序拼接而成。Zone 1-3 使用 `cache_control` 缓存，内容不变时不消耗 token 计费。压缩只影响 Zone 3（对话记录），不影响身份/工具/Skill 等固定内容。

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
| `context.compressThreshold` | 触发异步压缩的比例（Zone总量 > maxContext × 此值） | 0.75 | `/threshold <0.0-1.0>` |
| `context.emergencyThreshold` | 触发紧急同步压缩的比例（防止 API 溢出） | 0.92 | `update_config path=context.emergencyThreshold value=<0.0-1.0>` |
| `context.compressDepth` | 压缩激进程度（0=极激进, 1=保守） | 0.5 | `update_config path=context.compressDepth value=<0.0-1.0>` |
| `context.compressionStrategy` | 压缩策略：`A`=独立提示词, `C`=克隆对话(缓存友好，默认) | `C` | `update_config path=context.compressionStrategy value=<A\|C>` |

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

### 世界引擎（仅陪伴模式）

世界引擎为陪伴模式提供一个"会随对话生长、自行演进"的世界：自动维护地点 / 物品 / NPC / 时间天气，并在每轮把当前所处环境"旁白化"后注入，作为陪伴角色回应的背景底色。对话中提到的新地点、人物会被自动"造"出来，世界越聊越丰富。**默认关闭**——关闭时陪伴模式行为与原来完全一致。仅在陪伴模式下运行，退出陪伴模式即停止、不占资源。

配置文件 `world-engine.json`（`.agent/` 目录，直接编辑）：

| 配置路径 | 含义 | 默认值 |
|---------|------|--------|
| `enabled` | 总开关 | false |
| `worldId` | 活动世界 id（对应目录 `.agent/worlds/<id>/`） | default |
| `worldName` | 世界名（仅首次创建该世界时使用） | 我们的世界 |
| `ticker.heartbeatMs` | 心跳间隔（毫秒），推进时间 / 天气 / NPC 位置 | 5000 |
| `ticker.timeScale` | 世界时间流速倍率（世界时间 = 现实流逝 × 此值；1 = 与现实 1:1 同步，60 = 快 60 倍即现实 1 分 ≈ 世界 1 小时） | 1 |
| `ticker.weatherAvgHours` | 一种天气平均持续的世界小时数（随 timeScale 缩放；1:1 时约 N 现实小时） | 4 |
| `ticker.overcastHoursBeforeRain` | 降水前"阴天"需持续的世界小时数（下雨前先阴一阵） | 1.5 |

要点：
1. `enabled` 只在**进入陪伴模式时读取一次**，不热重载；改动后需重新进入陪伴模式才生效。
2. 开启且世界已有内容时，每轮用环境旁白替换 Zone 5 的"当前时间"槽位（一次前置、阻塞式的 LLM 调用）；世界尚空时回落正常时间戳逻辑。
3. 通过 `model-channels.json` 的 `narration` 角色调用 LLM（未定义则回落 `main`）。可把该通道指向本地 / 更快的模型以降低前置延迟；thinking 默认关。
4. 世界数据存于 `.agent/worlds/<worldId>/world.json`，存档在其下 `saves/`。切换世界改 `worldId` 即可（下次进入陪伴模式生效）。

## 其他可编辑文件

| 文件 | 用途 | 修改方式 |
|------|------|---------|
| `context-manifest.json` | Zone 架构声明（section 增删改序） | 直接编辑 |
| `models-catalog.json` | 模型目录（上下文窗口、价格） | 直接编辑 |
| `providers.json` | Provider 配置（API Key、默认模型） | 直接编辑 |
| `model-channels.json` | 多通道模型路由配置（通道定义 + 角色映射；含 `narration` 旁路角色） | 直接编辑 或 `/channel` 命令 |
| `world-engine.json` | 世界引擎开关与参数（仅陪伴模式，默认关） | 直接编辑 |
| `models.json` | 本地模型配置 | `/model local register` 或直接编辑 |
| `agents.json` | 子 Agent 定义 | 直接编辑 |
| `skills/*.md` | Skill 提示词模板 | 直接编辑 |
| `commands.json` | 自定义斜杠命令 | 直接编辑 |

## 使用原则

1. 不要擅自修改用户设定的配置值（特别是 `session.maxContext`）
2. 修改配置前先告知当前值和将要改成的值
3. 用户设异常小的值时，先确认意图再操作
4. 修改配置后即时生效并自动持久化，重启后保持