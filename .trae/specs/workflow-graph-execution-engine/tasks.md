# Tasks

- [x] Task 1: 定义节点执行器接口与注册表
  - [x] SubTask 1.1: 在 `src/workflow/node-executors/types.ts` 定义 `NodeExecutor` 接口（输入：节点数据 + 执行上下文；输出：执行结果 + 下一步指向）
  - [x] SubTask 1.2: 在 `src/workflow/node-executors/registry.ts` 实现 `NodeExecutorRegistry`，提供 `register()` / `get()` / `getAll()` 方法
  - [x] SubTask 1.3: 在 `src/workflow/node-executors/index.ts` 导出注册表与类型

- [x] Task 2: 实现核心节点执行器
  - [x] SubTask 2.1: `start.ts` — 返回入口信号，指向第一个后继节点
  - [x] SubTask 2.2: `end.ts` — 标记工作流完成
  - [x] SubTask 2.3: `note.ts` — 空操作，直接跳过到后继
  - [x] SubTask 2.4: `prompt.ts` — 将模板渲染后写入上下文 `prompts` 数组，供 Zone 5 注入
  - [x] SubTask 2.5: `context.ts` — 注入上下文内容到 `prompts` 数组
  - [x] SubTask 2.6: `agent.ts` — 生成"请执行以下任务"提示词，等待 LLM 完成后推进
  - [x] SubTask 2.7: `tool.ts` — 生成"请调用工具 X"提示词，等待工具结果后推进
  - [x] SubTask 2.8: `branch.ts` — 评估条件表达式，选择 true/false 分支后继
  - [x] SubTask 2.9: `subworkflow.ts` — 递归编译并执行子图，支持 inline subgraph 和 ref 两种模式

- [x] Task 3: 实现图执行引擎
  - [x] SubTask 3.1: 在 `src/workflow/graph-engine.ts` 定义 `GraphExecutionContext` 类型（节点输出表、当前节点、历史）
  - [x] SubTask 3.2: 实现拓扑排序函数 `topologicalSort(graph)`，返回执行顺序
  - [x] SubTask 3.3: 实现 `compileGraphWorkflow(graph, source)` — 将 graph JSON 编译为 `WorkflowDefinition`
    - `createState` 初始化上下文，定位 start 节点
    - `handleStep` 执行当前节点，推进到后继
    - `renderPersistent` 返回已累积的 prompt/context 内容
    - `renderStep` 返回当前节点的执行指令
    - `isComplete` 检查是否到达 end 节点

- [x] Task 4: 扩展 loader.ts 双模式识别
  - [x] SubTask 4.1: 在 `loadWorkflowFile()` 中检测 JSON 是否含 `nodes` 字段
  - [x] SubTask 4.2: 含 `nodes` 则调用 `compileGraphWorkflow()`，含 `phases` 则调用现有 `compileWorkflow()`
  - [x] SubTask 4.3: 两者都有或都没有时抛出明确错误
  - [x] SubTask 4.4: `scanWorkflowsDir()` 自动适配两种格式

- [x] Task 5: 新增 WebUI 保存 API
  - [x] SubTask 5.1: 在 `webui-channel.ts` 添加 `POST /api/workflows/save` 端点
  - [x] SubTask 5.2: 端点接收 `{ name, graph }`，写入 `~/.agent/workflows/<name>.json`
  - [x] SubTask 5.3: 调用 loader 编译并注册到 `WorkflowRegistry`，即时生效
  - [x] SubTask 5.4: 返回 `{ success, name, registered }` 确认

- [x] Task 6: WebUI 编辑器添加保存按钮
  - [x] SubTask 6.1: 在 `WorkflowPanel.tsx` 编辑器视图工具栏添加"保存"按钮
  - [x] SubTask 6.2: 点击后调用 `POST /api/workflows/save`，传入当前 graph 和 metadata.name
  - [x] SubTask 6.3: 成功时显示 toast 提示，失败时显示错误

- [x] Task 7: 编译验证与全局安装
  - [x] SubTask 7.1: 后端 `pnpm build` 通过
  - [x] SubTask 7.2: 前端 `pnpm build` 通过
  - [x] SubTask 7.3: `pnpm link --global` 全局安装
  - [x] SubTask 7.4: 启动 WebUI 验证保存功能可用

# Task Dependencies

- Task 2 依赖 Task 1（执行器需要注册表接口）
- Task 3 依赖 Task 1 和 Task 2（引擎调用执行器）
- Task 4 依赖 Task 3（loader 调用图编译器）
- Task 5 依赖 Task 4（API 调用 loader）
- Task 6 依赖 Task 5（前端调用 API）
- Task 7 依赖 Task 6
