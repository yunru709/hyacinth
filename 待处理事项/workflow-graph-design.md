# DeepThink 工作流图引擎 — 框架设计

## 一、框架的边界

框架只做一件事：**提供一套"积木"和"搭积木的规则"，让工作流可以通过组合节点来定义**。

```
框架层（现在要做的）          应用层（未来，不需要改框架）
═══════════════════          ═══════════════════════════
                            Plan 工作流图（.yaml）
NodeType 类型注册表          Spec 工作流图（.yaml）
  ├─ 输入/输出端口签名       TODO 工作流图（.yaml）
  ├─ 配置 Schema            CodeReview 工作流图（.yaml）
  └─ execute 函数           用户自定义图（GUI 拖拽 → .yaml）
                              │
Graph IR 数据结构              │
  ├─ 节点 + 边 + 变量          │
  └─ 序列化 (YAML/JSON)        ▼
                            ┌──────────────────┐
Compiler（图→闭包）          │  所有工作流最终    │
  ├─ 拓扑排序                │  都是同一张图      │
  ├─ channel 路由            │  只是节点和连线    │
  └─ 类型检查                │  不同而已          │
                            └──────────────────┘
ExecutionContext
  ├─ loadPrompt
  ├─ 文件系统
  └─ 路径解析
```

框架不包含 Plan、Spec、TODO 的任何逻辑。它们只是 4 张预设图。

---

## 二、核心抽象

### 2.1 NodeType — 积木块的定义

一种节点类型 = 一个可复用的功能单元。框架提供 22 种内置类型，未来可通过插件扩展。

```typescript
interface NodeType {
  /** 全局唯一名，如 "file.read"、"steps.mark" */
  name: string;

  /** 人类可读描述，供 GUI 展示 */
  description: string;

  /** 分类（决定 GUI 面板中的位置） */
  category: 'state' | 'path' | 'file' | 'text' | 'steps' | 'control' | 'render' | 'hook';

  /** 输入端口签名 */
  inputs: Record<string, {
    type: PortType;
    required?: boolean;      // 默认 true
    description?: string;    // GUI tooltip
  }>;

  /** 输出端口签名 */
  outputs: Record<string, {
    type: PortType;
    description?: string;
  }>;

  /** 静态配置的 JSON Schema（GUI 据此生成配置表单） */
  configSchema?: JSONSchema;

  /**
   * 执行函数。
   * @param inputs  已解析的输入值（由框架根据连线求值后传入）
   * @param config  静态配置（YAML 中写死的值）
   * @param ctx     框架服务（loadPrompt、文件系统、日志等）
   * @returns       输出值（键名对应 outputs 定义）
   */
  execute: (
    inputs: Record<string, unknown>,
    config: Record<string, unknown>,
    ctx: ExecutionContext,
  ) => Record<string, unknown>;
}
```

**关键设计**：`execute` 是纯函数 + 框架服务。它不直接访问文件系统，而是通过 `ctx`。这样：
- 测试时可以注入 mock ctx
- GUI 可以预览节点的输出
- 未来可以沙箱化执行

### 2.2 ExecutionContext — 框架服务

```typescript
interface ExecutionContext {
  /** 加载提示词模板 */
  loadPrompt: (key: string) => string;

  /** 解析路径（处理 ~ 和相对路径） */
  resolvePath: (p: string) => string;

  /** 当前 session 目录 */
  sessionDir: string;

  /** 结构化日志 */
  logger: Logger;
}
```

所有副作用（文件读写、模板加载）都通过 ctx 进行。节点自身不 import fs。

### 2.3 GraphIR — 图的数据结构

```typescript
interface GraphIR {
  schema: string;                          // "2.0"
  name: string;
  description: string;
  triggerKeywords?: string[];
  relatedTools?: string[];

  /** 工作流级变量（创建 state 时求值一次） */
  vars: Record<string, VarDefinition>;

  /** 节点映射：id → NodeDef */
  nodes: Record<string, NodeDef>;

  /** 边列表 */
  edges: EdgeDef[];
}

interface NodeDef {
  /** 节点类型名（引用 NodeTypeRegistry 中已注册的类型） */
  type: string;

  /**
   * 输入绑定。键对应 NodeType.inputs。
   * 值可以是：
   *   - 字面量："hello"
   *   - 变量引用："{params.task}"
   *   - 节点引用："{read_file.content}"
   *   - 路径引用：["nodeId", "portName"]  （JSON 格式专用）
   */
  inputs?: Record<string, unknown>;

  /** 静态配置（键对应 NodeType.configSchema） */
  config?: Record<string, unknown>;

  /**
   * 执行通道标注。
   *   undefined  → createState 时执行
   *   "persistent" → renderPersistent 时执行
   *   "step"       → renderStep 时执行
   *   "handle"     → handleStep 时执行（仅 steps.mark 等）
   *   "complete"   → isComplete 时执行（仅 steps.all_done 等）
   */
  channel?: 'persistent' | 'step' | 'handle' | 'complete';
}

interface EdgeDef {
  from: { node: string; port: string };   // 源节点.输出端口
  to: { node: string; port: string };     // 目标节点.输入端口
}

interface VarDefinition {
  compute: 'literal' | 'slug' | 'path';
  from?: string;
  value?: string;
  segments?: string[];
  maxLen?: number;
  fallback?: string;
}
```

### 2.4 序列化格式

同一张图，两种表示，**等价转换**：

**YAML（人类手写）**：
```yaml
schema: "2.0"
name: plan
nodes:
  init:
    type: state.create
    config:
      staticVars:
        task: { compute: literal, from: "{params.task}" }
  check_file:
    type: file.exists
    inputs:
      path: "{planFile}"
edges:
  - { from: { node: init, port: state }, to: { node: check_file, port: state } }
```

**JSON（GUI 导出 / 程序生成）**：
```json
{
  "schema": "2.0",
  "name": "plan",
  "nodes": {
    "1": { "class_type": "state.create", "config": { "staticVars": { "task": { "compute": "literal", "from": "{params.task}" } } } },
    "2": { "class_type": "file.exists", "inputs": { "path": ["@", "planFile"] } }
  }
}
```

JSON 格式中的链接 `["nodeId", "portName"]` 与 ComfyUI 的 `["4", 0]` 完全一致。

---

## 三、编译器：图 → 可执行闭包

编译器是框架最核心的部分。它把一张通用图编译为 WorkflowDefinition 的五个闭包。

### 3.1 编译流程

```
GraphIR
   │
   ├─→ 1. Validator
   │       类型检查（端口类型匹配）
   │       去环检测（Kahn 算法）
   │       引用完整性（所有边引用的节点/端口存在）
   │
   ├─→ 2. Channel Router
   │       根据 node.channel 标注 + 类型默认规则
   │       将节点分配到五个执行通道之一
   │
   ├─→ 3. Topological Sort（按通道分别排序）
   │       initOrder:     创建 state 时执行的节点序列
   │       persistentOrder: renderPersistent 时执行的节点序列
   │       stepOrder:      renderStep 时执行的节点序列
   │       markNode:       handleStep 时执行的节点（单节点）
   │       doneNode:       isComplete 时执行的节点（单节点）
   │
   └─→ 4. Closure Generator
           为每个通道生成执行函数
```

### 3.2 Channel 路由规则

节点如何分配到五个通道？两层规则：

**第一层：显式标注（优先）**
```yaml
analyze_persistent:
  type: text.template
  channel: persistent     # ← 显式标注，最高优先级
```

**第二层：类型默认规则（无显式标注时）**

| 节点类型 | 默认 channel | 原因 |
|---------|-------------|------|
| `state.*`, `path.*` | init | 只在创建状态时执行 |
| `file.exists`, `file.write`, `file.mkdir` | init | 只在创建状态时执行 |
| `control.switch`, `control.guard` | init | 路由逻辑在创建时确定 |
| `hook.call` | init | 外部调用在特定时机 |
| `steps.mark` | handle | 始终由工具调用触发 |
| `steps.all_done` | complete | 始终用于完成检查 |
| `steps.current`, `steps.progress`, `steps.count` | step | 每步变化 |
| `step.create` | init | 仅创建时 |
| `text.parse_checkboxes` | persistent | 文件内容解析后缓存 |
| `text.render_checkboxes` | persistent | 进度展示 |
| `text.template` | persistent | 默认持久注入 |
| `file.read` | persistent | 文件内容默认持久注入 |
| `render.*` | persistent | 默认持久注入 |

**第三层：channel 可被覆盖**

如果一个 `file.read` 标注了 `channel: step`，它就在每步渲染时执行。这允许同样的节点类型在不同上下文中使用。

### 3.3 五个闭包的生成

```typescript
function compile(ir: GraphIR): WorkflowDefinition {
  // 1. 验证
  validate(ir);

  // 2. 路由
  const routing = channelRoute(ir);

  // 3. 拓扑排序
  const plan = {
    init: topsort(routing.init, ir.edges),
    persistent: topsort(routing.persistent, ir.edges),
    step: topsort(routing.step, ir.edges),
    markNode: routing.handle[0] ?? null,
    doneNode: routing.complete[0] ?? null,
  };

  // 4. 生成闭包
  return {
    name: ir.name,
    description: ir.description,
    source: 'file',
    triggerKeywords: ir.triggerKeywords,
    relatedTools: ir.relatedTools,

    createState(params) {
      const stateVars = resolveVars(ir.vars, params);
      const ctx = createContext({ params, vars: stateVars });
      return executeNodes(plan.init, ctx);
    },

    handleStep(state, action) {
      if (!plan.markNode) return null;
      const ctx = createContext({ state, action });
      return executeNode(plan.markNode, ctx);
    },

    renderPersistent(state) {
      const ctx = createContext({ state });
      const results = executeNodes(plan.persistent, ctx);
      return joinOutputs(results);
    },

    renderStep(state) {
      const ctx = createContext({ state });
      const results = executeNodes(plan.step, ctx);
      return joinOutputs(results);
    },

    isComplete(state) {
      if (!plan.doneNode) return false;
      const ctx = createContext({ state });
      return executeNode(plan.doneNode, ctx).done === true;
    },

    renderForInjection(state) {
      return this.renderPersistent?.(state) ?? '';
    },
  };
}
```

### 3.4 子图执行器

按拓扑序依次执行节点，每个节点的输出成为下游节点的输入：

```typescript
function executeNodes(
  order: string[],
  ctx: ExecutionContext,
): Record<string, Record<string, unknown>> {
  const outputs: Record<string, Record<string, unknown>> = {};

  for (const nodeId of order) {
    const node = ctx.graph.nodes[nodeId];
    const nodeType = ctx.registry.get(node.type);

    // 解析输入：字面量 / 变量引用 / 上游节点引用
    const inputs = resolveInputs(node.inputs, ctx.vars, outputs);

    // 执行
    try {
      outputs[nodeId] = nodeType.execute(inputs, node.config ?? {}, ctx);
    } catch (err) {
      ctx.logger.error(`Node "${nodeId}" (${node.type}) failed`, err);
      outputs[nodeId] = {}; // 不扩散，下游收到空值
    }

    // 特殊处理：如果输出包含 state，更新 ctx.state
    if (outputs[nodeId].state) {
      ctx.state = outputs[nodeId].state;
    }
  }

  return outputs;
}
```

---

## 四、如何扩展

框架的核心价值在于**不修改框架代码就能扩展**。

### 4.1 添加新节点类型（需要写代码，低频）

新节点类型通过插件或内置扩展注册：

```typescript
// 在插件中或 builtin nodes 中添加
nodeRegistry.register({
  name: 'http.fetch',
  description: '发送 HTTP 请求并返回响应',
  category: 'hook',
  inputs: {
    url: { type: 'string', required: true },
    method: { type: 'string', required: false },
    body: { type: 'string', required: false },
  },
  outputs: {
    status: { type: 'number' },
    body: { type: 'string' },
  },
  configSchema: {
    type: 'object',
    properties: {
      timeout: { type: 'number', default: 30000 },
      headers: { type: 'object' },
    },
  },
  execute(inputs, config, ctx) {
    // ... HTTP 请求逻辑
    return { status: 200, body: '...' };
  },
});
```

注册后，新节点类型立即可在 YAML 图和 GUI 中使用。

### 4.2 添加新工作流（不需要写代码，高频）

新工作流 = 一张新图。放在 `.agent/workflows/` 目录下即可热加载：

```yaml
# .agent/workflows/code-review.yaml
schema: "2.0"
name: code-review
description: 代码审查工作流
nodes:
  init:
    type: state.create
    config:
      staticVars:
        task: { compute: literal, from: "{params.task}" }
  # ... 组合现有节点类型
edges:
  # ... 连线
```

不需要写 TypeScript，不需要重启。这就是框架的目标。

### 4.3 GUI 拖拽建工作流（未来）

GUI 的操作直接映射到 GraphIR：

| GUI 操作 | IR 操作 |
|---------|---------|
| 从面板拖一个节点到画布 | `nodes[id] = { type, config: {} }` |
| 从一个端口拖线到另一个端口 | `edges.push({ from: {node, port}, to: {node, port} })` |
| 修改节点配置 | `nodes[id].config = { ... }` |
| 删除节点 | `delete nodes[id]` + 删相关边 |
| 保存 | 序列化为 JSON → 写入 `.agent/workflows/xxx.yaml` |

GUI 只是 GraphIR 的可视化编辑器。与 ComfyUI 的 workflow.json 完全一个概念。

---

## 五、节点类型目录（22 种）

### state 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `state.create` | params(json) | state | init | 创建初始 WorkflowState |
| `state.get` | state | value(json) | (推断) | 读取 state 字段 |
| `state.set` | state, value(json) | state | (推断) | 写入 state 字段 |

### path 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `path.join` | segments(json) | path(string) | init | 拼接路径段 |
| `path.slug` | text(string) | slug(string) | init | 生成 URL-safe slug |

### file 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `file.exists` | path(string) | exists(boolean) | init | 检查文件是否存在 |
| `file.read` | path(string) | content(string) | persistent | 读取文件内容 |
| `file.write` | path(string), content(string) | success(boolean) | init | 写入内容到文件 |
| `file.mkdir` | path(string) | success(boolean) | init | 创建目录 |

### text 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `text.parse_checkboxes` | content(string), format(string) | steps | persistent | 从文本解析 checkbox 步骤 |
| `text.render_checkboxes` | steps | content(string) | persistent | 将步骤渲染为 checkbox 文本 |
| `text.template` | template(string), vars(json) | output(string) | persistent | 渲染模板字符串 |

### steps 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `step.create` | id(number), name(string), description(string), status(string) | step | init | 创建一个步骤 |
| `steps.mark` | steps, action | steps, result | **handle** | 标记步骤 done/blocked/add/note/progress/complete |
| `steps.current` | steps | step, index(number), is_last(boolean) | step | 找到当前步骤 |
| `steps.progress` | steps, title(string) | summary(string) | step | 生成进度摘要 |
| `steps.all_done` | steps | done(boolean) | **complete** | 检查全部完成 |
| `steps.count` | steps | total, completed, pending, blocked, in_progress (全 number) | step | 统计各状态数量 |

### control 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `control.switch` | value(any), state | state, branch(string) | init | 多路分支路由 |
| `control.guard` | state, action | allowed(boolean), state | init | 阶段守卫（白名单/黑名单） |

### render 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `render.section` | title(string), content(string) | output(string) | persistent | 生成带标题的内容段 |
| `render.compose` | sections(json) | output(string) | persistent | 组合多个段 |

### hook 家族

| 节点 | 输入 | 输出 | 默认 channel | 用途 |
|------|------|------|-------------|------|
| `hook.call` | state, args(json) | success(boolean), message(string), state | init | 调用外部函数 |

---

## 六、节点间数据流（关键机制）

### 6.1 输入解析

节点的 `inputs` 中的值在运行时被解析：

```
inputs:
  path: "{planFile}"              → 从工作流变量取值
  content: "{read_plan.content}"  → 从上游节点 read_plan 的 content 输出端口取值
  state: "{init.state}"           → 从上游节点 init 的 state 输出端口取值
  action: "{user.action}"         → 特殊变量：handleStep 时传入的 action
  template: "@prompt:modes/plan"  → 特殊语法：调用 ctx.loadPrompt("modes/plan")
```

### 6.2 state 的传递

`state` 是贯穿整张图的"主线"。大多数节点接收 state 并返回 state：

```
init(state) → check_file(state) → router(state) → ...
```

这看起来像是一个 state 不断穿越节点，但实际上编译器会优化：连续传递 state 的节点链共享同一个 state 引用（不可变更新）。

### 6.3 变量作用域

```
工作流级 vars:   所有节点可见，创建时求值一次
节点输入:        仅该节点可见，每次执行时求值
user.*:          特殊变量，由框架注入
  user.action    当前步骤操作（handleStep 时）
  params.task    外部传入的任务描述
@prompt:key      加载提示词模板
```

---

## 七、与现有系统的集成

### 7.1 不变的部分

```
WorkflowDefinition 接口    ← 不变
WorkflowManager            ← 不变
WorkflowRegistry           ← 不变
workflow 工具              ← 不变
loop.ts 中的集成           ← 不变
Zone 5 context source      ← 不变（workflow-persistent / workflow-step）
```

### 7.2 变化的部分

```
旧：registry.registerBuiltin(createPlanWorkflow())    ← 删除，不再有 TS 硬编码的工作流
新：registry.register(compile(parse(yamlText)))       ← 所有工作流从图编译

旧：内置工作流在 src/workflow/builtin/*.workflow.ts   ← 全部删除（已清理）
新：内置预设图在 src/workflow/builtin/*.graph.yaml    ← Plan/Spec/TODO/Bootstrap 作为默认图
```

### 7.3 加载流程

```
启动
  ├─→ 扫描 builtin/*.graph.yaml → 编译 → 注册（内置预设）
  ├─→ 扫描 .agent/workflows/*.yaml → 编译 → 注册（用户自定义）
  └─→ 热加载 watcher 监听 .agent/workflows/
       └─→ 文件变更 → 重编译 → 覆盖注册
```

### 7.4 模块结构

```
src/workflow/
  # 现有（不变）
  types.ts              # 接口定义
  registry.ts           # WorkflowRegistry
  manager.ts            # WorkflowManager
  workflow-tool.ts      # 统一工具
  converter.ts          # Skill→Workflow 转换
  index.ts

  # 新增：图引擎框架
  graph/
    types.ts            # GraphIR, NodeDef, EdgeDef, PortType, NodeType
    node-registry.ts    # NodeTypeRegistry（注册/查询节点类型）
    parser.ts           # YAML/JSON → GraphIR
    validator.ts        # 类型检查 + 去环 + 引用完整性
    compiler.ts         # GraphIR → WorkflowDefinition（五个闭包）
    executor.ts         # 子图执行器（拓扑序执行 + 输入解析）

  # 新增：22 种内置节点类型
  nodes/
    state-nodes.ts      # state.create / state.get / state.set
    path-nodes.ts       # path.join / path.slug
    file-nodes.ts       # file.exists / file.read / file.write / file.mkdir
    text-nodes.ts       # text.parse_checkboxes / text.render_checkboxes / text.template
    step-nodes.ts       # step.create / steps.mark / steps.current / steps.progress / steps.all_done / steps.count
    control-nodes.ts    # control.switch / control.guard
    render-nodes.ts     # render.section / render.compose
    hook-nodes.ts       # hook.call
    index.ts            # registerAllNodeTypes(registry)

  # 新增：内置预设图
  builtin/
    plan.graph.yaml
    spec.graph.yaml
    todo.graph.yaml
    bootstrap.graph.yaml

  # 热加载
  graph-watcher.ts      # 监听 .agent/workflows/*.yaml
```

---

## 八、实施计划

| 阶段 | 内容 | 估时 | 产出 |
|------|------|------|------|
| **P1** 基础设施 | types.ts、node-registry.ts、ExecutionContext | 小 | 类型系统就绪 |
| **P2** 节点实现 | 22 种内置节点类型的 execute 函数 | 中 | 所有积木块可用 |
| **P3** 解析+验证 | parser.ts（YAML→IR）、validator.ts | 中 | 图可以解析和验证 |
| **P4** 编译器 | compiler.ts + executor.ts（图→闭包） | 大 | 核心：图变成可运行的 WorkflowDefinition |
| **P5** 预设图 | 4 张 .graph.yaml + 行为等价测试 | 中 | Plan/Spec/TODO/Bootstrap 作为图回归 |
| **P6** 热加载 | graph-watcher.ts + 集成到 HotReloadManager | 小 | 改 YAML 即时生效 |
| **P7** (后续) | GUI 画布编辑器 | 大 | 拖拽节点 + 连线 → 导出 YAML |

---

## 九、设计要点总结

1. **框架不包含任何具体工作流逻辑**。Plan/Spec/TODO/Bootstrap 只是预设图，和用户自定义图地位完全相同。

2. **新增工作流 = 新增一张图**。不需要写代码，不需要重启。`.agent/workflows/xxx.yaml` 放下即用。

3. **节点类型是框架唯一的扩展点**。新增一种节点类型需要写代码（注册 NodeType），但这是低频操作。22 种内置类型已覆盖当前所有场景。

4. **图 ↔ 闭包是编译时确定的**。运行时没有图遍历开销，只是执行预编译的闭包。

5. **GraphIR 就是 GUI 的数据模型**。GUI 不需要理解 WorkflowDefinition、Zone 5、channel——它只需要理解节点、端口、连线。

6. **ComfyUI 对齐**：节点有 class_type + inputs、连线是 `[nodeId, portIndex]`、图序列化为 JSON。差异仅在于我们多了 YAML 格式和 channel 标注。
