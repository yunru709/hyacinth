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
import type { ToolRegistry } from '../tools/registry.js';
import type { DependencyAnalyzer } from '../dependency/analyzer.js';

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
): Promise<{ loop: AgentLoop; sessionDir: string; isNew: boolean }> {
  const instanceId = agentDef.instanceId ?? `${agentDef.name}-default`;
  const subSessionDir = path.join(parentContext.sessionDir, 'sub-agents', instanceId);
  const ttlMinutes = agentDef.sessionTtlMinutes ?? 10;

  // TTL 检查：过期则清理重建
  let isNew = false;
  try {
    const metaRaw = await fs.readFile(path.join(subSessionDir, 'meta.json'), 'utf-8');
    const meta: SubSessionMeta = JSON.parse(metaRaw);
    const elapsed = (Date.now() - meta.createdAt) / 60_000;
    if (elapsed > ttlMinutes) {
      await fs.rm(subSessionDir, { recursive: true });
      isNew = true;
    }
  } catch {
    isNew = true; // 目录不存在或 meta 损坏
  }

  if (isNew) {
    await fs.mkdir(subSessionDir, { recursive: true });
    await fs.writeFile(path.join(subSessionDir, 'meta.json'), JSON.stringify({
      createdAt: Date.now(), agentName: agentDef.name, instanceId,
    } satisfies SubSessionMeta), 'utf-8');
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
  let systemPrompt = agentDef.systemPrompt.replace(/\{\{task\}\}/g, task);

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

  // 6. 获取子 Agent 的 Provider（通过 ModelRouter，可配置独立通道）
  const subProvider = parentContext.modelRouter.getProvider('sub-agent');

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

  // 9. 创建 AgentLoop
  const loop = new AgentLoop(
    subProvider,
    subComposer,
    compressor,
    orchestrator,
    toolExecutor,
    filteredRegistry,
    conversationStore,
    eventStore,
    statsManager,
    subSessionDir,
    summaryStore,
    agentDef.maxTurns,
    parentContext.maxContextTokens,
    silentHandler,
    undefined, // skillRegistry — 子 Agent 不使用 Skill
    undefined, // mcpBridge — 子 Agent 不使用 MCP
    parentContext.dependencyAnalyzer,
  );

  return { loop, sessionDir: subSessionDir, isNew };
}

/**
 * DelegateToAgentTool — 主 Agent 通过此工具委托任务给子 Agent
 */
export class DelegateToAgentTool implements Tool {
  name = 'delegate_to_agent';
  description = 'Delegate a task to a specialized sub-agent. The sub-agent will execute the task independently and return results.';
  inputSchema = {
    type: 'object' as const,
    properties: {
      agent_name: {
        type: 'string' as const,
        description: 'Name of the sub-agent to delegate to (e.g., "code-reviewer"). If multiple instances exist, the first available one is selected. Use instance_id for precise targeting.',
      },
      instance_id: {
        type: 'string' as const,
        description: 'Optional instance ID of a specific sub-agent instance (for targeting a clone/spawned copy). Takes priority over agent_name.',
      },
      task: {
        type: 'string' as const,
        description: 'Clear description of the task to delegate to the sub-agent',
      },
      context: {
        type: 'string' as const,
        description: 'Optional additional context to provide to the sub-agent (e.g., relevant code snippets, file paths)',
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
      if (agentDef.collaborationMode === 'adversarial') {
        // 对抗审查模式：找一个不同角色的子 Agent 同时审查
        return await this.executeAdversarial(agentDef, fullTask);
      } else if (agentDef.collaborationMode === 'parallel') {
        // 并行分工模式：所有 parallel 模式的子 Agent 并行执行
        return await this.executeParallel(agentDef, fullTask);
      } else {
        // 委托模式：直接委托给子 Agent
        return await this.executeDelegate(agentDef, fullTask);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return `Sub-agent delegation failed: ${message}`;
    }
  }

  /**
   * 委托模式：单个子 Agent 执行任务
   */
  private async executeDelegate(agentDef: AgentDefinition, task: string): Promise<string> {
    const instanceId = agentDef.instanceId!;
    const { loop, sessionDir, isNew } = await createSubAgentLoop(agentDef, task, this.parentContext);
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
   * 对抗审查模式：两个不同角色的子 Agent 独立审查，综合意见
   */
  private async executeAdversarial(agentDef: AgentDefinition, task: string): Promise<string> {
    // 找一个不同角色的子 Agent 作为对抗方
    const allAgents = this.agentRegistry.getAll();
    const adversary = allAgents.find(a => a.name !== agentDef.name && a.collaborationMode === 'adversarial');

    // 第一个子 Agent 执行
    const { loop: loop1, sessionDir: dir1, isNew: isNew1 } = await createSubAgentLoop(agentDef, task, this.parentContext);
    registerRunningLoop(agentDef.instanceId!, loop1);
    try {
      if (!isNew1) await fs.utimes(path.join(dir1, 'meta.json'), new Date(), new Date()).catch(() => {});
      await loop1.run(task);
    } finally { unregisterRunningLoop(agentDef.instanceId!); }
    const result1 = await this.collectConversationSummary(agentDef.name, agentDef.instanceId!);

    if (!adversary) {
      return `## ${agentDef.name} Review\n\n${result1}`;
    }

    // 第二个子 Agent 执行（对抗方）
    const { loop: loop2, sessionDir: dir2, isNew: isNew2 } = await createSubAgentLoop(adversary, task, this.parentContext);
    registerRunningLoop(adversary.instanceId!, loop2);
    try {
      if (!isNew2) await fs.utimes(path.join(dir2, 'meta.json'), new Date(), new Date()).catch(() => {});
      await loop2.run(task);
    } finally { unregisterRunningLoop(adversary.instanceId!); }
    const result2 = await this.collectConversationSummary(adversary.name, adversary.instanceId!);

    // 综合两个子 Agent 的意见
    return `## Adversarial Review Results\n\n### ${agentDef.name} Perspective\n${result1}\n\n### ${adversary.name} Perspective\n${result2}\n\n---\nBoth agents reviewed independently. Consider both perspectives when making decisions.`;
  }

  /**
   * 并行分工模式：多个子 Agent 并行执行同一任务的不同方面，汇总结果
   */
  private async executeParallel(agentDef: AgentDefinition, task: string): Promise<string> {
    // 找到所有 parallel 模式的子 Agent
    const allAgents = this.agentRegistry.getAll();
    const parallelAgents = allAgents.filter(a => a.collaborationMode === 'parallel');

    if (parallelAgents.length <= 1) {
      // 只有一个或没有 parallel 子 Agent，退化为普通委托
      return await this.executeDelegate(agentDef, task);
    }

    // 并行启动所有 parallel 子 Agent
    const results = await Promise.all(
      parallelAgents.map(async (agent) => {
        const { loop, sessionDir, isNew } = await createSubAgentLoop(agent, task, this.parentContext);
        registerRunningLoop(agent.instanceId!, loop);
        try {
          if (!isNew) await fs.utimes(path.join(sessionDir, 'meta.json'), new Date(), new Date()).catch(() => {});
          await loop.run(task);
        } finally { unregisterRunningLoop(agent.instanceId!); }
        const summary = await this.collectConversationSummary(agent.name, agent.instanceId!);
        return { name: agent.name, summary };
      })
    );

    // 汇总所有子 Agent 的结果
    const parts = results.map(r => `### ${r.name}\n${r.summary}`).join('\n\n');
    return `## Parallel Execution Results\n\n${parts}\n\n---\nAll agents executed in parallel. Review each result independently.`;
  }

  /**
   * 收集子 Agent 的对话摘要
   */
  private async collectConversationSummary(agentName: string, instanceId: string): Promise<string> {
    const result = await this.collectAgentResult(agentName, instanceId, '');
    return result.summary;
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
