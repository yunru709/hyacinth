# DeepThink Agent 工作流设计 — 用户层图引擎

---

## 一、定位

将 Agent 从"对话框"扩展为**工作流 Agent 平台**——用户通过拖拽节点或写 JSON 配置的方式，搭建 TODO、AI 漫剧、写小说、办公自动化等应用工作流。

**不是** Agent 管道引擎的重写。现有 `WorkflowDefinition` 接口 + `WorkflowManager` + `workflow` 工具 + Zone 5 注入全部保留不动。工作流平台是站在现有基础设施上的**应用层**。

### 1.1 不做什么

| 不做 | 原因 |
|------|------|
| 系统层管道编排（Compose/Compress/LLM/Parser/Gateway 等） | 框架内部管线，用户不需要关心也不需改 |
| 图执行引擎 / GraphIR 编译器 | 现有 WorkflowDefinition + WorkflowManager 已能跑 |
| 运行时高亮 / 单步执行 | 价值有限，UI 复杂度高 |
| 工作流热加载 | 现有 WorkflowRegistry 的热注册机制已够用 |

### 1.2 现有系统能做什么

```
workflow 工具（LLM 可调用）
  ├── list     → 列出可用 Workflow
  ├── activate → 激活 Workflow（注入提示词到 Zone 5）
  └── step     → 推进步骤（done/blocked/add/note/progress/complete）

Zone 5 注入：
  workflow_persistent — 阶段引导/分析结果，阶段切换时变化
  workflow_step      — 当前步骤指令，每步变化

loop.ts 集成：
  工具执行前保存工作流状态快照
  工具执行后检测工作流是否完成
  workflow 工具结果不记入对话历史（状态由 Zone 5 注入体现）
```

### 1.3 工作流在框架中的位置

```
（用户看到的）
应用工作流（漫剧 / 写小说 / 办公自动化……）
  └── 节点可以是：
      ├── 基础节点（input / output / file / state / steps / text 等）
      ├── 应用节点（TODO / Plan / Spec / CodeReview 等）
      ├── 子工作流节点（引用另一个完整工作流作为内部子图）
      └── 连线定义数据流向

（框架层面，已有不动）
WorkflowDefinition 接口 → WorkflowRegistry → WorkflowManager → Zone 5 注入 → AgentLoop
```

---

## 二、工作流定义格式

### 2.1 JSON Schema

工作流用 JSON 定义，JSON 是最终的格式（不是 YAML）。原因：
- 最终消费方是 WebUI（序列化友好）和 LLM（生成 JSON 比 YAML 稳定）
- JSON 是 WebUI 原生格式，不需要额外的序列化/反序列化步骤
- LLM 写 JSON 配置比写 YAML 更可靠（不会搞错缩进）

```json
{
  "name": "my-workflow",
  "description": "工作流描述",
  "version": "1.0",
  "nodes": [
    {
      "id": "input_1",
      "type": "input",
      "label": "用户输入",
      "config": {}
    },
    {
      "id": "sub_1",
      "type": "subworkflow",
      "label": "审批流程",
      "config": {},
      "subgraph": {
        "name": "approval-flow",
        "nodes": [
          { "id": "sub_input", "type": "input", "label": "审批输入" },
          { "id": "review", "type": "todo", "label": "审查任务", "config": { "splitPrompt": "逐项审查" } },
          { "id": "approve", "type": "hook.call", "label": "调用审批API", "config": { "hook": "sendApproval" } },
          { "id": "sub_output", "type": "output", "label": "审批结果" }
        ],
        "edges": [
          { "from": "sub_input", "to": "review" },
          { "from": "review", "to": "approve" },
          { "from": "approve", "to": "sub_output" }
        ]
      }
    },
    {
      "id": "todo_1",
      "type": "todo",
      "label": "TODO 任务拆分",
      "config": {
        "splitPrompt": "请将用户需求拆分为可独立执行的步骤",
        "maxRetries": 3
      }
    },
    {
      "id": "output_1",
      "type": "output",
      "label": "最终输出",
      "config": {}
    }
  ],
  "edges": [
    { "from": "input_1", "to": "sub_1" },
    { "from": "sub_1", "to": "todo_1" },
    { "from": "todo_1", "to": "output_1" }
  ]
}
```

### 2.2 节点通用结构

每个节点都有一个统一的 JSON 结构，不论什么类型：

```json
{
  "id": "唯一标识",
  "type": "节点类型名（如 todo, file.read, state.set, subworkflow）",
  "label": "人类可读名称",
  "config": {
    "type": "object",
    "properties": {
      // 节点类型特有的配置项
    }
  },
  "subgraph": {
    // 仅 type 为 subworkflow 时有此字段
    "name": "子工作流名称",
    "nodes": [...],
    "edges": [...]
  },
  "position": {
    "x": 100,
    "y": 200
  }
}
```

### 2.3 工作流加载

```
启动
  ├→ 扫描 src/workflow/builtin/*.json → 注册内置工作流
  ├→ 扫描 .agent/workflows/*.json → 注册用户工作流
  └→ WebUI 保存 → 直接注册到 WorkflowRegistry
      （不需要重新编译、不需要重启、即时生效）
```

---

## 三、节点类型体系

### 3.1 模型约束节点（基础积木）

这些是搭建工作流模板的低级节点，对应模型的输入/输出控制：

| 节点 | 用途 | 说明 |
|------|------|------|
| `input` | 接收用户输入 | 每个工作流有且仅有一个 |
| `output` | 输出最终结果 | 每个工作流有且仅有一个 |
| `subworkflow` | 引用子工作流 | 内部嵌套另一个完整的工作流 |
| `todo` | 需求拆分 → 逐步执行 | 单次任务执行工作流 |
| `state.set` | 写入状态字段 | 修改 data 中的任意字段 |
| `state.get` | 读取状态字段 | 从 data 中取值 |
| `file.read` | 读取文件内容 | 读取步骤文件、模板文件等 |
| `file.write` | 写入内容到文件 | 保存拆分结果、进度文件等 |
| `file.mkdir` | 创建目录 | 确保工作目录存在 |
| `file.exists` | 检查文件是否存在 | 条件判断用 |
| `text.template` | 渲染模板字符串 | 用数据填充提示词模板 |
| `text.render_checkboxes` | 渲染步骤为 checkbox | 生成模型可见的步骤列表 |
| `text.parse_checkboxes` | 从文本解析 checkbox | 模型改完步骤后解析回结构化数据 |
| `step.create` | 创建一个步骤 | 初始化步骤列表 |
| `steps.mark` | 标记步骤状态 | done / blocked / in_progress |
| `steps.current` | 找到当前步骤 | 返回 pending 状态的第一个步骤 |
| `steps.progress` | 生成进度摘要 | 人类可读的完成情况 |
| `steps.all_done` | 检查全部完成 | 布尔判断 |
| `steps.count` | 统计各状态数量 | pending / completed / blocked |
| `control.switch` | 多路分支路由 | 根据条件选择执行路径 |
| `control.guard` | 阶段守卫 | 分析阶段 vs 执行阶段切换 |
| `render.section` | 生成带标题的内容段 | 格式化输出 |
| `render.compose` | 组合多个段 | 把多个内容段拼为一个 |
| `hook.call` | 调用外部函数 | 扩展点（限注册过的 hook） |
| `path.join` | 拼接路径段 | 文件路径操作 |

### 3.2 应用工作流节点

这些是预置的应用节点，用户拖到画布上直接连线使用。它们由模型约束节点组合而成：

| 节点 | 用途 | 内部逻辑 |
|------|------|---------|
| `todo` | 多步任务拆分执行 | 拆分器 → 任务队列 → 执行器 → 上报器 → 错误处理 |
| `plan` | 先规划后执行 | 规划分析 → 任务拆解 → 逐条执行 |
| `spec` | 规范驱动执行 | 规范生成 → 任务拆分 → 检查清单 |
| `code_review` | 代码审查 | 差异分析 → 逐文件审查 → 汇总报告 |

应用工作流节点只做一件事：接收输入、按配置执行、产生输出。内部是否分阶段、是否有循环，由节点的 `config` 控制，外部不需要关心。

### 3.3 节点接口定义

所有节点类型共享统一接口：

```typescript
interface NodeDefinition {
  /** 节点类型名，全局唯一 */
  type: string;
  /** 人类可读名称 */
  label: string;
  /** 类别：基础 / 应用 / 复合（子工作流） */
  category: 'basic' | 'application' | 'composite';
  /** 输入端口列表 */
  inputs: PortDef[];
  /** 输出端口列表 */
  outputs: PortDef[];
  /** 配置项的 JSON Schema */
  configSchema: JSONSchema;
  /** 是否可包含子图（复合节点专用） */
  supportsSubgraph?: boolean;
}

interface PortDef {
  name: string;
  type: 'data' | 'control';
  required: boolean;
  description: string;
}
```

---

## 四、WebUI 工作台

### 4.1 页面布局

```
┌──────────────────────────────────────────────────────────┐
│  工作台                                                   │
│  ┌──────────┬───────────────────────────┬──────────────┐  │
│  │ 组件栏    │       画布                │  配置面板     │  │
│  │           │                           │              │  │
│  │ 应用节点   │  [Input]──→[TODO]──→[Output]  │  选中: TODO│  │
│  │ ├─TODO   │           ↓              │              │  │
│  │ ├─Plan   │     [画图节点]            │  拆分规则:   │  │
│  │ ├─Spec   │           ↓              │  ┌────────┐  │  │
│  │ └─Review │     [配音节点]            │  │提示词..│  │  │
│  │           │           ↓              │  └────────┘  │  │
│  │ 基础节点   │       [Output]           │              │  │
│  │ ├─file   │                           │  重试次数:   │  │
│  │ ├─state  │                           │  [3]        │  │
│  │ ├─steps  │                           │              │  │
│  │ ├─text   │                    [▶ 运行] │              │  │
│  │ ├─ctrl   │                           │              │  │
│  │ └─render │                           │  [保存] [导出]│  │
│  │           │                           │              │  │
│  └──────────┴───────────────────────────┴──────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 4.2 设计规范

| 项目 | 说明 |
|------|------|
| **组件栏** | 左侧，列出所有可用节点类型，按类别分组（应用节点 / 基础节点 / 复合节点），支持搜索 |
| **画布** | 中间，拖放节点、连线、拖拽平移、缩放 |
| **配置面板** | 右侧，选中节点时显示其配置表单，按 JSON Schema 动态生成 |
| **节点外观** | 方框，左侧输入端口，右侧输出端口，中间显示节点名和配置摘要；复合节点用虚线边框标识 |
| **连线** | 从输出端口拖到输入端口，定义数据流向 |
| **输入/输出节点** | 每个工作流有且仅有一个 Input 和一个 Output 节点 |
| **子图展开** | 双击复合节点 → 画布切换到子图内部，面包屑导航回溯 |
| **保存** | 序列化为 JSON → 注册到 WorkflowRegistry |
| **导出** | 导出为 JSON 文件 |
| **运行** | 将当前工作流注册为可用 Workflow，对话中直接激活 |

### 4.3 节点端口规范

每个节点：
- **左侧**：输入端口（接收数据/控制信号）
- **右侧**：输出端口（发送数据/控制信号）
- **底部**：可有额外输出端口（如错误出口）

端口之间通过**连线**定义数据流。工作流的执行顺序由连线的拓扑结构决定。

---

## 五、子图展开机制（Subgraph Expansion）

### 5.1 什么是子图展开

子图展开是指：**一个节点内部包含一个完整的工作流图，双击该节点可以进入其内部子图画布进行编辑**。

```
主画布（小说写作工作流）
┌──────────────────────────────────────────────┐
│ [Input] → [TODO:大纲规划] → [TODO:章节写作] → [配音] → [Output] │
│                    ↓                          │
│              [审批子工作流]                     │
└──────────────────────────────────────────────┘
        │ 双击"审批子工作流"节点
        ▼
┌──────────────────────────────────────────────┐
│ 子图：审批流程                                 │
│ [输入] → [TODO:逐项审查] → [hook:审批API] → [输出] │
└──────────────────────────────────────────────┘
    面包屑: 小说工作流 > 审批子工作流
```

### 5.2 嵌套规则

- 任何节点都可以是复合节点（`subgraph` 字段非空即表示该节点包含子图）
- 子图中的节点**同样可以是复合节点**，嵌套层数不设上限
- 嵌套深度的实际限制由 UI 可用性和性能决定，框架不做硬限制

### 5.3 子图的序列化

子图在 JSON 中以内联方式表达：

```json
{
  "id": "approval_1",
  "type": "subworkflow",
  "label": "审批流程",
  "subgraph": {
    "name": "approval-flow",
    "nodes": [...],
    "edges": [...]
  }
}
```

子图也可以引用独立文件：

```json
{
  "id": "approval_1",
  "type": "subworkflow",
  "label": "审批流程",
  "config": {
    "ref": ".agent/workflows/approval-flow.json"
  }
}
```

### 5.4 子图的边界定义

每个子图是一个**独立的封闭工作流**：

| 属性 | 说明 |
|------|------|
| 独立命名空间 | 子图内的节点 id 只在子图范围内有效，不污染父图命名空间 |
| 输入端口 | 子图的 `input` 节点对应父节点上的输入端口 |
| 输出端口 | 子图的 `output` 节点对应父节点上的输出端口 |
| 配置覆盖 | 父节点上的 `config` 可以覆盖子图内部节点的默认配置 |
| 状态隔离 | 子图执行期间的状态变化不会泄露到父工作流的 data 中 |

### 5.5 子图的复用

- 子图可以定义为独立文件（`.agent/workflows/sub-*.json`），被多个父工作流引用
- 修改子图文件 → 所有引用此子图的工作流在下次执行时自动使用新版本
- 内置工作流（TODO/Plan/Spec）也可以作为子图被引用

### 5.6 UI 交互

| 操作 | 行为 |
|------|------|
| 双击复合节点 | 画布切换到子图内部视图 |
| 面包屑点击 | 回溯到上级画布（主画布 > 子图A > 子图A-1） |
| 复合节点外观 | 虚线边框 + 左下角子图缩略图标（📦） |
| 保存子图 | 子图以独立文件保存，或以内联 JSON 嵌入父图 |
| 拖动节点进复合节点 | 自动将拖入的节点添加到子图中 |

---

## 六、通用约束工作流模板

### 6.1 约束工作流的公共结构

TODO、Plan、Spec、CodeReview 共享同一套骨架：

```
任何约束工作流 =
  阶段列表（1~N 个阶段，按序执行）
  + 每阶段的注入内容（prompt + 数据，阶段切换时变化）
  + 步骤推进规则（done/blocked/add/complete 的语义定义）
  + 阶段切换条件（当前阶段完成 → 进入下一阶段）
  + 全局完成条件（所有阶段完成 → deactivate）
```

### 6.2 阶段定义

| 属性 | 说明 | 示例 |
|------|------|------|
| 阶段名 | 唯一标识 | `analyze`, `execute`, `spec`, `tasks` |
| 引导提示词 | 注入 Zone 5 的内容 | "请分析用户需求并拆分为步骤" |
| 步骤模板 | 步骤的默认格式 | `[ ] 步骤描述` |
| 允许的 action | 模型可调用的 step action | analyze 阶段只允许 `complete` |
| 阶段切换条件 | 触发下一阶段 | `complete` action 或所有步骤 done |
| 注入策略 | 注入行为 | analyze 阶段只注入 persistent；execute 阶段注入 persistent + step |

### 6.3 JSON 格式定义

```json
{
  "name": "todo",
  "phases": [
    {
      "name": "analyze",
      "prompt": "请分析用户需求并拆分为步骤",
      "allowedActions": ["add", "complete"],
      "onComplete": { "transitionTo": "execute" }
    },
    {
      "name": "execute",
      "prompt": "请逐步执行以下任务",
      "allowedActions": ["done", "blocked", "add"],
      "onComplete": { "transitionTo": null }
    }
  ],
  "complete": {
    "condition": "all_done",
    "phase": "execute"
  }
}
```

### 6.4 内置工作流的阶段配置

| 工作流 | 阶段 | 切换条件 |
|--------|------|---------|
| TODO | analyze → execute | complete |
| Plan | analyze → execute | complete |
| Spec | spec → tasks → checklist | 逐阶段 complete |
| Bootstrap | 单阶段滚动 | 自动推进 |

---

## 七、TODO 节点

TODO 是工作流平台中的**一种基础节点类型**——它负责"接收一个目标，拆成步骤，逐步执行，全部完成"。

### 7.1 定位

```
应用工作流（漫剧 / 写小说 / 办公自动化）
  └── [TODO 节点] → 负责其中"智能拆分与执行"的部分
      接收输入 → 拆解 → 逐步执行 → 完成输出

TODO 本身也可以独立使用（不嵌入任何应用工作流）
```

### 7.2 TODO 执行流程

```
用户输入需求
    ↓
模型调用 TODO 工具（激活 TODO 模式）
    ↓
工具接收[用户需求] + [TODO 提示词规则] → 交给框架
    ↓
框架将输入替换为：[TODO规则] + [用户需求] → 注入 AgentLoop
    ↓
AgentLoop 按 TODO 规则将需求拆分为多步任务 → 写入内存任务列表
    ↓
框架注入第一个子任务 → AgentLoop 执行
    ↓
当前步骤完成 → 模型调用工具上报"步骤完成"
    ↓
框架收到上报 → 自动注入下一个子任务
    ↓
某步失败 → 重试多次 → 仍失败 → 终止 TODO → 给用户反馈
    ↓
全部完成 → 结束 TODO，返回结果
```

### 7.3 TODO 的 JSON 定义

```json
{
  "type": "todo",
  "config": {
    "splitPrompt": "请将用户需求拆分为可独立执行的步骤。每步应该是一个完整的操作。\n步骤格式：[ ] 步骤描述",
    "maxRetries": 3,
    "onFailure": "terminate"
  }
}
```

### 7.4 TODO 节点配置面板

用户在画布上选中 TODO 节点，右侧属性面板显示：

```
节点: TODO

拆分规则（提示词）
┌─────────────────────────────────┐
│ 请将用户需求拆分为可独立执行     │
│ 的步骤。每步应该是一个完整的     │
│ 操作。                          │
│                                 │
│ 步骤格式：[ ] 步骤描述          │
└─────────────────────────────────┘

重试次数: [3]
失败时: [终止并告知用户]
```

---

## 八、与现有系统的关系

```
现有系统                          本设计
══════════                      ════════
WorkflowDefinition 接口           → 不变（工作流 JSON 编译后仍是此接口）
WorkflowManager / Registry       → 不变
workflow 工具                    → 不变
Zone 5 Context Source            → 不变
loop.ts 中的集成                 → 不变
AgentLoop.runTurn()              → 不变

新增（后端）：
  src/workflow/types.ts          → 追加 JSON schema 类型定义
  src/workflow/loader.ts         → JSON 加载器（JSON → WorkflowDefinition）
  .agent/workflows/*.json        → 用户工作流配置文件

新增（前端）：
  webui/src/pages/Workspace/     → 可视化工作流编辑器
```

---

## 九、实施计划

### P1：后端基础设施

- 节点类型定义：`NodeDefinition` 接口 + 端口类型
- JSON schema 定义：工作流 JSON 的 TypeScript 类型
- JSON 加载器：`loader.ts`，解析 JSON → 构建 `WorkflowDefinition` 对象 → 注册到 `WorkflowRegistry`
- 内置工作流 JSON 文件：`src/workflow/builtin/todo.json`、`plan.json` 等
- **产出**：写一个 JSON 文件放到 `.agent/workflows/` 下，框架自动加载，模型可使用

### P2：WebUI 工作台

- 组件栏：列出所有可用节点类型，按类别分组，支持搜索
- 画布：拖放节点、连线、拖拽平移、缩放（推荐 React Flow）
- 配置面板：选中节点显示其 JSON Schema 表单
- 子图展开：双击复合节点进入子图画布 + 面包屑导航回溯 + 子图保存（内联/独立文件）
- 复合节点视觉：虚线边框标识 + 子图缩略预览
- 保存：序列化为 JSON → WebSocket 发送到后端 → 注册到 WorkflowRegistry
- **产出**：可视化编辑器可用，支持子图展开编辑

### P3：应用工作流建库

- 内置工作流模板完成：TODO、Plan、Spec、Bootstrap
- 节点类型完善：补充缺失的基础节点（path、hook 等）
- **产出**：用户拖一个 TODO 节点到画布，配置规则，保存即用

---

## 十、设计决策

| 项目 | 决策 |
|------|------|
| 配置格式 | **JSON**（不是 YAML）。WebUI 原生格式，LLM 生成稳定 |
| 工作流的消费方 | WebUI 和 LLM 写 JSON，人类只看画布上的节点图 |
| 工作流定义方式 | 存 JSON 文件 + 注册到 Registry，不需要编译不需要重启 |
| 系统层管道 | 不做。用户不需要改 Compose/Compress/LLM 的拓扑 |
| 运行时引擎 | 不做。复用现有 WorkflowDefinition + WorkflowManager |
| 子图嵌套 | **允许无限嵌套**。任何节点可以包含子图，子图中节点同样可以是复合节点。框架不做硬限制，UI 层面用画布缩放 + 面包屑导航管理复杂度 |
| 热加载 | WebUI 保存即注册到 WorkflowRegistry，不需要文件监听 |
| 画布库 | React Flow（成熟、开源、支持拖拽连线） |
| 节点面板 | 左侧组件栏 + 中间画布 + 右侧属性面板，三栏布局 |
| 输入/输出规范 | 每个工作流有且仅有一个 Input 节点和一个 Output 节点 |
| 输出接口 | WorkflowDefinition（现有接口，完全兼容） |

---

## 十一、安全注意事项

1. **节点配置的提示词注入**：用户在 TODO 的拆分规则中填入恶意指令 → 模型可能执行非预期行为。注入前加分隔标记。
2. **file 节点的路径限制**：`file.read/write` 限制在 `sessionDir` 和 `.agent/` 目录下，防止路径遍历。
3. **hook.call 的白名单**：只能调用注册过的 hook，不能指向任意脚本。
4. **图文件的来源校验**：从外部导入的 JSON 文件应做结构校验。
