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

### 模型目录（本机持久配置）

**路径**: `~/.agent/models-catalog.json`  
**作用**: 本机级模型参数，所有项目共享。用 `edit` 工具直接修改，下次启动生效。  
**条目按 `(provider, id)` 索引**，`__default__` 为该 provider 下所有未匹配模型的兜底。

| 字段 | 含义 | 示例 |
|------|------|------|
| `contextWindow` | 最大输入上下文（token 数） | `1000000` |
| `maxOutputTokens` | 单次最大输出（token 数） | `393216` |
| `reasoningEffort` | 推理强度。设为任意值即自动开启思考。DeepSeek: `"high"` / `"max"`；Anthropic: budget tokens 数字 | `"max"` |

```json
{
  "models": [{
    "id": "deepseek-v4-pro",
    "provider": "deepseek",
    "contextWindow": 1000000,
    "maxOutputTokens": 393216,
    "reasoningEffort": "max"
  }]
}
```

### Provider 相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `provider.active` | 当前使用的 Provider（anthropic/openai/deepseek/gemini/local） | - | `/model provider <name>` |
| `provider.<name>.model` | 各 Provider 的默认模型名 | 按 provider 不同 | `/model switch <model-name>` |
| `/model thinking` | 推理临时覆盖（不写文件，重启恢复模型目录默认） | - | `/model thinking <on\|off\|high\|max>` |

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

## 旁路Agent（Bypass）

旁路Agent是独立于主Agent运行的后台观察者。在主对话流的前后介入，不抢占主Agent的上下文预算，异常隔离（失败不影响主流程）。

```
User Input → [preTurn] → Composer组装上下文 → LLM调用 → [postTurn] → 回复用户
                   ↑                                    ↑
              旁路Agent（阻塞）                   旁路Agent（后台）
```

- **preTurn**：串行阻塞，等所有活跃旁路Agent完成才继续。返回 `Injection` 注入到主Agent上下文的指定 section。
- **postTurn**：并行后台，不阻塞主流程。可观察对话、更新内部状态或通过 `inject()` 写入"纠正内容"下一轮生效。

目前有两个实现：

| Agent | 模式 | 职责 |
|-------|------|------|
| `orchestrator` | `normal`（默认） | preTurn 读记忆+意图识别→注入约束；postTurn 审查回复是否偏离意图，连续偏离≥2次注入纠正；末轮用 LLM+工具（`memory_add/update/remove/search`）维护记忆文件 |
| `world-engine` | `companion`（陪伴模式） | preTurn 环境旁白注入；postTurn 观察对话更新世界状态；独立 Ticker 推进时间/天气/NPC |

旁路Agent通过 `model-channels.json` 中的通道获取独立的模型实例（定义 `orchestrator` 或 `narration` 通道指向合适的模型）。

### 世界引擎（仅陪伴模式）

为陪伴模式自动维护地点/物品/NPC/时间天气，每轮作为环境旁白注入。**默认关闭。**

| 配置路径 | 含义 | 默认值 |
|---------|------|--------|
| `enabled` | 总开关 | false |
| `worldId` | 活动世界 ID | default |
| `worldName` | 世界名（首次创建时用） | 我们的世界 |
| `ticker.heartbeatMs` | 心跳间隔（毫秒） | 5000 |
| `ticker.timeScale` | 世界时间流速倍率 | 1 |
| `ticker.weatherAvgHours` | 一种天气平均持续的世界小时数 | 4 |
| `ticker.overcastHoursBeforeRain` | 降水前阴天持续的世界小时数 | 1.5 |

要点：
1. 改动 `enabled` 后需重进陪伴模式生效。
2. 世界数据存于 `.agent/worlds/<worldId>/world.json`。

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
