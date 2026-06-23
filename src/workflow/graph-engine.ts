/**
 * Graph Workflow Engine — 图工作流执行引擎
 *
 * 将前端图形编辑器生成的 graph JSON 编译为 WorkflowDefinition 运行时对象，
 * 通过节点执行器（NodeExecutor）驱动图的遍历执行。
 *
 * 核心概念：
 *   - topologicalSort()  — 对节点按 edges 做拓扑排序（用于验证/分析）
 *   - compileGraphWorkflow() — 将 graph 编译为 WorkflowDefinition
 *
 * 执行模型：
 *   - 从 start 节点开始，沿 edges 遍历
 *   - 每个节点由对应的 NodeExecutor 执行，产生 prompt/persistent/output
 *   - waitForResponse 节点（agent/tool）暂停执行，等待下次 handleStep 推进
 *   - 非等待节点（start/note/prompt/context/branch）连续执行直到遇到等待节点或结束
 *
 * 状态序列化到 WorkflowState.data 中（Record<string, unknown>）。
 */

import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowStep,
  WorkflowStepAction,
  WorkflowStepResult,
} from './types.js';
import type {
  WorkflowGraph,
  WorkflowGraphNode,
} from './graph-types.js';
import type {
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executors/types.js';
import type { NodeExecutorRegistry } from './node-executors/registry.js';
import { defaultNodeExecutorRegistry } from './node-executors/registry.js';

// ─── 图执行上下文类型 ─────────────────────────────────────────────────

/**
 * 图执行上下文 — 序列化到 WorkflowState.data 中。
 *
 * 注意：outputs 在运行时是 Map，序列化到 state.data 时转为 Record<string, unknown>。
 */
export interface GraphExecutionContext {
  /** 当前节点 ID */
  currentNodeId: string;
  /** 节点输出表（nodeId → output），Map 序列化 */
  outputs: Record<string, unknown>;
  /** 已累积的提示词（注入 Zone 5 workflow_step） */
  prompts: string[];
  /** 已累积的持久化内容（注入 Zone 5 workflow_persistent） */
  persistentPrompts: string[];
  /** 是否已完成 */
  completed: boolean;
  /** 工作流任务描述 */
  task: string;
  /** 是否正在等待 LLM/工具响应 */
  waitingForResponse: boolean;
  /** 当前等待节点的提示词 */
  currentPrompt: string;
  /** 已访问的节点 ID 列表（用于进度展示） */
  visitedNodeIds: string[];
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────

/** 查找 start 节点（若无则取第一个节点） */
function findStartNode(graph: WorkflowGraph): WorkflowGraphNode | undefined {
  return graph.nodes.find(n => n.type === 'start') ?? graph.nodes[0];
}

/** 按 ID 查找节点 */
function getNode(graph: WorkflowGraph, nodeId: string): WorkflowGraphNode | undefined {
  return graph.nodes.find(n => n.id === nodeId);
}

/** 沿 edges 查找后继节点 ID（取第一条出边） */
function findNextNodeId(graph: WorkflowGraph, nodeId: string): string | undefined {
  const edge = graph.edges.find(e => e.source === nodeId);
  return edge?.target;
}

/** 渲染进度文本 */
function renderProgress(graph: WorkflowGraph, ctxData: GraphExecutionContext): string {
  const lines: string[] = [];
  if (ctxData.task) lines.push(`**Task:** ${ctxData.task}`);

  const visited = new Set(ctxData.visitedNodeIds);
  const total = graph.nodes.length;
  const doneCount = ctxData.visitedNodeIds.length;
  lines.push(`**Progress:** ${doneCount}/${total} nodes visited`);
  lines.push('');

  for (const node of graph.nodes) {
    if (node.type === 'note') continue; // 注释节点不显示在进度中
    const isVisited = visited.has(node.id);
    const isCurrent = node.id === ctxData.currentNodeId && ctxData.waitingForResponse;
    const mark = ctxData.completed && isVisited ? '[x]'
      : isCurrent ? '[~]'
      : isVisited ? '[x]'
      : '[ ]';
    lines.push(`${mark} ${node.data.label ?? node.id}`);
  }

  return lines.join('\n');
}

// ─── 核心执行循环 ─────────────────────────────────────────────────────

/**
 * 执行循环：从当前节点开始，连续执行直到遇到等待节点或完成。
 *
 * - 若 waitingForResponse 为 true，先推进到后继节点再执行
 * - 非等待节点连续执行（start/note/prompt/context/branch）
 * - 等待节点（agent/tool）设置 waitingForResponse 后返回
 * - end 节点或无后继节点标记完成
 *
 * @param graph 工作流图
 * @param ctxData 执行上下文（会被原地修改）
 * @param registry 节点执行器注册表
 * @param params 工作流参数
 */
function runUntilWaitingOrDone(
  graph: WorkflowGraph,
  ctxData: GraphExecutionContext,
  registry: NodeExecutorRegistry,
  params: Record<string, unknown>,
): void {
  let safetyCounter = 0;
  const maxIterations = graph.nodes.length * 2 + 100; // 安全限制，防止无限循环

  while (safetyCounter++ < maxIterations) {
    // 如果正在等待响应，先推进到后继节点
    if (ctxData.waitingForResponse) {
      ctxData.waitingForResponse = false;
      ctxData.currentPrompt = '';
      const nextId = findNextNodeId(graph, ctxData.currentNodeId);
      if (!nextId) {
        ctxData.completed = true;
        return;
      }
      ctxData.currentNodeId = nextId;
    }

    const node = getNode(graph, ctxData.currentNodeId);
    if (!node) {
      ctxData.completed = true;
      return;
    }

    // 获取执行器（未注册的类型视为 no-op）
    const executor = registry.get(node.type);

    // 构建执行上下文
    const outputsMap = new Map(Object.entries(ctxData.outputs));
    const execCtx: NodeExecutionContext = {
      node: { id: node.id, type: node.type, data: node.data },
      graph,
      outputs: outputsMap,
      prompts: ctxData.prompts,
      params,
    };

    // 执行节点（当前实现为同步；异步执行器需在上层适配）
    let result: NodeExecutionResult;
    if (executor) {
      const raw = executor.execute(execCtx);
      if (raw instanceof Promise) {
        // handleStep 是同步接口，不支持异步执行器
        // 将 Promise 视为 no-op 并记录警告
        result = { prompt: `[节点 ${node.id} 返回异步结果，当前引擎不支持]` };
      } else {
        result = raw;
      }
    } else {
      // 未注册的节点类型，视为 no-op
      result = {};
    }

    // 更新输出表
    if (result.output !== undefined) {
      ctxData.outputs[node.id] = result.output;
    }

    // 更新提示词
    if (result.prompt) {
      ctxData.prompts.push(result.prompt);
    }
    if (result.persistent) {
      ctxData.persistentPrompts.push(result.persistent);
    }

    // 记录已访问节点
    if (!ctxData.visitedNodeIds.includes(node.id)) {
      ctxData.visitedNodeIds.push(node.id);
    }

    // 处理执行结果
    if (result.done) {
      ctxData.completed = true;
      return;
    }

    if (result.waitForResponse) {
      ctxData.waitingForResponse = true;
      ctxData.currentPrompt = result.prompt ?? '';
      return;
    }

    // 推进到下一个节点
    let nextId: string | undefined;
    if (result.nextNodeId) {
      // branch 节点指定后继
      nextId = result.nextNodeId;
    } else {
      // 默认沿 edges 查找后继
      nextId = findNextNodeId(graph, node.id);
    }

    if (!nextId) {
      // 无后继节点，标记完成
      ctxData.completed = true;
      return;
    }

    ctxData.currentNodeId = nextId;
    // 继续循环执行下一个节点
  }

  // 安全限制：标记完成以防止无限循环
  ctxData.completed = true;
}

// ─── 拓扑排序 ─────────────────────────────────────────────────────────

/**
 * 对图节点按 edges 做拓扑排序（Kahn 算法）。
 *
 * 用于验证图的 DAG 结构和分析执行顺序。
 * 注意：图引擎实际执行是沿 edges 从 start 节点遍历，不依赖拓扑排序。
 *
 * @param graph 工作流图
 * @returns 拓扑排序后的节点 ID 数组（若存在环则返回部分排序）
 */
export function topologicalSort(graph: WorkflowGraph): string[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // 初始化
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }

  // 构建邻接表和入度
  for (const edge of graph.edges) {
    if (adjList.has(edge.source)) {
      adjList.get(edge.source)!.push(edge.target);
    }
    if (inDegree.has(edge.target)) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
  }

  // 入度为 0 的节点入队
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  // BFS 拓扑排序
  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const neighbor of adjList.get(id) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return result;
}

// ─── 图编译器 ─────────────────────────────────────────────────────────

/**
 * 将 graph JSON 编译为 WorkflowDefinition 运行时对象。
 *
 * @param graph 工作流图（前端图形编辑器生成的 JSON）
 * @param source 来源标记（默认 'file'）
 * @param executorRegistry 节点执行器注册表（默认使用 defaultNodeExecutorRegistry）
 * @returns WorkflowDefinition 运行时对象
 */
export function compileGraphWorkflow(
  graph: WorkflowGraph,
  source: 'builtin' | 'file' | 'plugin' | 'converted' = 'file',
  executorRegistry: NodeExecutorRegistry = defaultNodeExecutorRegistry,
): WorkflowDefinition {
  const name = graph.metadata?.name ?? 'graph-workflow';
  const description = graph.metadata?.description ?? 'Graph-based workflow';
  const version = graph.metadata?.version;

  // 验证图结构
  const startNode = findStartNode(graph);
  if (!startNode) {
    throw new Error(`Graph workflow "${name}" has no nodes`);
  }

  // 构建节点 ID → 节点 的映射（用于步骤展示）
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  /**
   * 从 WorkflowState.data 中提取图执行上下文。
   * 如果数据不完整（如旧状态恢复），补全缺失字段。
   */
  function extractCtxData(state: WorkflowState): GraphExecutionContext {
    const data = state.data as Record<string, unknown>;
    return {
      currentNodeId: (data.currentNodeId as string) ?? startNode!.id,
      outputs: (data.outputs as Record<string, unknown>) ?? {},
      prompts: (data.prompts as string[]) ?? [],
      persistentPrompts: (data.persistentPrompts as string[]) ?? [],
      completed: (data.completed as boolean) ?? false,
      task: (data.task as string) ?? '',
      waitingForResponse: (data.waitingForResponse as boolean) ?? false,
      currentPrompt: (data.currentPrompt as string) ?? '',
      visitedNodeIds: (data.visitedNodeIds as string[]) ?? [],
    };
  }

  /** 将图执行上下文写回 WorkflowState.data */
  function writeCtxData(state: WorkflowState, ctxData: GraphExecutionContext): WorkflowState {
    return {
      ...state,
      data: {
        ...state.data,
        currentNodeId: ctxData.currentNodeId,
        outputs: ctxData.outputs,
        prompts: ctxData.prompts,
        persistentPrompts: ctxData.persistentPrompts,
        completed: ctxData.completed,
        task: ctxData.task,
        waitingForResponse: ctxData.waitingForResponse,
        currentPrompt: ctxData.currentPrompt,
        visitedNodeIds: ctxData.visitedNodeIds,
      },
      steps: buildSteps(ctxData),
    };
  }

  /** 根据执行上下文构建步骤列表（用于进度展示） */
  function buildSteps(ctxData: GraphExecutionContext): WorkflowStep[] {
    const visited = new Set(ctxData.visitedNodeIds);
    const steps: WorkflowStep[] = [];
    let stepId = 0;

    for (const node of graph.nodes) {
      if (node.type === 'note' || node.type === 'start') continue;
      stepId++;
      const isVisited = visited.has(node.id);
      const isCurrent = node.id === ctxData.currentNodeId && ctxData.waitingForResponse;
      const status: WorkflowStep['status'] = ctxData.completed && isVisited
        ? 'completed'
        : isCurrent
        ? 'in_progress'
        : isVisited
        ? 'completed'
        : 'pending';
      steps.push({
        id: stepId,
        name: node.data.label ?? node.id,
        description: node.data.description ?? node.data.label ?? '',
        status,
      });
    }

    return steps;
  }

  /** 查找下一个待执行的步骤（用于 WorkflowStepResult.nextStep） */
  function findNextStep(ctxData: GraphExecutionContext): WorkflowStep | undefined {
    const steps = buildSteps(ctxData);
    return steps.find(s => s.status === 'pending' || s.status === 'in_progress');
  }

  // ── WorkflowDefinition 实现 ────────────────────────────────────────

  const def: WorkflowDefinition = {
    name,
    description: version ? `${description} (v${version})` : description,
    source,
    triggerKeywords: graph.metadata?.name ? [graph.metadata.name] : undefined,

    createState(params: Record<string, unknown>): WorkflowState {
      const task = (params.task as string) ?? '';
      const ctxData: GraphExecutionContext = {
        currentNodeId: startNode!.id,
        outputs: {},
        prompts: [],
        persistentPrompts: [],
        completed: false,
        task,
        waitingForResponse: false,
        currentPrompt: '',
        visitedNodeIds: [],
      };

      // 运行初始执行循环（到第一个等待节点或完成）
      runUntilWaitingOrDone(graph, ctxData, executorRegistry, params);

      const state: WorkflowState = {
        name,
        phase: 'graph',
        data: {},
        steps: [],
        startedAt: new Date().toISOString(),
      };

      return writeCtxData(state, ctxData);
    },

    handleStep(
      state: WorkflowState,
      action: WorkflowStepAction,
    ): { newState: WorkflowState; result: WorkflowStepResult } | null {
      const ctxData = extractCtxData(state);

      // 已完成的工作流不再处理
      if (ctxData.completed) {
        return null;
      }

      // note / progress：记录消息，不改变执行状态
      if (action.action === 'note' || action.action === 'progress') {
        if (action.message) {
          ctxData.prompts.push(action.message);
        }
        const newState = writeCtxData(state, ctxData);
        return {
          newState,
          result: {
            workflow: name,
            phase: 'graph',
            progress: renderProgress(graph, ctxData),
            allDone: ctxData.completed,
            nextStep: findNextStep(ctxData),
          },
        };
      }

      // add：不支持在图工作流中添加步骤（图结构固定）
      if (action.action === 'add') {
        return null;
      }

      // done / blocked / complete：推进执行
      // 对于图工作流，这些 action 都意味着"当前等待节点已完成，推进到下一个"
      if (action.action === 'done' || action.action === 'complete' || action.action === 'blocked') {
        // 如果不在等待状态，没有可推进的
        if (!ctxData.waitingForResponse) {
          return null;
        }

        // blocked 时记录原因
        if (action.action === 'blocked' && action.message) {
          ctxData.prompts.push(`[阻塞] ${action.message}`);
        }

        // 推进执行循环
        runUntilWaitingOrDone(graph, ctxData, executorRegistry, state.data as Record<string, unknown>);

        const newState = writeCtxData(state, ctxData);
        return {
          newState,
          result: {
            workflow: name,
            phase: 'graph',
            progress: renderProgress(graph, ctxData),
            allDone: ctxData.completed,
            nextStep: findNextStep(ctxData),
          },
        };
      }

      return null;
    },

    renderPersistent(state: WorkflowState): string {
      const ctxData = extractCtxData(state);
      const lines: string[] = [];

      // 持久化内容（context 节点产生的）
      if (ctxData.persistentPrompts.length > 0) {
        lines.push(ctxData.persistentPrompts.join('\n\n'));
      }

      // 进度信息
      lines.push(renderProgress(graph, ctxData));

      return lines.join('\n\n');
    },

    renderStep(state: WorkflowState): string {
      const ctxData = extractCtxData(state);

      // 已完成时返回空
      if (ctxData.completed) return '';

      // 等待响应时返回当前节点的提示词
      if (ctxData.waitingForResponse && ctxData.currentPrompt) {
        return ctxData.currentPrompt;
      }

      // 非等待状态返回空（执行循环会自动推进）
      return '';
    },

    renderForInjection(state: WorkflowState): string {
      // 回退：返回 persistent 内容
      const ctxData = extractCtxData(state);
      const lines: string[] = [];
      if (ctxData.persistentPrompts.length > 0) {
        lines.push(ctxData.persistentPrompts.join('\n\n'));
      }
      lines.push(renderProgress(graph, ctxData));
      return lines.join('\n\n');
    },

    isComplete(state: WorkflowState): boolean {
      const ctxData = extractCtxData(state);
      return ctxData.completed;
    },
  };

  return def;
}
