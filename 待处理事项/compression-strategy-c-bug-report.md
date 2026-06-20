# 压缩策略 C 缺少三区保护区设计 — Bug 报告

**报告日期:** 2026-06-20 00:34  
**报告人:** 风信子 🪻  
**相关文件:** `src/context/compressor.ts`

---

## 摘要

策略 A（独立提示词压缩）实现了完整的三区设计（保护区 / 规则裁切区 / LLM 压缩区），但策略 C（克隆对话压缩）**跳过了分层逻辑**，将整段历史直接丢给 LLM 自行压缩，可能导致进行中的任务被误判为已完成。

---

## 现状

### 策略 A（`llmMode: 'prompt'`）— ✅ 正常

完整走 `compress()` 方法的分层逻辑：

```
┌─────────────────────────────────────────────┐
│  Layer 3 (LLM压缩) │ Layer 2 (规则裁剪) │ Layer 1 (保护区) │
├─────────────────────────────────────────────┤
│  远端历史           │  中间段              │  最近 N 条不压缩  │
│  → 结构化摘要       │  → tool result 摘要化 │  → 原始保留       │
│                     │  → 去重 / 截断       │                   │
└─────────────────────────────────────────────┘
```

- `protectLast` 参数确保近端不压缩
- `ToolOutputTrimmer` 规则裁剪中间段
- LLM 只压缩最旧部分，且有 `layer2+layer1` 作为相关性锚点

### 策略 C（`llmMode: 'clone'`）— ❌ 缺少保护区

策略 C 调用 `summarizer.summarizeViaClone()`，该方法：

```typescript
// compressor.ts 第 515-581 行
async summarizeViaClone(fullMessages: Message[]): Promise<string> {
  const cloned = fullMessages.map(m => ({ ...m, content: ... }));
  // 清除 cache_control
  // 找到最后一条 user 消息
  // 替换为压缩指令 ← 替换的是整段消息中的最后一条 user 消息
  // 发送给 LLM ← 完整上下文，不做分层
}
```

**存在的问题：**

1. **没有 `protectLast` 保护区** — 最近 N 轮对话没有原始保留的保障
2. **没有 Layer 2 规则裁剪** — 跳过 `ToolOutputTrimmer`，tool result 摘要化 / 去重 / 截断全部不执行
3. **没有 Layer 3 定向压缩** — 整段历史（包括近期的、正在进行中的任务上下文）全部暴露给 LLM 做判断

---

## 用户场景：压缩后模型误认为任务已完成

**触发路径：**

1. 模型正在执行一个多步骤任务（如"重构模块 X"），已完成 A/B 两步，正在做 C
2. 上下文触顶，触发压缩
3. 策略 C：整段历史（包括正在进行的 C 步骤上下文）被克隆后发给 LLM
4. LLM 看到整段历史，将其全部摘要为已完成状态（包括 C 步骤）
5. 压缩完，模型看到摘要中"模块 X 重构已完成"，认为自己已经完成了任务
6. **任务中断，未完成**

策略 A 不会触发此问题：Layer 1（保护区）保留最近 N 条原始消息，模型能感知到"我还在做 C 步骤"。

---

## 修复建议

让策略 C 也走分层逻辑 — 只对 Layer 3（远端历史）使用 `summarizeViaClone` 的克隆对话方式压缩：

```
compress() 分层 → Layer 3 用 summarizeViaClone → Layer 2 用 ToolOutputTrimmer → Layer 1 保留
```

具体修改点：

1. `compress()` 方法中，当 `llmMode === 'clone'` 时，不走 `summarizeViaClone(composedMessages)` 全量压缩
2. 改为：分层后的 `layer3` 单独走克隆对话压缩（需要从 composedMessages 中提取对应的消息子集）
3. Layer 2 和 Layer 1 保持现有策略 A 的处理方式

这样既保留了策略 C 的缓存优势（system prompt + 历史命中缓存），又不会丢失近端上下文的原始状态。

---

## 优先级

**中高。** 不是崩溃类 bug，但会直接导致任务可靠性下降。在策略 C 作为默认策略的情况下，用户遇到"任务莫名其妙自己收工了"的几率不低。
