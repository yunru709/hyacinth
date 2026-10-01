# 操作记录：模型调用统一（进行中）

> **用途**：这是**进行中任务的交接记录**。若执行者（Agent 或人）中断，接手者应能凭本文件判断：
> 做到哪一步 · 改了哪些文件 · 当前是否处于**不可中断的中间态** · 如何回滚 · 下一步做什么。
>
> **设计依据**：`docs/design/model-channel-unification.md`（含现状调查与完整方案）
> **最后更新**：2026-10-01 13:48
> **执行者**：风信子（Agent）

---

## 0. 一眼看进度

| 项 | 值 |
|---|---|
| **当前阶段** | **S1、S2 完成并已验证**；下一步 S3（未开始） |
| **已提交** | `0e02a05` 设计文档＋本记录 · `f0e88e7` S1 · `bffa5e3` S2 · `f7e9e95` 记录更新 |
| **源码改动（未提交）** | 无 |
| **可否安全中断** | ✅ 可以（无半成品代码） |
| **门禁状态** | ✅ S1、S2 各自跑过 build / test / verify:layers（**均退出码 0**）；restart 前另跑 `pnpm smoke` ✅ |
| **S2 活体验证** | ✅ **已通过**（证据见 §7.2） |

---

## 1. 任务目标（为什么做这件事）

系统里"用哪个模型"有**两套并存的答案**：一套管主对话，一套（通道）管其余调用点。
两套各有配置文件、各有命令、且**共用名字**，导致用户切了通道却看不到变化。

**目标**：统一为单一真源三层 —— ①模型配置（厂商与模型目录）→ ②通道（一次具体选用）→ ③调用点绑定（谁用哪条）。
**核心动作**：把**主对话也登记为一个调用点**，让它和压缩器、旁路一样走通道。

---

## 2. 🔑 根因（接手者务必先看这条）

**系统里有两个都叫 `main` 的东西，是两个完全独立的对象，只是同名：**

| | 是什么 | 谁在用 | 在哪 |
|---|---|---|---|
| `ProviderRouter` 的 `main` | 运行时的 provider 实例注册表项 | **主对话**（老机制） | 内存 Map |
| `ModelChannelRegistry` 的 `main` | 一条**通道** | 压缩 / 子 Agent / 旁路等角色 | `model-channels.json` |

所以：
- 切"通道的 main"**不影响主对话** —— 因为主对话读的是另一个 `main`；
- 主对话的 provider 由 `ProviderRouter` + `config.json` 的 `provider.active` 决定；
- `provider.active` 若指向一个**未注册**的名字（如本机的 `openai`），会**静默回落到** `main`。

**这就是"切了没反应"的完整解释。** S2 修复的正是这一条。

---

## 3. 阶段划分（详见设计文档 §5）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **S1** | 主对话登记为调用点（role `chat`，缺省→main 通道）。行为零变化 | ✅ 已提交 `f0e88e7` |
| **S2** | 主对话 provider 改为**经通道解析**（失败回落既有路径）⇒ 切通道对主对话真的生效 | ✅ 已提交 `bffa5e3`，**已活体验证** |
| **S3** | 清理配置：修正通道里的错默认值、移除 `config.json` 的重复厂商段（先备份） | ⏳ 未开始 |
| **S4** | 统一命令与显示（`/channel` 一族；`list_providers` 拆两张表） | ⏳ 未开始 |
| **S5** | 移除老机制残留 + 补守卫测试 | ⏳ 未开始 |

> **硬性要求**：S1、S2 **分两次提交**（已遵守）。

---

## 4. 改动清单（滚动更新）

| 文件 | 改了什么 | 阶段 | 提交 |
|---|---|---|---|
| `src/provider/model-channel-registry.ts` | `DEFAULT_ROLES` 增加 `chat: 'main'` | S1 | `f0e88e7` |
| `src/orchestrator/loop.ts` | 每轮 provider 决策处加入通道解析（+16 行，含回落） | S2 | `bffa5e3` |
| `docs/design/model-channel-unification.md` | 设计提案 | — | `0e02a05` |
| `docs/design/model-channel-unification-progress.md` | 本文件 | — | `0e02a05` / `f7e9e95` |

---

## 5. ⚠️ 中间态警告（接手者必读）

**当前没有半成品代码** —— S1、S2 均已提交并验证，可随时中断。

**但请注意运行时的"临时状态"**：验证期间曾把 main 通道**运行时**切到 commandcode，
随后**已切回** deepseek。这类切换**不落盘**（`model-channels.json` 未被修改），重启即恢复持久配置。

**持久配置目前仍是坏的**（S3 待办）：`model-channels.json` 四条通道全写 `openai`（main 还是已废弃的 `gpt-4o`），
而本机无 OpenAI key ⇒ 每次启动它们全部创建失败、静默回落 deepseek。**S3 才修这个。**

---

## 6. 回滚方法

| 范围 | 做法 |
|---|---|
| S1 | `git revert f0e88e7` |
| S2 | `git revert bffa5e3`（回到"切通道不影响主对话"的旧行为） |
| 文档 | `git revert 0e02a05` / `f7e9e95` |
| 用户配置（S3 会改） | 每步先备份 `.bak-<日期>-<原因>`，还原即回滚 |

---

## 7. 验证方式与结果

### 7.1 门禁
`pnpm build` + `pnpm test`（217 文件 / 1984 用例）+ `pnpm verify:layers`，**各自取退出码**。
S1、S2 分别通过，均退出码 0。restart 前另跑 `pnpm smoke`（装配冒烟）✅ 启动即活。

### 7.2 ✅ S2 活体验证（已完成，2026-10-01 13:44）

| 步骤 | 动作 | 结果 |
|---|---|---|
| a | `restart` 让 S2 代码生效 | ✅ |
| b | `set_channel_model('main', 'commandcode', 'deepseek/deepseek-v4.1-flash')` | ✅ 回执确认 |
| c | **下一轮** `provider_info` | ✅ **`{"type":"commandcode","model":"deepseek/deepseek-v4.1-flash"}`** |
| d | 切回 `set_channel_model('main', 'deepseek', 'deepseek-v4-flash')` | ✅ 下一轮确认回到 deepseek |

**结论**：主对话**确实随通道改变**（改造前不会）。这是本次任务的关键验证。

**附带结论（意外收获）**：步骤 c 的那一轮回复本身即由 GOAT 生成 ⇒ **GOAT 通道端到端可用**（不只是连通与权限，真实的对话请求也成功）。

**注意**：`list_providers` 的 LOADED 层**仍显示 deepseek** —— 那是老机制那张表（`ProviderRouter`），
不受通道影响。这不是 bug，是 S4 要解决的显示问题（两张表混排）。

---

## 8. 关键决策（执行者所定，接手者需知悉）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 主对话调用点命名 **`chat`** | 与 `compression`/`sub-agent` 同层级，语义直白 |
| 2 | `main` 通道名**保留** | 它是"默认通道"。改名牵动已落地的用户配置与多处代码；改为**在显示层标注**它服务哪些调用点 |
| 3 | `provider.active` **暂保留为兜底** | 主对话是命脉。通道解析失败必须能回落，绝不能"配置写错就起不来" |
| 4 | 改在**每轮 provider 决策处**，不是 `getActiveProvider()` | 后者只用于显示/能力判断；改它**不会**改变实际发出的请求（llm 阶段消费的是 `state.activeProvider`） |

---

## 9. 下一步（接手者从这里继续）

**S3 —— 修配置（推荐优先）**：

1. 备份 `~/.agent/model-channels.json`
2. 把四条通道的 `provider: "openai"` 改成实际在用的厂商；`main` 那条的模型从废弃的 `gpt-4o` 改成有效值
3. 顺带：`config.json` 的 `provider.active = "openai"`（指向一个没有 key 的厂商）应一并理顺
4. 验证：**重启日志不再出现** `Failed to create provider for channel …`

**之后**：S4（命令与显示统一）、S5（清理老机制 + 守卫测试）。

**待用户定调**（设计文档 §7）：主对话是否要独立通道名、`main` 是否改名、`provider.active` 是否彻底退役。
