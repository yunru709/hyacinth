# Agent 框架配置指南

> 本文档 = **运行时配置** + **上下文/缓存架构**。第 0 节是最常踩的坑，建议先读。

## 0. 上下文与缓存（最重要的一节）

### 缓存是「前缀缓存」

provider 只认**从头开始逐字节相同**的那一段；**第一个不同的字节之后，全部重算**。
机制按厂商分派（权威：`src/context/cache-strategy.ts` 的 `CacheMode`）：

| 厂商 | cacheMode | 说明 |
|---|---|---|
| Anthropic | `manual-markers` | 需在消息上打 `cache_control` 断点（最多 4 个，按 Zone 边界算） |
| **DeepSeek / OpenAI / 其他 OpenAI 兼容** | **`auto-prefix`** | **自动比对请求前缀字节，不需要任何标记** |
| Gemini | `auto-prefix`（隐式） | 显式 CachedContent 尚未实现 |
| local / llamacpp | `none` | 无缓存 |

⚠️ **本机跑 OpenAI 兼容（`auto-prefix`）⇒ 消息上根本没有 `cache_control`**。
命中与否**完全取决于请求体前多少字节与上一次相同**。

> **由前缀语义推出的一条工程铁律：**
> **任何排在 `history` 之前的 section，字节变一次，它后面的一切（含 93%+ 的对话历史）全部作废。**
> 排在 `history` **之后**的 section，抖动只赔它自己那点 token。
> ⇒ **易变内容必须放 Zone 5（history 之后）；放前面就是给自己埋雷。**

### 真实段序（以实测 `cache-trace.jsonl` 为准）

```
persona_soul · attention · tool_rules · skills · agents · mcp · memory · tool_bundles   ← 都在 history 之前
history_summary · history                                                              ← 唯一增长区，压缩器管边界
channel_context · scratchpad · timestamp · user_input                                  ← 尾部，每轮必变（安全）
```

⚠️ **`~/.agent/context-manifest.json` 一旦存在就完全覆盖代码默认值**（`manifest-defaults.ts`）。
两处冲突时**以本地这份为准** ⇒ 改 zone/section **必须同时改它**，否则只改代码不会生效。

### 三个已知的坑

1. **空 section 会被整段丢弃**（`composer.ts`：`if (!content) continue`）
   ⇒ runtime 段的**「存在性」挂在了异步就绪上**。实例：`mcp` 段的内容 = 已注册的 `mcp-<name>` 源的名字列表，
   而该源**只在 server 连接成功后才注册** ⇒ **进程刚启动那十几秒该段为空 ⇒ 整段消失 ⇒ 断点落在它那里** ⇒
   其后的 memory/tool_bundles/history_summary/history 全废（**每次重启必付一次**）。
   **正解是让段的存在性与连接时序解耦（装配期预注册），不是把它挪到 history 后面。**
2. **改 `mcp.json` 的代价不对称**：**新增/修改** server 走 `isHotPlug:true` ⇒ `cacheability:'live'` ⇒ 进 Zone 5（**安全**）；
   **删除** server 会 `unregisterSource('mcp-<name>')` ⇒ Zone 1 的 `mcp` 段少一行 ⇒ **断一次（贵）**。
   （MCP **崩溃/自动重连不改段** —— 段渲染的是注册时的静态 name/description，不读连接状态。）
3. **命中率的天花板是 ~96–99%，不是 100%**：Zone 5 尾部每轮必变，天然不可缓存。
   且 TUI 上那个数字可能是**本轮/会话的加权平均**，会被少数几次暴跌拖低 ⇒ **别把平均值当单次值看**。

### 缓存池按 `user_id` 隔离（`src/provider/user-id.ts`）

| 调用点 | 实测池键 |
|---|---|
| 主会话 | **`hyacinth-chat`** —— `derivedUserId('chat')`，按**通道名**派生，**不含会话名** ⇒ 所有 chat 流量共用一池，多会话并行会互相挤占 |
| 压缩器 | `hyacinth-compressor-{sessionTag}` |
| 旁路 Agent | `hyacinth-orchestrator` / `hyacinth-narration` |
| 子 Agent | `hyacinth-sub-{name}-{instanceId}` |

### 诊断工具（已内置）

| 工具 | 用途 |
|---|---|
| `~/.agent/sessions/<type>/<id>/cache-trace.jsonl` | 每次 compose 一行：逐段 hash/token · `toolsHash` · `prefixHash` · `msgHashes`（逐条全量）· `compressCount` |
| `scripts/cache-hits.mjs` | 命中率时间线 × 段级指纹按时间对齐 |
| `scripts/cache-trace.mjs` | 段级指纹查看 |
| provider 侧请求体探针（`compatible.ts` 内） | **默认关**，`/log debug` 即开。打 `commonPct` = 与上一次请求的公共前缀占比 ⇒ **`≈100` 却低命中 = provider 侧无责可查；`<95` = 本地有漂移** |

判断优先级：**先看 `prefixHash`/`msgHashes` 变没变** —— 没变就别查本地了。

---

## 可修改的配置项

所有运行时配置通过 `config.json`（`.agent/` 目录下）持久化。大部分配置通过 `update_config` 修改后即时生效（热加载），仅 `channels` 配置需调用 `restart` 工具重启生效。

### 会话相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `session.maxContext` | 上下文窗口软限制（tokens），不是模型原生上限 | 200000 | `/context <tokens>` |
| `session.maxTurns` | 最大对话轮数 | 100 | `/turns <1-250>` |

> ⚠️ **顶层遗留字段**：`config.json` 里另有一对顶层 `maxTurns` / `maxContext`，是「结构化改造前」的
> 存储位，与 `session.*` 语义重复。**权威值是 `session.*`** —— configCenter、`AgentLoop`、TUI 状态栏、
> 斜杠命令全部读它。`ConfigManager.load()` 会在加载时把顶层按 `session.*` 对齐（2026-10-13 归一）
> ⇒ **手改顶层那对不会生效**，一律改 `session.*`。
>
> `/context <tokens>` 的取值上限 = **当前模型的原生窗口**（代码按 `getModelContextWindow` 校验）。
>
> 窗口值同时是**压缩触发判断的分母**（阈值 = 窗口 × `compressThreshold`）⇒ 改它等同于移动
> 「何时开始压缩」这条线。

### 压缩相关

| 配置路径 | 含义 | 默认值 | 修改命令 |
|---------|------|--------|---------|
| `context.compressThreshold` | 触发异步压缩的比例（Zone总量 > maxContext × 此值） | 0.75 | `/compress threshold <0.0-1.0>` |
| `context.emergencyThreshold` | 触发紧急同步压缩的比例（防止 API 溢出） | 0.92 | `/compress emergency <0.0-1.0>` |
| `context.compressDepth` | 压缩激进程度（0=极激进, 1=保守） | 0.5 | `/compress depth <0.0-1.0>` |

### 模型目录（本机持久配置）

**路径**: `~/.agent/providers.json` 里各厂商的 `models` 字段  
**作用**: 本机级模型参数，所有项目共享。用 `edit` 工具直接修改，下次启动生效。  
**条目按 `(provider, id)` 索引**；厂商未声明 `models` 时 → 回退源码内置目录（`src/provider/model-types.ts`）。

> ⚠️ **历史遗留**：`~/.agent/models-catalog.json` 已并入 `providers.json`，
> 加载器**不再读取它** —— 改那个文件不会生效（留着只是垃圾）。

| 字段 | 含义 | 示例 |
|------|------|------|
| `contextWindow` | 最大输入上下文（token 数） | `1000000` |
| `maxOutputTokens` | 单次最大输出（token 数） | `393216` |
| `reasoningEffort` | 推理强度。设为任意值即自动开启思考。DeepSeek: `"high"` / `"max"`；Anthropic: budget tokens 数字 | `"max"` |

```json
{
  "providers": {
    "deepseek": {
      "models": [{
        "id": "deepseek-v4-pro",
        "contextWindow": 1000000,
        "maxOutputTokens": 393216,
        "reasoningEffort": "max"
      }]
    }
  }
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
| `providers.json` | Provider 配置 + 模型目录（API Key、默认模型、`models` 数组） | 直接编辑 |
| `model-channels.json` | 多通道模型路由配置（通道定义 + 角色映射；含 `narration` 旁路角色） | 直接编辑 或 `/channel` 命令 |
| `world-engine.json` | 世界引擎开关与参数（仅陪伴模式，默认关） | 直接编辑 |
| `models.json` | 本地模型配置 | `/model local register` 或直接编辑 |
| `agents.json` | 子 Agent 定义 | 直接编辑 |
| `skills/*.md` | Skill 提示词模板 | 直接编辑 —— ⚠️ **要改 `~/.agent/prompts/skills/` 那一份，不是 `dist/`** |
| `commands.json` | 自定义斜杠命令 | 直接编辑 |

> ⚠️ **提示词是「外部优先」三级覆盖**（权威：`src/prompts/loader.ts:7-10`）：
> `① <cwd>/.agent/prompts/{name}.md` → `② ~/.agent/prompts/{name}.md` → `③ dist/prompts/{name}.md`（内置默认）
>
> ⇒ **改 `src/prompts/` 或 `dist/prompts/` 都可能被 `~/.agent/prompts/` 下的同名副本静默盖掉。**
> **改任何提示词 / Skill（含内置的 `framework-reference` 本身）：先看 `~/.agent/prompts/` 有无同名文件 —— 有就改它，并同步改源码那份（两份都改，别只改一边）。**
>
> 实测教训（2026-10-14）：只改了 `src/prompts/skills/framework-reference.md` + 重新 build，
> 运行实例读到的仍是 `~/.agent/prompts/skills/` 下的**旧副本** —— 白改一轮。

## 使用原则

1. 不要擅自修改用户设定的配置值（特别是 `session.maxContext`）
2. 修改配置前先告知当前值和将要改成的值
3. 用户设异常小的值时，先确认意图再操作
4. 修改配置后即时生效并自动持久化，重启后保持
5. **`session.maxContext` 已支持热更新（2026-10-13 修）** —— `/context <tokens>` 改完**当轮即生效**。
   此前它只在 `AgentLoop` 构造时读一次，且热更新订阅点是 `context.*`、与该键的 `session.*`
   命名空间**不匹配** ⇒ 改完表现为「状态栏变了、触发点没变」。现为每轮从 configCenter 兜底同步。

