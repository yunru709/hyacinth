# 工作流图执行引擎 Spec

## Why

Phase 3 完成了 WebUI 图形编辑器，可生成 graph-based JSON（nodes + edges）。但现有后端 `loader.ts` 只能编译 phase-based JSON（phases + complete），无法执行图形编辑器产出的图结构。需要一座"图 → 执行"的桥梁，让用户在画布上搭建的工作流能实际运行。

设计文档明确"不做独立图执行引擎"，意为**不重写 AgentLoop 管道**，而是将图编译为现有 `WorkflowDefinition` 接口的实现，复用 `WorkflowManager` / `Registry` / Zone 5 注入。本 spec 据此设计：图执行引擎作为 `WorkflowDefinition` 的一种实现形态存在。

## What Changes

- 新增后端图执行引擎 `src/workflow/graph-engine.ts`：将 graph JSON 编译为 `WorkflowDefinition`
- 新增节点执行器注册表 `src/workflow/node-executors/`：每种节点类型的执行逻辑可注册、可插拔
- 实现核心节点执行器：`start` / `end` / `agent` / `tool` / `prompt` / `context` / `subworkflow` / `branch` / `note`
- 扩展 `loader.ts`：自动识别 graph-based JSON（有 `nodes` 字段）vs phase-based JSON（有 `phases` 字段），分别编译
- 新增 WebUI API：`POST /api/workflows/save` 保存 graph JSON 到 `~/.agent/workflows/`，即时注册生效
- WebUI 编辑器添加"保存到后端"按钮
- **BREAKING**：无（现有 phase-based JSON 完全兼容，graph-based 是新增能力）

## Impact

- Affected specs: 无（新能力）
- Affected code:
  - `src/workflow/loader.ts` — 扩展为双模式编译器
  - `src/workflow/graph-engine.ts` — 新增
  - `src/workflow/node-executors/` — 新增目录
  - `src/workflow/index.ts` — 导出新 API
  - `src/channels/builtin/webui-channel.ts` — 新增保存端点
  - `webui/src/components/workflow-graph/WorkflowGraphEditor.tsx` — 添加保存按钮
  - `webui/src/types.ts` — graph JSON 类型已在前序阶段定义

## ADDED Requirements

### Requirement: 图执行引擎

系统 SHALL 提供一个图执行引擎，将 graph-based JSON（含 nodes/edges 的图结构）编译为 `WorkflowDefinition` 运行时对象，复用现有 `WorkflowManager` 激活、步骤分发、Zone 5 注入机制。

#### Scenario: 编译 graph JSON

- **WHEN** loader 接收到含 `nodes` 字段的 JSON 文件
- **THEN** 调用 `compileGraphWorkflow()` 编译为 `WorkflowDefinition`
- **AND** 该 `WorkflowDefinition` 的 `createState` 初始化图执行上下文（当前节点指针、节点输出表）
- **AND** `handleStep` 按拓扑顺序推进节点执行
- **AND** `renderPersistent` / `renderStep` 注入当前节点的提示词到 Zone 5

#### Scenario: 节点拓扑排序

- **WHEN** 图执行引擎初始化
- **THEN** 对节点按 edges 做拓扑排序
- **AND** 从 `start` 节点开始，沿 edges 推进
- **AND** `branch` 节点根据条件选择后续路径
- **AND** 到达 `end` 节点时标记完成

### Requirement: 节点执行器注册表

系统 SHALL 提供节点执行器注册表，每种节点类型对应一个执行器函数，遵循统一接口，支持注册自定义执行器。

#### Scenario: 注册节点执行器

- **WHEN** 系统启动
- **THEN** 内建节点执行器自动注册（start/end/agent/tool/prompt/context/subworkflow/branch/note）
- **WHEN** 第三方插件调用 `registerNodeExecutor(type, executor)`
- **THEN** 该类型节点的执行逻辑被覆盖

### Requirement: 子图递归执行

系统 SHALL 支持子图无限嵌套执行。`subworkflow` 节点的执行器递归调用图执行引擎，执行其 `subgraph` 或引用的外部工作流。

#### Scenario: 执行内嵌子图

- **WHEN** 执行到 `subworkflow` 节点且 `data.subgraph` 非空
- **THEN** 递归编译子图为子 `WorkflowDefinition`
- **AND** 在隔离的状态上下文中执行子图
- **AND** 子图完成后将输出传递回父图

#### Scenario: 执行引用子图

- **WHEN** 执行到 `subworkflow` 节点且 `data.subworkflowRef` 非空
- **THEN** 从 `WorkflowRegistry` 查找引用的工作流
- **AND** 激活并执行该工作流
- **AND** 完成后返回父图继续执行

### Requirement: WebUI 保存工作流

系统 SHALL 提供 `POST /api/workflows/save` 端点，接收 graph JSON，保存到 `~/.agent/workflows/<name>.json`，并即时注册到 `WorkflowRegistry`。

#### Scenario: 保存并即时生效

- **WHEN** 用户在编辑器点击"保存"
- **THEN** graph JSON 通过 API 发送到后端
- **AND** 后端写入 `~/.agent/workflows/<name>.json`
- **AND** 编译为 `WorkflowDefinition` 并注册到 Registry
- **AND** 立即可在列表中看到并激活（无需重启）

### Requirement: 双模式 JSON 识别

系统 SHALL 自动识别工作流 JSON 的两种格式：phase-based（含 `phases` 字段）和 graph-based（含 `nodes` 字段），分别调用对应的编译器。

#### Scenario: 识别 graph JSON

- **WHEN** JSON 含 `nodes` 数组字段
- **THEN** 调用 `compileGraphWorkflow()` 编译
- **WHEN** JSON 含 `phases` 数组字段
- **THEN** 调用现有 `compileWorkflow()` 编译
- **WHEN** 两者都有或都没有
- **THEN** 抛出明确的错误信息

## MODIFIED Requirements

### Requirement: 工作流加载器

`loader.ts` 的 `loadWorkflowFile()` 和 `scanWorkflowsDir()` SHALL 自动识别 JSON 格式，分派到对应编译器。现有 phase-based JSON 行为完全不变。
