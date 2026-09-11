import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../tools/interface.js';
import type { AgentDefinition, AgentResult } from '../types.js';
import type { AgentRegistry } from './registry.js';
import { AgentLoop, type OutputHandler } from '../orchestrator/loop.js';
import { LayeredContextComposer } from '../context/composer.js';
import { CompressorOrchestrator, StructuredSummarizer } from '../context/compressor.js';
import { TokenCounter } from '../context/tokenizer.js';
import { FilteredToolRegistry } from '../tools/filtered-registry.js';
import { createSandboxedTool } from '../tools/path-sandbox.js';
import { ToolExecutor } from '../tools/executor.js';
import { ConversationStore } from '../memory/conversation.js';
import { EventStore } from '../memory/events.js';
import { StatsManager } from '../memory/stats.js';
import { SummaryStore } from '../memory/summary.js';
import { LLMOrchestrator } from '../orchestrator/planner.js';
import { PlanStore } from '../orchestrator/plan-store.js';
import { ModelRouter } from '../provider/model-router.js';
import type { Provider } from '../provider/interface.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';
import { subAgentUserId } from '../provider/user-id.js';

/** 子 Agent 进度事件 */
export interface ProgressEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'turn' | 'status';
  message: string;
  timestamp: number;
}

/** 上下文传递给子 Agent 的参数 */
export interface SubAgentContext {
  modelRouter: ModelRouter;
  toolRegistry: ToolRegistry;
  sessionDir: string;
  maxContextTokens: number;
  dependencyAnalyzer?: DependencyAnalyzer;
  /** 子 Agent 执行进度回调 */
  onProgress?: (event: ProgressEvent) => void;
  /** 文件访问沙箱根目录（设置后子 Agent 的 read/write/edit/grep/glob 被限制在此目录下，bash 被禁用） */
  sandboxRoot?: string;
  /** 创建带独立 userId 的 Provider（子Agent 之间 + 与主Agent 的 KVCache 隔离） */
  createSubProvider(userId: string): Provider;
  /** 异步子Agent 结果推送队列（主 loop 的 pendingAsyncResults，完成后自动注入对话） */
  pendingAsyncResults?: Array<{ handle: string; agentName: string; status: 'completed' | 'failed'; result?: string; error?: string }>;
}

// ── 运行中子 Agent Loop 管理器（模块级，避免循环依赖） ──────────

const runningLoops = new Map<string, AgentLoop>();

/** 注册正在运行的子 Agent loop */
export function registerRunningLoop(instanceId: string, loop: AgentLoop): void {
  runningLoops.set(instanceId, loop);
}

/** 注销已完成的子 Agent loop */
export function unregisterRunningLoop(instanceId: string): void {
  runningLoops.delete(instanceId);
}

/** 中断指定子 Agent */
export function interruptSubAgentLoop(instanceId: string): boolean {
  const loop = runningLoops.get(instanceId);
  if (!loop) return false;
  loop.interrupt();
  return true;
}

// ── 异步子 Agent 任务注册表 ─────────────────────────────────

export interface AsyncSubAgentTask {
  handle: string;
  agentName: string;
  instanceId: string;
  task: string;
  status: 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  result?: string;
  error?: string;
}

const asyncTasks = new Map<string, AsyncSubAgentTask>();
let asyncTaskCounter = 0;

/** 注册异步子 Agent 任务，返回 handle */
export function registerAsyncTask(agentName: string, instanceId: string, task: string): string {
  const handle = `sub_${String(++asyncTaskCounter).padStart(3, '0')}`;
  asyncTasks.set(handle, {
    handle,
    agentName,
    instanceId,
    task,
    status: 'running',
    startTime: new Date().toISOString(),
  });
  return handle;
}

/** 标记异步任务为已完成 */
export function completeAsyncTask(handle: string, result: string): void {
  const t = asyncTasks.get(handle);
  if (t) {
    t.status = 'completed';
    t.endTime = new Date().toISOString();
    t.result = result;
  }
}

/** 标记异步任务为失败 */
export function failAsyncTask(handle: string, error: string): void {
  const t = asyncTasks.get(handle);
  if (t) {
    t.status = 'failed';
    t.endTime = new Date().toISOString();
    t.error = error;
  }
}

/** 获取所有异步任务列表 */
export function listAsyncTasks(): AsyncSubAgentTask[] {
  return [...asyncTasks.values()];
}

/** 按 handle 获取异步任务 */
export function getAsyncTask(handle: string): AsyncSubAgentTask | undefined {
  return asyncTasks.get(handle);
}

/** 等待所有运行中的异步子 Agent 任务完成（用于优雅关闭） */
export async function waitForAsyncTasks(timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = listAsyncTasks().filter(t => t.status === 'running');
    if (running.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** 销毁子 Agent session 目录（清理 conversation/events/stats/meta） */
export async function destroySubAgentSession(
  parentSessionDir: string,
  instanceId: string,
): Promise<boolean> {
  const subDir = path.join(parentSessionDir, 'sub-agents', instanceId);
  try {
    await fs.rm(subDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 子 Agent session 目录的 meta 文件，记录创建时间等信息 */
interface SubSessionMeta {
  createdAt: number;
  agentName: string;
  instanceId: string;
  /** 首次落定的 system prompt（物化即冻结；复用直接读回，保证前缀恒定以利 KV 缓存命中） */
  resolvedSystemPrompt?: string;
}

/**
 * 解析子 Agent 的 system prompt：
 *  - override 仅首次委派传入，复用阶段忽略（system prompt 一经物化即冻结）；
 *  - {{task}} 占位符解析为固定指引——任务一律通过 user 消息传递，不再烧进
 *    system prompt，避免每次委派重写前缀导致 KV 前缀缓存断裂。
 */
function resolveSubAgentSystemPrompt(agentDef: AgentDefinition, override?: string): string {
  let systemPrompt = override ?? agentDef.systemPrompt;
  if (systemPrompt.includes('{{task}}')) {
    systemPrompt = systemPrompt.replace(/\{\{task\}\}/g, '当前任务以最新一条用户消息为准');
  }
  return systemPrompt;
}

/**
 * 创建（或复用）子 Agent 的 AgentLoop 实例。
 *
 * session 按 instanceId 固定目录，多次 delegate 复用同一 session，
 * 子 Agent 保留完整对话历史，无需每次重新交代背景。
 *
 * TTL 机制：若距离上次调用超过 sessionTtlMinutes（默认 10 分钟），
 * 自动清理旧 session 并重建。
 */
export async function createSubAgentLoop(
  agentDef: AgentDefinition,
  task: string,
  parentContext: SubAgentContext,
  opts?: { systemPromptOverride?: string },
): Promise<{ loop: AgentLoop; sessionDir: string; isNew: boolean }> {
  const instanceId = agentDef.instanceId ?? `${agentDef.name}-default`;
  const subSessionDir = path.join(parentContext.sessionDir, 'sub-agents', instanceId);
  const ttlMinutes = agentDef.sessionTtlMinutes ?? 10;

  // 并发保护：同一 instanceId 已有活跃 loop 时拒绝，防止会话文件并发写入冲突
  if (runningLoops.has(instanceId)) {
    throw new Error(
      `子 Agent "${agentDef.name}" (${instanceId}) 正在执行中，不能同时委派第二个任务。` +
      '等待当前任务完成后重试，或使用 spawn_sub_agent 创建独立实例来并行执行。'
    );
  }

  // TTL 检查：过期则清理重建
  let isNew = false;
  let resolvedSystemPrompt: string | undefined;
  try {
    const metaRaw = await fs.readFile(path.join(subSessionDir, 'meta.json'), 'utf-8');
    const meta: SubSessionMeta = JSON.parse(metaRaw);
    const elapsed = (Date.now() - meta.createdAt) / 60_000;
    if (elapsed > ttlMinutes) {
      await fs.rm(subSessionDir, { recursive: true });
      isNew = true;
    } else {
      resolvedSystemPrompt = meta.resolvedSystemPrompt;
    }
  } catch {
    isNew = true; // 目录不存在或 meta 损坏
  }

  if (isNew) {
    await fs.mkdir(subSessionDir, { recursive: true });
    // 首次落定 system prompt（override 优先），冻结进 meta.json 供复用读回
    resolvedSystemPrompt = resolveSubAgentSystemPrompt(agentDef, opts?.systemPromptOverride);
    await fs.writeFile(path.join(subSessionDir, 'meta.json'), JSON.stringify({
      createdAt: Date.now(), agentName: agentDef.name, instanceId, resolvedSystemPrompt,
    } satisfies SubSessionMeta), 'utf-8');
  } else if (!resolvedSystemPrompt) {
    // 旧会话（改版前创建）无 resolvedSystemPrompt：兜底解析（复用阶段忽略 override）
    resolvedSystemPrompt = resolveSubAgentSystemPrompt(agentDef);
  }

  // 仅在首次创建时写入空文件（复用时不覆盖已有数据）
  if (isNew) {
    await fs.writeFile(path.join(subSessionDir, 'conversation.jsonl'), '', 'utf-8');
    await fs.writeFile(path.join(subSessionDir, 'events.jsonl'), '', 'utf-8');
    await fs.writeFile(path.join(subSessionDir, 'stats.json'), '{}', 'utf-8');
  }

  // 2. 创建 FilteredToolRegistry
  const filteredRegistry = new FilteredToolRegistry(parentContext.toolRegistry, agentDef.allowedTools);

  // 2.5 路径沙箱包装（若设置了 sandboxRoot）
  if (parentContext.sandboxRoot) {
    for (const tool of filteredRegistry.getAll()) {
      const wrapped = createSandboxedTool(tool, parentContext.sandboxRoot);
      filteredRegistry.register(wrapped);
    }
  }

  // 3. 创建独立的 LayeredContextComposer，注入子 Agent 的 systemPrompt
  const subComposer = new LayeredContextComposer(parentContext.maxContextTokens);
  // 使用 registerPromptSection 注册子 Agent 的 system prompt 作为持久化 section
  // 这样每次 compose() 调用时都会自动注册，不会被 builder 重置清除
  // system prompt 已在上方按「首次落定、复用冻结」解析（{{task}} → 固定指引，任务走 user 消息）
  let systemPrompt = resolvedSystemPrompt;

  // 结构化输出：追加 JSON 格式指令
  if (agentDef.outputFormat === 'json') {
    const schemaStr = agentDef.outputSchema
      ? `\n\nCRITICAL OUTPUT FORMAT: Your final response MUST be valid JSON conforming to this schema:\n${JSON.stringify(agentDef.outputSchema, null, 2)}`
      : '\n\nCRITICAL OUTPUT FORMAT: Your final response MUST be valid JSON.';
    systemPrompt += schemaStr;
  }

  subComposer.registerPromptSection({
    name: 'sub-agent-role',
    priority: 0,
    content: systemPrompt,
  });

  // 4. 创建独立的存储
  const conversationStore = new ConversationStore();
  const eventStore = new EventStore();
  const statsManager = new StatsManager();
  const summaryStore = new SummaryStore();

  // 初始化 stats
  await statsManager.init(subSessionDir);

  // 5. 创建 ToolExecutor
  const toolExecutor = new ToolExecutor(filteredRegistry);

  // 6. 创建子 Agent 的独立 Provider（唯一 userId，与主Agent 和其他子Agent 缓存隔离）
  const subProvider = parentContext.createSubProvider(subAgentUserId(agentDef.name, instanceId));

  // 7. 创建 Compressor（复用主 Agent 的 ModelRouter 做压缩路由）
  const tokenCounter = new TokenCounter();
  const subModelRouter = new ModelRouter(subProvider);
  const summarizer = new StructuredSummarizer(subModelRouter);
  const compressor = new CompressorOrchestrator(tokenCounter, summarizer, parentContext.maxContextTokens);

  // 8. 创建 LLMOrchestrator
  const planStore = new PlanStore();
  const orchestrator = new LLMOrchestrator(subProvider, planStore, subSessionDir, subModelRouter);

  // 8. 创建 OutputHandler（有 onProgress 则报告进度，否则静默）
  const emit = parentContext.onProgress;
  const silentHandler: OutputHandler = {
    onText(text) { emit?.({ type: 'text', message: text, timestamp: Date.now() }); },
    onThinking() {},
    onToolUse(name, inputSummary) {
      emit?.({ type: 'tool_call', message: `${name}(${inputSummary})`, timestamp: Date.now() });
    },
    onToolResult(name) {
      emit?.({ type: 'tool_result', message: `${name} completed`, timestamp: Date.now() });
    },
    onStatus(msg) { emit?.({ type: 'status', message: msg, timestamp: Date.now() }); },
    onTurnStart() {},
    onFlush() {},
    onInterrupt() {},
    onPermissionRequest: async () => 'yes', // 子 Agent 自动批准权限请求
  };

  // 9. 创建 AgentLoop（P6-2：服务表 + 配置两层）
  const loop = new AgentLoop({
    provider: subProvider,
    contextComposer: subComposer,
    compressor,
    orchestrator,
    toolExecutor,
    toolRegistry: filteredRegistry,
    conversationStore,
    eventStore,
    statsManager,
    summaryStore,
    outputHandler: silentHandler,
    // skillRegistry / mcpBridge — 子 Agent 不使用 Skill / MCP
    dependencyAnalyzer: parentContext.dependencyAnalyzer,
  }, {
    sessionDir: subSessionDir,
    maxTurns: agentDef.maxTurns,
    maxContextTokens: parentContext.maxContextTokens,
  });

  return { loop, sessionDir: subSessionDir, isNew };
}

/**
 * DelegateToAgentTool — 主 Agent 通过此工具委托任务给子 Agent
 */
export class DelegateToAgentTool implements Tool {
  name = 'delegate_to_agent';
  description =
    '将任务委派给子 Agent 执行。子 Agent 是拥有独立上下文、工具集和 Provider 的隔离工作单元，执行完毕后返回结构化结果。' +
    '编排场景：当你有一个复杂计划时，自己负责规划和决策，将其中可并行的子任务分别委派给多个子 Agent 同步执行——spawn_sub_agent 可克隆多份实例，配合不同的 instance_id 并发调度，大幅缩短总耗时。' +
    '会话复用：子 Agent 会话在 TTL 窗口内持久化（默认 10 分钟），相同 instance_id 再次委派时自动恢复完整对话记忆，无需重新交代背景。system prompt 首次委派时落定并冻结（可用 system_prompt 参数临时定制），复用阶段不再变更；新任务追加为新的用户消息——前缀恒定，利于 KV 缓存命中。' +
    '异步执行：设置 async=true 后子 Agent 在后台运行，主 Agent 立即获得任务句柄（如 sub_001）并可继续其他工作。之后用 list_sub_agent_tasks 查看所有异步任务状态，get_sub_agent_result <handle> 获取已完成任务的结果。默认 async=false（同步阻塞，等待结果返回）。' +
    '使用 list_sub_agents 查看可用 Agent 及其实例 ID，create_sub_agent 创建新 Agent，spawn_sub_agent 克隆以支持并行，destroy_sub_agent 清理不再需要的实例。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      agent_name: {
        type: 'string' as const,
        description: '要委派的子 Agent 名称（如 "code-reviewer"）。同一名称下有多个实例时选中第一个。用 instance_id 精确指定。',
      },
      instance_id: {
        type: 'string' as const,
        description: '可选，指定子 Agent 实例的唯一 ID（用于定位克隆体）。优先级高于 agent_name。',
      },
      task: {
        type: 'string' as const,
        description: '委派给子 Agent 的任务描述，清晰说明要做什么和期望的输出。作为用户消息进入子 Agent 上下文。',
      },
      context: {
        type: 'string' as const,
        description: '可选的附加上下文（如相关代码片段、文件路径、背景信息）。',
      },
      system_prompt: {
        type: 'string' as const,
        description: '可选，仅首次委派生效：自定义该子 Agent 的系统提示词，落定后冻结（复用沿用首次定稿，保证前缀恒定以利 KV 缓存命中）。缺省用子 Agent 定义中的 systemPrompt（{{task}} 解析为固定指引）。',
      },
      async: {
        type: 'boolean' as const,
        description: '是否异步执行。默认 false（阻塞等待结果）。设为 true 时立即返回任务句柄（如 sub_001），子 Agent 在后台执行，主 Agent 可继续其他工具调用。',
      },
      across_turns: {
        type: 'boolean' as const,
        description: '异步结果是否允许跨 turn。默认 false——子Agent完成后结果在当前 turn 内自动注入对话，LLM 立即看到并继续处理。设为 true 时结果不自动注入，需手动用 get_sub_agent_result 获取（适用于需要跨多轮对话的后台任务）。仅在 async=true 时生效。',
      },
    },
    required: ['task'],
  };

  private agentRegistry: AgentRegistry;
  private parentContext: SubAgentContext;

  constructor(agentRegistry: AgentRegistry, parentContext: SubAgentContext) {
    this.agentRegistry = agentRegistry;
    this.parentContext = parentContext;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const instanceId = args.instance_id as string | undefined;
    const agentName = args.agent_name as string | undefined;
    const task = args.task as string;
    const context = args.context as string | undefined;
    const systemPromptOverride = args.system_prompt as string | undefined;
    const runAsync = args.async === true;
    const acrossTurns = args.across_turns === true;

    if (!agentName && !instanceId) {
      return 'Error: either agent_name or instance_id is required. Use list_sub_agents to see available agents and their instance IDs.';
    }

    // 查找子 Agent 定义（优先 instanceId）
    let agentDef: AgentDefinition | undefined;
    if (instanceId) {
      agentDef = this.agentRegistry.getByInstanceId(instanceId);
      if (!agentDef) {
        return `Error: Sub-agent instance "${instanceId}" not found. Use list_sub_agents to see available instances.`;
      }
    } else if (agentName) {
      const instances = this.agentRegistry.get(agentName);
      if (instances.length === 0) {
        const available = this.agentRegistry.getAll().map(a => a.name + (this.agentRegistry.get(a.name).length > 1 ? ` (id: ${a.instanceId})` : '')).join(', ');
        return `Error: Sub-agent "${agentName}" not found or all instances disabled. Available agents: ${available}`;
      }
      agentDef = instances[0]; // 取第一个可用实例
    }

    if (!agentDef) {
      return 'Error: no sub-agent found matching the provided criteria.';
    }

    // 构造完整任务描述
    const fullTask = context ? `${task}\n\nAdditional Context:\n${context}` : task;

    try {
      if (runAsync) {
        return await this.executeAsync(agentDef, fullTask, acrossTurns, systemPromptOverride);
      }

      return await this.executeDelegate(agentDef, fullTask, systemPromptOverride);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Sub-agent delegation failed: ${message}`;
    }
  }

  /**
   * 异步委托：在后台启动子 Agent，立即返回任务句柄。
   * 子 Agent 的 loop.run() 在后台 Promise 中执行，完成后结果写入 AsyncSubAgentTask。
   */
  private async executeAsync(agentDef: AgentDefinition, task: string, acrossTurns: boolean, systemPromptOverride?: string): Promise<string> {
    const instanceId = agentDef.instanceId!;
    const handle = registerAsyncTask(agentDef.name, instanceId, task);

    // 在后台启动子 Agent，不阻塞。catch 兜底防止未处理的 Promise rejection
    this.runAsyncInBackground(handle, agentDef, task, acrossTurns, systemPromptOverride).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      failAsyncTask(handle, message);
      if (!acrossTurns) {
        this.parentContext.pendingAsyncResults?.push({ handle, agentName: agentDef.name, status: 'failed', error: message });
      }
    });

    const hint = acrossTurns
      ? `跨 turn 模式——任务完成后需手动用 get_sub_agent_result ${handle} 获取结果。`
      : '回合内模式——子Agent完成后结果将自动注入当前对话。';
    return `异步子 Agent 任务已启动。\n句柄: ${handle}\nAgent: ${agentDef.name} (${instanceId})\n${hint}\n任务: ${task.slice(0, 100)}${task.length > 100 ? '...' : ''}`;
  }

  /** 后台执行子 Agent 任务 */
  private async runAsyncInBackground(handle: string, agentDef: AgentDefinition, task: string, acrossTurns: boolean, systemPromptOverride?: string): Promise<void> {
    const instanceId = agentDef.instanceId!;
    try {
      const { loop, sessionDir, isNew } = await createSubAgentLoop(agentDef, task, this.parentContext, { systemPromptOverride });
      registerRunningLoop(instanceId, loop);
      if (!isNew) {
        await fs.utimes(path.join(sessionDir, 'meta.json'), new Date(), new Date()).catch(() => {});
      }
      await loop.run(task);
      unregisterRunningLoop(instanceId);
      const result = await this.collectResult(agentDef, task);
      completeAsyncTask(handle, result);
      if (!acrossTurns) {
        // 回合内模式：推送到主 loop 队列，当前 turn 自动注入结果
        this.parentContext.pendingAsyncResults?.push({ handle, agentName: agentDef.name, status: 'completed', result });
      }
    } catch (error: unknown) {
      unregisterRunningLoop(instanceId);
      const message = error instanceof Error ? error.message : String(error);
      failAsyncTask(handle, message);
      if (!acrossTurns) {
        this.parentContext.pendingAsyncResults?.push({ handle, agentName: agentDef.name, status: 'failed', error: message });
      }
    }
  }

  /**
   * 委托模式：单个子 Agent 执行任务（同步阻塞）
   */
  private async executeDelegate(agentDef: AgentDefinition, task: string, systemPromptOverride?: string): Promise<string> {
    const instanceId = agentDef.instanceId!;
    const { loop, sessionDir, isNew } = await createSubAgentLoop(agentDef, task, this.parentContext, { systemPromptOverride });
    registerRunningLoop(instanceId, loop);
    try {
      if (!isNew) {
        // 复用 session 时更新 mtime，重置 TTL 倒计时
        await fs.utimes(path.join(sessionDir, 'meta.json'), new Date(), new Date()).catch(() => {});
      }
      await loop.run(task);
    } finally {
      unregisterRunningLoop(instanceId);
    }
    return this.collectResult(agentDef, task);
  }

  /**
   * 收集子 Agent 执行的结构化结果
   * session 目录按 instanceId 固定，直接读取，无需遍历查找
   */
  private async collectAgentResult(
    agentName: string,
    instanceId: string,
    task: string,
  ): Promise<AgentResult> {
    const baseResult: AgentResult = {
      agentName,
      task,
      status: 'error',
      summary: 'No output captured',
      turns: 0,
      filesModified: [],
    };

    const subSessionDir = path.join(this.parentContext.sessionDir, 'sub-agents', instanceId);
    const conversationPath = path.join(subSessionDir, 'conversation.jsonl');

    try {
      const content = await fs.readFile(conversationPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      const assistantTexts: string[] = [];
      let turnCount = 0;
      const modifiedFiles = new Set<string>();

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // 跳过 LoopGuard 注入的系统消息（不计入子 Agent 轮次）
          if (msg.role === 'user') {
            const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
            const text = contents
              .filter((c: Record<string, unknown>) => c.type === 'text')
              .map((c: Record<string, unknown>) => String(c.text ?? ''))
              .join('');
            if (!text.startsWith('[LoopGuard]') && !text.startsWith('[Storm suppressed]')) {
              turnCount++;
            }
          }
          if (msg.role === 'assistant' && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                assistantTexts.push(block.text);
              }
              // 追踪工具调用中的文件操作
              if (block.type === 'tool_use') {
                const toolName = block.name ?? block.tool_name ?? '';
                const input = block.input ?? {};
                const filePath = input.file_path ?? input.path ?? '';
                if (['write', 'edit', 'bash'].includes(toolName) && filePath) {
                  modifiedFiles.add(filePath);
                }
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }

      const summary = assistantTexts.length > 0
        ? assistantTexts[assistantTexts.length - 1]
        : 'No text output';

      return {
        agentName,
        task,
        status: 'completed',
        summary,
        turns: Math.ceil(turnCount / 2), // user+assistant 成对
        filesModified: [...modifiedFiles],
      };
    } catch {
      return { ...baseResult, summary: 'Failed to read sub-agent output' };
    }
  }

  /**
   * 收集子 Agent 执行结果
   */
  private async collectResult(agentDef: AgentDefinition, task: string): Promise<string> {
    const result = await this.collectAgentResult(agentDef.name, agentDef.instanceId!, task);
    return `## ${result.agentName} Result\nStatus: ${result.status}\nTurns: ${result.turns}\nFiles Modified: ${result.filesModified.join(', ') || 'none'}\n\n${result.summary}`;
  }
}
