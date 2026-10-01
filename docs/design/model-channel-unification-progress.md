# 操作记录：模型调用统一（进行中）

> **用途**：这是**进行中任务的交接记录**。若执行者（Agent 或人）中断，接手者应能凭本文件判断：
> 做到哪一步 · 改了哪些文件 · 当前是否处于**不可中断的中间态** · 如何回滚 · 下一步做什么。
>
> **设计依据**：`docs/design/model-channel-unification.md`（含现状调查与完整方案）
> **最后更新**：2026-10-01 13:55
> **执行者**：风信子（Agent）

---

## 0. 一眼看进度

| 项 | 值 |
|---|---|
| **当前阶段** | **S1、S2、S3a、S3b 全部完成并验证**；下一步 **S4**（命令与显示统一） |
| **已提交** | `0e02a05` 设计文档＋记录 · `f0e88e7` S1 · `bffa5e3` S2 · `c5ab51d` S3b · 3 个覆盖类修复 `acc30ab`/`a67dca7`/`bba28ac` · 记录 `f7e9e95`/`20cd318`/`fe71b23` |
| **源码改动（未提交）** | 无 |
| **可否安全中断** | ✅ 可以（无半成品代码） |
| **门禁状态** | ✅ S1、S2 各自跑过 build / test / verify:layers（**均退出码 0**）；restart 前另跑 `pnpm smoke` ✅ |
| **S2 活体验证** | ✅ **已通过**（证据见 §7.2） |
| **用户已定调** | ① 主对话有独立通道 ② `main` 改名 ③ `provider.active` 彻底退役（见 §7.1 / §10） |

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

## 3. 阶段划分

| 阶段 | 内容 | 状态 |
|---|---|---|
| **S1** | 主对话登记为调用点（role `chat`，缺省→main 通道）。行为零变化 | ✅ `f0e88e7` |
| **S2** | 主对话 provider 改为**经通道解析**（失败回落既有路径）⇒ 切通道对主对话真的生效 | ✅ `bffa5e3`，**已活体验证** |
| **S3a** | 修通道配置里的错默认值（**不动代码**） | ⏳ 未开始 |
| **S3b** | 命名与结构：`main` → `default`（含旧配置兼容读取）+ 新建主对话专属通道 `chat` | ⏳ 未开始 |
| **S4** | 统一命令与显示（`/channel` 一族；`list_providers` 拆两张表；状态栏标注通道） | ⏳ 未开始 |
| **S5** | `provider.active` 彻底退役 + 清理重复配置 + 补守卫测试 | ⏳ 未开始 |

> **硬性要求**：S1、S2 **分两次提交**（已遵守）；S3b/S5 涉及旧配置，**必须配兼容读取、分步提交**。

---

## 4. 改动清单（滚动更新）

| 文件 | 改了什么 | 阶段 | 提交 |
|---|---|---|---|
| `src/provider/model-channel-registry.ts` | `DEFAULT_ROLES` 增加 `chat: 'main'` | S1 | `f0e88e7` |
| `src/orchestrator/loop.ts` | 每轮 provider 决策处加入通道解析（+16 行，含回落） | S2 | `bffa5e3` |
| `docs/design/model-channel-unification.md` | 设计提案（含 §7.1 用户定调） | — | `0e02a05` / 待提交 |
| `docs/design/model-channel-unification-progress.md` | 本文件 | — | `0e02a05` / `20cd318` / 待提交 |

---

## 5. ⚠️ 中间态警告（接手者必读）

**当前没有半成品代码** —— S1、S2 均已提交并验证，可随时中断。

**但请注意运行时的"临时状态"**：验证期间曾把 main 通道**运行时**切到 commandcode，随后**已切回** deepseek。
这类切换**不落盘**，重启即恢复持久配置。

**持久配置目前仍是坏的**（S3a 待办）：`model-channels.json` 四条通道全写 `openai`（main 还是已废弃的 `gpt-4o`），
而本机无 OpenAI key ⇒ 每次启动它们全部创建失败、静默回落 deepseek。

---

## 6. 回滚方法

| 范围 | 做法 |
|---|---|
| S1 | `git revert f0e88e7` |
| S2 | `git revert bffa5e3`（回到"切通道不影响主对话"的旧行为） |
| 文档 | `git revert 0e02a05` / `f7e9e95` / `20cd318` |
| 用户配置（S3a/S3b 会改） | 每步先备份 `.bak-<日期>-<原因>`，还原即回滚 |

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

**结论**：主对话**确实随通道改变**（改造前不会）。

**附带结论**：步骤 c 那一轮的回复本身即由 GOAT 生成 ⇒ **GOAT 通道端到端可用**（不只是连通与权限）。

**注意**：`list_providers` 的 LOADED 层**仍显示 deepseek** —— 那是老机制那张表（`ProviderRouter`），
不受通道影响。这不是 bug，是 S4 要解决的显示问题（两张表混排）。

---

## 8. 关键决策（执行者所定，接手者需知悉）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 主对话调用点命名 **`chat`** | 与 `compression`/`sub-agent` 同层级，语义直白 |
| 2 | `provider.active` **暂保留**至 S5 | 主对话是命脉，分步退役；S5 才真正删净 |
| 3 | 改在**每轮 provider 决策处**，不是 `getActiveProvider()` | 后者只用于显示/能力判断；改它**不会**改变实际发出的请求（llm 阶段消费的是 `state.activeProvider`） |

**用户定调（2026-10-01 13:52）**：

| # | 决策 |
|---|---|
| 4 | 主对话**有**独立通道（新建 `chat`，不复用其它通道） |
| 5 | `main` **改名**（建议 `default`），须配旧配置**兼容读取**，不可直接删键 |
| 6 | `provider.active` **彻底退役**，过渡兜底也移除 |

---

## 9. 下一步

从 **S3a** 开始（见 §10 的详细拆分）。

---

## 10. 阶段详细拆分（S3 起）

### S3a —— 修配置（不动代码，低风险，先做）

1. 备份 `~/.agent/model-channels.json` → `.bak-<日期>-s3a`
2. 把四条通道的 `provider: "openai"` 改成**实际在用的厂商**；`main` 那条的模型从废弃的 `gpt-4o` 改成有效值
3. 验证：重启后日志**不再出现** `Failed to create provider for channel …`
4. 回滚：还原备份

### S3b —— 命名与结构（动代码，中高风险）✅ **已完成（c5ab51d + 3 个后续修复）**

1. ✅ 代码里 `'main'` 硬编码收敛为常量 `DEFAULT_CHANNEL = 'default'`（本文件 23 处）
2. ✅ **兼容读取**：`LEGACY_CHANNEL_ALIASES` 把旧配置的 `main` 键 / roles 里的 `'main'` 值自动映射为 `default`（`mergeDefaults` 内，原地改名不留两份，并记日志）
3. ✅ 新建主对话专属通道 `chat`（由 `mergeDefaults` 继承 default 配置补建）；`roles.chat` 指向它
4. ✅ 四处切换入口（webhook / ui-session / tui / model 域）改写入 `chat` 通道
5. ✅ 验证：**未覆盖**（5 条通道全 deepseek，重启后不退回）、无创建失败告警、主对话正常、切 `chat` 通道主对话随之改变

#### 🔥 过程中挖出的 3 个"启动装配覆盖用户通道配置" bug（都已修 + 已提交）

| # | 提交 | 根因 | 后果 |
|---|---|---|---|
| 1 | `acc30ab` | `channel-contributions` 造 registry 时**无条件** `buildFromLegacy`，完全忽略磁盘配置；随后 `upsertChannel` 触发 `save()` 把"最小 legacy 配置"整份回写 | 用户配置被覆盖：`chat` 通道被删、`default` 退回 openai；手改配置数秒内失效 |
| 2 | `a67dca7` | 角色通道的厂商取自 `config.provider.active`（老机制的**意图值**，可能与实际不符；本机写着没有 key 的 openai） | 三条角色通道每次启动被覆盖成 openai ⇒ 创建全失败 + 触发 save 写坏配置 |
| 3 | `bba28ac` | `setMainProvider` 的厂商参数同样取自 `provider.active` | `default` 通道每次启动退回 openai |

**共同教训**：凡是"启动装配写通道配置"的地方，都**不能**用 `config.provider.active` 作厂商来源
（意图值 ≠ 实际值），必须用 `provider.getProviderType()`（主对话**实际**在用的厂商）。
另：`~/.agent/model-channels.json` **有运行时写入方**，进程运行期间手改会被 `save()` 覆盖 ——
改完必须立刻重启，或改走运行时 API。

### S4 —— 命令与显示 ✅ **已完成**

1. ✅ `list_providers` 拆两张表：`DECLARED`＝厂商（配置声明的全部，标 ready/no-key）＋ `CHANNELS`＝通道（各自厂商/模型 ＋ 服务哪些调用点）；主对话所用通道排最前并标 `*`。原第三节 `LOADED` 读的是 ProviderRouter 的**老命名空间**（那个同名 `main`），已移除 —— `6aed790`
2. ✅ **状态栏前置显示主对话所用通道**：协议层 `StateSnapshot` 增加 `channel` 字段（取自 registry 的角色映射，role=chat），TUI 显示形如 `chat · deepseek · deepseek-v4-flash · ~0 tokens` —— `399649a`
3. ✅ 绑定能力**本已存在**：`/channel role <调用点> <通道名>`（`tui-channel-cmds.ts`，走 `model.setChannelRole`），无需新增 —— 命名沿用 `role`
4. ✅ 报错文案区分两者：`Available in router: main` → 明确说明"此处注册的是【通道名】不是【厂商名】"、列出已注册项、给出正确路径 —— `7f44d0b`
5. ✅ **移除 `/model` 的换模型分支**（`switch` / `provider`，共 101 行），换模型统一走 `/channel`；与换模型无关的设置项（`source` / `thinking` / `show-thinking` / `info` / `context`）**保留** —— `019e62d`

### S5 —— 退役与清理

1. 移除 `provider.active` 的读取路径（`loop.ts` 的 manual 分支、`buildFromLegacy` 的相关入参）
2. 移除 `config.json` 的 `provider.<厂商>` 重复段（先备份）
3. 补守卫测试：通道解析失败必回落；旧配置兼容映射；主对话随通道变化
