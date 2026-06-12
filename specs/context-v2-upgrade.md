# Spec: 上下文系统 V2 升级

> 创建日期：2026-05-25  
> 基于讨论：上下文池 + 5层架构 + 工具语义压缩 + 本地模型通道

---

## 一、目标

在现有 L0-L3 上下文系统基础上，做三项增量升级：

1. **5 层上下文架构** — 在 System Prompt 和近期对话之间插入"池检索层"，从全量对话历史中按相关性捞取
2. **工具语义压缩** — Write/Edit 的大 JSON input 不再暴力截断，改为提取接口签名
3. **本地模型压缩通道** — `StructuredSummarizer` 支持传入独立 Provider（本地模型），不改架构只改传参

---

## 二、新架构：5 层上下文

```
┌──────────────────────────────────────────────────┐
│ Zone 1: System Prompt          │ 缓存标记 ✓      │
│   identity + environment + tools + coding + safe │
├──────────────────────────────────────────────────┤
│ Zone 2: Tools / Skills / MCP 索引│ 缓存标记 ✓    │
│   精确模式 → lazy_expand 按需展开                 │
├──────────────────────────────────────────────────┤
│ Zone 3: 全局摘要 + Plan + 项目上下文              │
│   historySummary + currentPlan + projectContext   │
│   有时命中缓存；中间位置，放"复习材料"            │
├──────────────────────────────────────────────────┤
│ Zone 4: 池检索相关内容                            │
│   从 conversation.jsonl 全量池检索                │
│   排除 Zone 5 已覆盖的消息 (天然不重复)           │
│   近结尾 — 近因效应，补充回忆                     │
├──────────────────────────────────────────────────┤
│ Zone 5: 近期对话 (不可压缩)     │ 结尾           │
│   最近 N 轮 (默认 6 轮)，完整保留                 │
│   结尾 — 近因效应最强，当前对话最重要             │
└──────────────────────────────────────────────────┘
```

**注意**：旧架构是 Zone 1-4，新架构是 Zone 1-5。
- 旧 Zone 3 (历史摘要) → 新 Zone 3（不变，逻辑不变）
- 旧 Zone 4 (近期对话) → 新 Zone 5（推到最末尾）
- 新 Zone 4 → 池检索相关内容（在摘要和近期对话之间）

### 2.1 排列理由

缓存友好 + LLM 注意力兼顾：

| Zone | 内容 | 变化频率 | 缓存 | LLM 注意力 |
|------|------|---------|------|-----------|
| Zone 1 | System Prompt | 几乎不变 | 命中 | 强 (首因) |
| Zone 2 | Tools/Skills | 增删时变 | 命中 | 强 |
| Zone 3 | 摘要 + Plan | 偶尔变 | 有时中 | 弱 (中间) |
| Zone 4 | 池检索 | 每轮变 | 断裂 | 强 (近结尾) |
| Zone 5 | 近期对话 | 每轮变 | 断裂 | 最强 (结尾) |

**缓存效果**：Zone 1-2 稳定缓存；Zone 3 偶尔缓存断裂但不影响后面的 Zone 4-5（它们本来就每轮变）；Zone 4-5 每轮变但放最后，不影响前面缓存。

---

## 三、实现任务

### Task 1: 新增 `context/retriever.ts`

**职责**：从全量 `conversation.jsonl` 中检索与当前用户输入相关的历史消息。

**输入**：
```typescript
interface RetrieveOptions {
  pool: Message[];           // conversation.jsonl 全量消息
  excludeLast: number;       // 排除最近 N 条 (Zone 3 已覆盖)
  userInput: string;         // 当前用户输入
  maxTokens: number;         // Zone 5 预算上限
  tokenCounter: TokenCounter;
}
```

**输出**：
```typescript
interface RetrieveResult {
  messages: Message[];       // 得分 top-N, 总 token ≤ maxTokens
  totalTokens: number;
}
```

**检索算法**（关键词交集，不需要向量/embedding）：

```
1. 从 userInput 提取关键词（分词 + 去停用词 + 去重）

2. pool.slice(0, -excludeLast) 中每条消息计算得分:
   score = |消息关键词 ∩ 用户关键词| / |用户关键词|
   
   加分项:
   - 消息中的文件路径与 Zone 3 最近涉及的路径重合 → ×1.5
   - 越近的消息微调: ×(1 + 0.1 × (position / pool.length))

3. 按 score 降序排列，取前 top-N，总分不超过 maxTokens

4. 返回结果
```

**文件**：`agent/src/context/retriever.ts`（新建，~100 行）

---

### Task 2: 修改 `context/composer.ts` — 5 层架构

**改动点**：

#### 2.1 `ComposeOptions` 新增字段（在 `interface.ts`）

```typescript
interface ComposeOptions {
  // ... 现有字段 ...
  fullHistory?: Message[];     // ← 新增：conversation.jsonl 全量，用于 Zone 4 检索
}
```

#### 2.2 `composeCore()` 调整 Zone 编号

```
旧:
  assembleZone1 → Zone 1
  assembleZone2 → Zone 2
  assembleZone3 → Zone 3 (摘要 + Plan + 项目上下文)
  assembleZone4 → Zone 4 (近期对话)

新:
  assembleZone1 → Zone 1 (不变)
  assembleZone2 → Zone 2 (不变)
  assembleZone3 → Zone 3 (摘要 + Plan + 项目上下文，逻辑不变)
  assembleZone4 → Zone 4 (从 fullHistory 检索 → 新增)
  assembleZone5 → Zone 5 (近期对话，从旧 Zone4 移到最后)
```

#### 2.3 `assembleZone3` (不变)

历史摘要 + Plan + 项目上下文。逻辑不变。

#### 2.4 `assembleZone4` — 新增

```
assembleZone4(fullHistory, zone5Messages, userInput):
  if (!fullHistory || fullHistory.length === 0) → 返回空
  
  excludeCount = zone5Messages 中来自历史的消息数量
  results = retriever.retrieve({
    pool: fullHistory,
    excludeLast: excludeCount,
    userInput,
    maxTokens: getZoneBudget(4),
  })
  → 注入 "[Context Pool Results]" 标记
```

#### 2.5 `assembleZone5` (原 assembleZone4)

近期的 N 轮对话在这里。**标记为不可压缩**——Compressor 不应触碰 Zone 5 的内容。

#### 2.6 Token 预算分配

```
Zone 1 (anchor):     5%
Zone 2 (manifest):   10%
Zone 3 (summarized): 25%  ← 摘要
Zone 4 (retrieved):  20%  ← 池检索
Zone 5 (live):       40%  ← 近期对话，最重要
```

注意：总预算 = `maxContextTokens`（默认 200000），不超出。

---

### Task 3: 修改 `context/compressor.ts` — 工具语义压缩 + Zone 5 保护

#### 3.1 `truncateLargeToolCalls` → 替换为接口级压缩

**当前**：`summarizeToolInput` 截断 content 到 60 字符。

**新**：按工具类型分别处理。

##### Write 工具

```
输入: Write(file_path="xxx.ts", content="export async function logUserActivity(
  userId: string, action: string, metadata?: Record<string, unknown>):
  Promise<void> { const timestamp = new Date(); ... 42 more lines ... }")

提取:
  1. 函数/类签名: export (async )?function (\w+)(\([^)]*\)): \S+
  2. import 语句: import .* from ['\"](.+)['\"]
  3. 行数: content.split('\n').length

输出:
  "[Write] xxx.ts (+N lines): logUserActivity(userId, action, metadata?): void;
   imports: getConnection from db.ts"
```

##### Edit 工具

```
输入: Edit(file_path="xxx.ts", old_string="...", new_string="...")

提取:
  1. old_string 的第一行和最后一行 (上下文定位)
  2. 行数变化: old_lines → new_lines

输出:
  "[Edit] xxx.ts: ~line N: old_str(开头)... → new_str(开头)... (Ls→Ls)"
```

##### 其他工具

保持现有截断逻辑不变（Read → 行数摘要；Bash → 输出截断；Grep → 结果数）。

实现位置：`compressor.ts` 的 `ToolOutputTrimmer` 内部。不改外部接口。

#### 3.2 Zone 5 保护

```typescript
// compressor.ts 的 compress() 方法
compress(messages: Message[], zone5StartIndex: number): {
  // messages 排列: Zone1 → Zone2 → Zone3(摘要) → Zone4(检索) → Zone5(近期对话)
  // Zone 5 不可压缩 → 从 zone5StartIndex 开始，跳过
  // 只对 Zone 1-4 的内容做压缩 (Phase 1 也跳过 Zone 5)
}
```

需要在 `LayeredContext` 中新增 `zone5StartIndex` 字段，供 Compressor 知道从哪里开始不可碰。

---

### Task 4: 修改 `context/interface.ts` — 类型更新

```typescript
interface LayeredContext {
  messages: Message[];
  zoneBreakdown: Record<string, { used: number; budget: number }>;
  cacheMarkers: number[];
  zone4StartIndex: number;   // ← 新增：Zone 4 开始位置
  zone5StartIndex: number;   // ← 新增：Zone 5 开始位置 (Compressor 跳过边界)
}
```

---

### Task 5: 修改 `orchestrator/loop.ts` — 传全量历史

```typescript
// loop.ts runTurn() 中
const fullHistory = this.conversation.readAll(sessionDir);  // 已有
const composed = this.composer.compose({
  ...opts,
  fullHistory,   // ← 新增
});
```

---

### Task 6: 本地模型压缩通道（最小改动）

**不改架构，只改传参**。

`StructuredSummarizer` 已经依赖 `Provider` 接口。当前：

```typescript
// factory.ts 或 loop.ts
const summarizer = new StructuredSummarizer(provider);
```

改为支持独立 Provider：

```typescript
const summarizer = new StructuredSummarizer(
  localProvider ?? provider   // ← 如果有本地模型就用本地的
);
```

本地 Provider 需通过 CLI 参数传入：
```
--local-model <name>   指定本地模型 (从 .agent/models.json 读取)
```

`lifecycle/local-model.ts` 已有 `LocalModelManager`，可以复用其启动逻辑。

**不需要修改**：
- `StructuredSummarizer` 类
- `CompressorOrchestrator` 类
- `Provider` 接口

---

### Task 7: 清理已知死代码

| 位置 | 问题 | 处理 |
|------|------|------|
| `compressor.ts` `shouldCompressDP()` | DP 决策恒为负（`0.6 - 1.15`），从未触发 | **删除**。简化为 `token > 80% → 压缩` |
| `tokenizer.ts` `getZoneBudget().used: 0` | 硬编码为 0，不追踪实际使用 | 改为从 `composer` 传入实际使用量，或至少标记为 `@fixme` |
| `compressor.ts` Phase 4 截断 | 可能破坏 Anthropic 消息交替规则 | 加 `ensureAlternatingRoles()` 保护 |

---

## 四、不改的地方

| 模块 | 原因 |
|------|------|
| `prompt-builder.ts` | Zone 1 不做任何改动 |
| `modes.ts` | ModeDetector 是降级方案，不动 |
| `planner.ts` | LLMOrchestrator 不动 |
| `provider/` | 不动，本地通道在 factory 层解决 |
| `tools/` | 不动 |
| `memory/` | 不动，conversation.jsonl 已经是全量池 |

---

## 五、文件改动清单

| 文件 | 操作 | 预估行数 |
|------|------|---------|
| `context/retriever.ts` | **新建** | ~100 |
| `context/composer.ts` | 重构 Zone 编号 + 新增 assembleZone4 + assembleZone5 后移 | +80 / -20 |
| `context/interface.ts` | 新增 ComposeOptions.fullHistory + LayeredContext zone 索引字段 | +10 |
| `context/compressor.ts` | 替换 truncateLargeToolCalls + Zone5 保护 + 删除 DP | +80 / -40 |
| `context/tokenizer.ts` | Zone 预算从 4 区改为 5 区 | +10 |
| `orchestrator/loop.ts` | 传 fullHistory | +3 |
| `gateway/factory.ts` | StructuredSummarizer 可接本地 Provider | +5 |
| `gateway/cli.ts` | 加 `--local-model` 参数 | +10 |
| `context/index.ts` | 导出 retriever | +2 |

**总计**：~300 行新增 + ~60 行删除

---

## 六、测试建议

1. **retriever 单元测试**：给定 20 条 mock 消息，验证检索结果排除 Zone 5 覆盖部分
2. **composer 集成测试**：验证 5 个 Zone 的 token 预算不超总上限
3. **compressor 单元测试**：Write/Edit 工具语义压缩输出格式
4. **compressor 单元测试**：Zone 5 保护 — 压缩后 Zone 5 消息不变

---

## 七、验收标准

1. `compose()` 返回的 messages 数组包含 5 个 Zone 的标记
2. Zone 4 内容来自全量池检索，不包含 Zone 5 已有消息（无重复）
3. Write 工具的大 JSON input ≥ 2000 字符 → 输出接口签名而非 60 字符截断
4. 本地模型 Provider 可传入 `StructuredSummarizer`，不影响云端主 Provider
5. 删除 `shouldCompressDP` 后，压缩仍能正常触发（硬阈值 80%）
6. `pnpm build` 通过
