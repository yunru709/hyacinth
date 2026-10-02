# 配置与代码的边界（Config / Code Separation）

> 2026-10-02 立项。触发事件：一次"模型改名"的维护，需要在 **5 个文件**之间来回找；
> 期间还撞上「切换没落盘」「两个工具给出矛盾答案」「配置文件被别的进程改回去」。

---

## 1. 问题（全部为当日亲历，带证据）

| # | 症状 | 证据 |
|---|---|---|
| ① | **同一个事实没有单一出口** | 改一个模型名要动：`providers.json`、`config.json`、内置目录 `model-types.ts`、出厂默认 `provider-meta.ts`、兜底字符串 `compatible.ts` —— 5 处 |
| ② | **"当前值"有三层表达，无仲裁者** | `providers.json`（这家有哪些）/ `config.json`（选了哪个）/ `model-channels.json`（谁用哪条）三者互不校验 |
| ③ | **同一状态，两个工具两个答案** | `list_model_channels` 读配置副本、`list_providers` 读运行时实例；旧代码下同一次切换给出矛盾输出 |
| ④ | **配置被别的进程覆盖** | `provider.active` 改两次：第一次写完被覆盖回旧值；本机当时有 **10 个 node 进程**各持一份内存快照，后写者赢 |
| ⑤ | **代码里藏着配置** | 6 家 provider 工厂各自硬编码一个模型名兜底（anthropic/openai/gemini/mimo/qwen/zhipu） |
| ⑥ | **"配置住哪"没有文档** | 仓库内曾有一份同名 `providers.json` 副本（运行时**不读**，见 `config.ts:30` 路径取自 `os.homedir()`），排查时被误导 |

## 2. 判据：怎样才算"分离"了

1. **单一出口**：一个事实（模型名/默认值/能力）只在一处定义，其它地方只能"引用"或"兜底"，不能"复制"。
2. **权威有序**：冲突时谁赢要写下来，且**机器可判定**（不能靠人记）。
3. **边界可测**：把边界写成测试 —— 越界即失败（比写在文档里可靠）。
4. **位置可查**：每个配置文件"谁读、谁写、何时生效"有清单。
5. **不一致会自己冒出来**：有自检，而不是等人翻文件。

## 3. 边界契约（本次确立）

| 层 | 角色 | 权威度 |
|---|---|---|
| **代码 schema / 兜底** | 只定义"字段存在与默认值"，**不含会变的业务数据**（具体模型名、价格、能力） | 最弱（仅兜底） |
| **用户配置文件** | 权威值来源（`providers.json` / `config.json` / `model-channels.json`） | 强 |
| **运行时实例** | 实际生效对象；用户显式改动**默认落盘**（2026-10-02 已改） | 最强，但必须回写配置 |

**冲突规则**：用户配置 > 代码兜底；运行时改动 > 磁盘旧值，且**默认持久化**（临时改动须显式声明 `persist:false` / `--temp`）。
**自检只报警不改写** —— 自动"修"配置会制造新的不确定性。

## 4. 本次实施（四项）

### ① `config_check` 配置一致性自检（新增）
- 新模块 `src/diagnostics/config-consistency.ts`：读三个配置文件互校，输出结构化问题（severity / 位置 / 建议）。
- 检查项：
  1. 三个配置文件**可解析**（JSON 坏了要早说，而不是等到用时才炸）
  2. 通道的 **provider 是否存在**（内置 `PROVIDER_META` ∪ `providers.json`）
  3. 通道的 **model 是否属于该 provider** —— 特别检测「**模型属于别家**」这类错配
     （当日实例：`provider=deepseek` + `model=stealth/pixel-canary`，后者是 commandcode 家的）
  4. 该 provider 的 **apiKey 是否就绪**（缺 key ⇒ 该通道必然降级/失败）
  5. `provider.active` 与 **主对话实际所用通道**是否一致
  6. **角色映射悬空**（roles 指向不存在的通道）
  7. 仍在使用 **已 deprecated 的模型** ⇒ 提示 `replacedBy`
- 接入三处：`hyacinth doctor`（人工体检）、新工具 `check_config`（随时问）、启动时日志（自动冒出来）。

### ② 模型目录：整家替换 → 按 id 合并
- `model-catalog-loader.ts` 现状：某家一旦声明 `models[]`，**内置那家整家被替换** ⇒ 用户只补 1 个模型会导致其余内置模型消失。
- 改为**按 id 合并**：用户条目覆盖同 id 内置条目，未声明的内置条目保留 —— 与 `provider-meta` 的"逐字段回落"同一风格。

### ③ 清掉工厂里的模型名硬编码 + 守卫测试
- 6 家工厂的第三层兜底 `?? '<具体模型名>'` ⇒ 移除（该层实际不可达：`getProvider()` 已含出厂快照）。
- 新增**守卫测试**：provider 工厂里不得再出现形如模型名的字符串兜底 —— 把边界写成测试，防回归。

### ④ 本文档 + 配置清单
- 见下 §5。附带多进程写入仲裁的**设计草案**（§6，本次不实现）。

### ⑤ user-id 隔离的扩展契约（2026-10-02 补）
DeepSeek 系按 `user_id` 分 KVCache 池，**同 id = 同池 = 互相挤占**（症状：聊到一半突然变慢变贵）。
新增使用点时的规则：

- 有专属函数（`user-id.ts` 里的 `mainUserId` / `compressorUserId` / `subAgentUserId` …）⇒ 用它；
- **没有 ⇒ 自动派生** `{前缀}-{调用点名}`：
  · 通道没配 `userId` ⇒ 按**通道名**派生（装配期，仅内存不落盘）；
  · scoped 调用没传值 ⇒ 按 **role** 派生。
  ⇒ 每个使用点**至少有独立池**，不再静默掉进 `DEFAULT_USER_ID` 的全局池（那是"忘了配"的旧下场）。
- 要按**会话/实例**细分（压缩器、子 Agent 那样）⇒ 走 `createScopedProvider(role, userId)` 显式传带 tag 的值；
  长驻实例是按通道固定的，**做不到按会话切换**。
- **查现状**：`list_model_channels` 末尾的「user-id 隔离」一节列出谁和谁共池。
- 已知未完成：旁路（`orchestrator` / `narration`）目前是**全局静态 id**，不按会话分
  （`user-id.ts` 里预留了 `sessionTag` 形参，待调用链携带 sessionId 后升级）。

### ⑥ `provider.active` 退役（2026-10-02）
**症状**：该字段被多处写（协议层切换 / CLI 命令 / **其它进程的内存快照覆盖**），常停在
**不可服务的值**上（本机长期写着没有 key 的 `openai`），逼得启动链路加"判可服务性 → 忽略 → 告警"
的补丁，用户看到的仍是一条无从下手的提示。

**根治**：把它从"决策输入"降为"遗留字段"——
- **唯一真源**：主对话用哪家 = `model-channels.json` 的 `chat` 通道（切换默认落盘）；
- **启动解析**改走 `provider/startup-resolution.ts`（读 chat 通道，**完全不读 `provider.active`**）；
- **移除** `provider.active` 的 config watch（"改了就生效"由通道热更 `watchModelChannels` 承接）；
- **停止写入**：协议层 `model.switch`、CLI `model set`、TUI 本地模型切换；
- 自检里该项由 `warn` 降级为 **info**（不一致已不影响运行 ⇒ 不该再报一条永远消不掉的警告）。

⇒ 结果：这个字段被谁写、写成什么、被谁覆盖，都不再影响行为。

## 5. 配置清单（谁读 / 谁写 / 何时生效）

| 文件 | 谁读 | 谁写 | 生效时机 | 坑 |
|---|---|---|---|---|
| `~/.agent/providers.json` | `ProviderConfigLoader`（厂商元数据）、`ModelCatalogLoader`（模型目录，读其中的 `models[]`） | 手工 / setup | 热更（`watchProviders`） | **逐字段回落**：文件只写要覆盖的字段；某家写了 `models[]` 会与内置**按 id 合并**（2026-10-02 起） |
| `~/.agent/config.json` | `RuntimeConfigCenter`、`cli.ts`（启动取 `provider.active`） | 配置中心（唯一写入 API） | 热更（`watchConfig`） | **不要手改**：内存快照会覆盖它；多进程各自 save ⇒ 后写者赢 |
| `~/.agent/model-channels.json` | `ModelChannelRegistry` | registry（`upsertChannel` / `setRoleMapping` / `setChannelModel`） | 热更（`watchModelChannels`） | 改通道模型**默认落盘**；临时改动用 `--temp` |
| `~/.agent/models-catalog.json` | **无人读**（已并入 `providers.json`） | — | — | **死文件**；留着只会误导 |
| `<仓库>/.agent/*` | **运行时一律不读**（路径取 `os.homedir()`） | — | — | 本地残留副本，排查时的经典陷阱 |

> 改一个模型名，只需动 **`providers.json`**（在其 `models[]` 里写该模型）—— 代码不再需要跟着改。

## 6. 不做的部分：多进程写入仲裁（设计草案）

**症状**：多个常驻进程各持一份内存快照，任一 `save()` 都会覆盖别人的改动。

**候选方案**（按实现成本排序）：
1. **写前重读 + 三方合并**（read-modify-write）：`save()` 前重读磁盘，若 mtime 变新则以磁盘为底，仅叠加本次改动路径。成本中，改动集中在 `config-center.save()`。
2. **版本号 / mtime 乐观锁**：磁盘存 `_rev`，写入时不匹配则拒绝并提示重载。成本中。
3. **文件锁**（`.lock`）：成本高，Windows 上还有 EPERM 的已知坑。

**本次不做**：该路径是配置核心，改动面大且难以在本机（多进程同时活着的当下）稳定验证。
**先行措施**：① 的自检会**发现**不一致并给出"谁和谁不一致"，把不可见变可见 —— 这已覆盖 80% 的痛。

## 7. 验收

```bash
pnpm test            # 全绿
pnpm verify:layers   # 通过
pnpm build           # 成功
```

- 自检可单独触发：工具 `check_config`（对话中）或 `hyacinth doctor`（命令行）。
- **对当前真实配置跑一次，应当报出**：4 条旁路通道指向余额为 0 的 deepseek 官方（连带提示 402 风险）、
  `default` 通道的 provider 与 model 不属于同一家。
