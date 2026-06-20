# 工作流模式构想

## Plan — 文件驱动的任务分解与逐步执行

**定位**：复杂多步任务的标准执行模式。

**特点**：
- 文件持久化（plan.md），可中断恢复
- 两阶段：analyze（分析+拆解）→ execute（逐步执行）
- analyze 阶段：模型分析任务，将结果写入 plan.md（每行 `- [ ] 描述` 格式）
- execute 阶段：系统逐条驱动，每轮只展示当前步骤
- 所有步骤完成后自动关闭

**适用**：需要分步执行、有明确产出物、可能跨多轮对话的任务。

---

## Spec — 规格驱动的完整开发流程

**定位**：从需求到验收的完整软件工程流程。

**特点**：
- 三文件：spec.md（规格）、tasks.md（执行任务）、checklist.md（验收清单）
- 三阶段：spec → tasks → checklist
- spec 阶段：模型分析需求，一次性创建三个文件
- tasks 阶段：逐条执行 tasks.md（支持多级段落 `## 第N部分`）
- checklist 阶段：逐条验收 checklist.md
- spec.md 内容在 tasks 和 checklist 阶段持久可见
- 所有 checklist 完成后自动关闭

**适用**：需要先设计再实现再验收的开发任务。

---

## TODO — 纯内存的轻量任务跟踪

**定位**：快速记录和追踪简单待办事项。

**特点**：
- 不写文件，全部在内存中
- 两阶段：analyze → execute
- analyze 阶段：模型通过 workflow add 追加步骤，workflow note 记录分析
- execute 阶段：逐条推进内存步骤
- 完成后自动关闭

**适用**：简单一次性任务，不需要持久化记录。

---

## Bootstrap — 首次运行的 identity 初始化

**定位**：收集用户信息，建立 persona 文件。

**特点**：
- 单阶段（collect），使用外部 hook 函数验证
- 收集完成后标记 allDone 标志
- 仅在首次运行（bootstrapStatus === 'pending'）时自动触发

**适用**：首次运行时的身份初始化。
