import type { Tool } from '../interface.js';
import type { AgentRegistry } from '../../agents/registry.js';

// 子 Agent 异步任务与生命周期管理工具（6 + 1 helper）

/** 子 Agent 名称白名单：只允许字母/数字/下划线/连字符，杜绝路径穿越（name 会被拼进 prompts/agents/{name}.md） */
function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// ── 异步子 Agent 任务管理工具 ──

/**
 * list_sub_agent_tasks — 列出所有异步子 Agent 任务及其状态。
 */
export function createListSubAgentTasksTool(): Tool {
  return {
    name: 'list_sub_agent_tasks',
    description: '列出所有通过 delegate_to_agent(async=true) 启动的异步子 Agent 任务。包含句柄、Agent 名称、任务描述、状态（running/completed/failed）、启动时间和结果摘要。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      // 动态 import 避免循环依赖：runtime-control → delegate-tool → filtered-registry → tool.registry → runtime-control
      const { listAsyncTasks } = await import('../../agents/delegate-tool.js');
      const tasks = listAsyncTasks();
      if (tasks.length === 0) {
        return '暂无异步子 Agent 任务。使用 delegate_to_agent 并设置 async=true 来启动异步任务。';
      }

      const lines: string[] = [`异步子 Agent 任务（共 ${tasks.length} 个）：`];
      for (const t of tasks) {
        const statusLabel = t.status === 'running' ? '执行中' : t.status === 'completed' ? '已完成' : '失败';
        const statusIcon = t.status === 'running' ? '🔄' : t.status === 'completed' ? '✅' : '❌';
        lines.push(`  ${statusIcon} ${t.handle} [${statusLabel}] ${t.agentName} (instance: ${t.instanceId}): ${t.task.slice(0, 60)}${t.task.length > 60 ? '...' : ''}`);
        if (t.status !== 'running' && t.result) {
          const summary = t.result.split('\n').find(l => l.trim())?.slice(0, 80) ?? '';
          lines.push(`     ↳ ${summary}${summary.length >= 80 ? '...' : ''}`);
        }
      }
      lines.push('');
      lines.push('使用 get_sub_agent_result <handle> 获取已完成任务的完整结果。');
      return lines.join('\n');
    },
  };
}

/**
 * get_sub_agent_result — 获取异步子 Agent 任务的执行结果。
 */
export function createGetSubAgentResultTool(): Tool {
  return {
    name: 'get_sub_agent_result',
    description: '获取指定异步子 Agent 任务的执行结果。running 时返回仍在执行中，completed 时返回完整结果，failed 时返回错误信息。句柄从 list_sub_agent_tasks 获取。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: '异步任务句柄（如 sub_001），从 list_sub_agent_tasks 获取。',
        },
      },
      required: ['handle'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const handle = args.handle as string;
      // 动态 import 避免循环依赖（同 list_sub_agent_tasks）
      const { getAsyncTask } = await import('../../agents/delegate-tool.js');
      const task = getAsyncTask(handle);
      if (!task) {
        return `错误：未找到异步任务 "${handle}"。使用 list_sub_agent_tasks 查看所有任务及其句柄。`;
      }

      if (task.status === 'running') {
        return `任务 ${handle}（${task.agentName}）仍在执行中。任务：${task.task.slice(0, 100)}${task.task.length > 100 ? '...' : ''}\n启动时间：${task.startTime}\n请稍后再次调用 get_sub_agent_result 查询。`;
      }

      if (task.status === 'failed') {
        return `任务 ${handle}（${task.agentName}）执行失败。\n错误：${task.error}\n任务：${task.task}`;
      }

      return `任务 ${handle}（${task.agentName}）已完成。\n\n${task.result}`;
    },
  };
}

/**
 * spawn_sub_agent — clone an existing sub-agent to create a parallel instance (分身).
 */
export function createSpawnSubAgentTool(agentRegistry: any): Tool {
  return {
    name: 'spawn_sub_agent',
    description: '克隆已有子 Agent，创建独立实例用于并行执行不同任务。这是实现并行分发的关键工具——当主 Agent 制定计划后，可克隆多份子 Agent 实例，各自分配到不同子任务上并发执行，显著提高效率。每个克隆拥有独立会话和上下文，互不干扰。customName 参数可为克隆指定易辨识的别名（如后端审查/前端审查），之后通过 delegate_to_agent 配合 instance_id 精确调度。用 list_sub_agents 查看所有克隆状态。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the existing sub-agent to clone (e.g. "code-reviewer")' },
        customName: { type: 'string', description: 'Optional alias for the new instance (e.g. "code-reviewer-frontend"). If not provided, uses the original name.' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const customName = args.customName as string | undefined;
      if (!isValidAgentName(name)) {
        return 'Error: Invalid sub-agent name. Only letters, digits, underscore and hyphen are allowed.';
      }
      if (customName !== undefined && !isValidAgentName(customName)) {
        return 'Error: Invalid customName. Only letters, digits, underscore and hyphen are allowed.';
      }

      try {
        const spawned = agentRegistry.spawnInstance(name, customName);
        if (!spawned) {
          const available = agentRegistry.getAll().map((a: any) => a.name).join(', ');
          return `Error: No sub-agent named "${name}" found. Available: ${available}`;
        }
        return `New instance created:\n- Name: ${spawned.name}\n- Instance ID: ${spawned.instanceId}\n- Description: ${spawned.description}\n- Max Turns: ${spawned.maxTurns}\n\nUse this instance_id with delegate_to_agent to target this specific copy.`;
      } catch (err) {
        return `Error spawning sub-agent: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * create_sub_agent — create a brand-new custom sub-agent at runtime.
 * When persist=true, also writes prompt file and agents.json config to disk
 * so the agent survives restarts and rebuilds.
 */
export function createCreateSubAgentTool(agentRegistry: any, cwd: string): Tool {
  return {
    name: 'create_sub_agent',
    description: '创建一个新的自定义子 Agent。定义其角色（description）、行为准则（systemPrompt）和可用工具（allowedTools）。系统提示词中的 {{task}} 占位符在首次委派时解析为固定指引（"当前任务以最新一条用户消息为准"）——具体任务通过委派时的 user 消息传递，system prompt 落定后冻结，复用不变，前缀恒定以利 KV 缓存命中。persist=true 时将 Agent 定义持久化到磁盘，重启后仍可用。默认可用工具为 read/glob/grep/write，可按需扩展。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for the new sub-agent (e.g. "doc-reviewer")' },
        description: { type: 'string', description: 'Role description — helps the orchestrator decide when to use this agent.' },
        systemPrompt: { type: 'string', description: 'Full system prompt defining the sub-agent\'s behavior, expertise, and constraints. {{task}} is resolved once to a fixed pointer (task is delivered via the delegated user message); the resolved prompt is frozen on first delegation for cache stability.' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool whitelist for this agent. Default: ["read", "glob", "grep", "write"]. Use ["self"] for all tools.',
        },
        maxTurns: { type: 'number', description: 'Maximum execution turns. Default: 10.' },
        persist: {
          type: 'boolean',
          description: 'When true, also write prompt file and config to disk so the agent persists after restart. Default: false (memory only).',
        },
        session_ttl_minutes: {
          type: 'number',
          description: 'Sub-agent session TTL in minutes. Session auto-cleans if unused for this duration. Default: 10.',
        },
      },
      required: ['name', 'description', 'systemPrompt'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const description = args.description as string;
      const systemPrompt = args.systemPrompt as string;
      const allowedTools = (args.allowedTools as string[] | undefined) ?? ['read', 'glob', 'grep', 'write'];
      const maxTurns = (args.maxTurns as number | undefined) ?? 10;
      const persist = args.persist === true;
      const sessionTtlMinutes = (args.session_ttl_minutes as number | undefined) ?? 10;
      if (!isValidAgentName(name)) {
        return 'Error: Invalid sub-agent name. Only letters, digits, underscore and hyphen are allowed.';
      }

      try {
        const def = agentRegistry.register({
          name,
          description,
          systemPrompt,
          allowedTools,
          maxTurns,
          sessionTtlMinutes,
        });

        const lines: string[] = [
          `Sub-agent created successfully:`,
          `- Name: ${def.name}`,
          `- Instance ID: ${def.instanceId}`,
          `- Description: ${def.description}`,
          `- Allowed Tools: ${def.allowedTools.join(', ')}`,
          `- Max Turns: ${def.maxTurns}`,
          ``,
          `Use delegate_to_agent with agent_name="${def.name}" or instance_id="${def.instanceId}" to invoke this agent.`,
        ];

        if (persist) {
          await persistSubAgent(cwd, name, description, systemPrompt, allowedTools, maxTurns, sessionTtlMinutes);
          lines.push(`- Persisted to disk: yes (prompts/agents/${name}.md + .agent/agents.json)`);
        } else {
          lines.push(`- Persisted to disk: no (memory only, use persist=true to save permanently)`);
        }

        return lines.join('\n');
      } catch (err) {
        return `Error creating sub-agent: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * update_sub_agent — modify an existing sub-agent's configuration at runtime.
 */
export function createUpdateSubAgentTool(agentRegistry: any): Tool {
  return {
    name: 'update_sub_agent',
    description: '运行时修改子 Agent 配置，下次委派时生效。只更新你指定的字段，其余保持不变。名称不可修改（需改名则先 destroy 再重建）。常见场景：根据实际需要增减 allowedTools、为复杂任务拉高 maxTurns。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Instance ID of the sub-agent to update (required).' },
        description: { type: 'string', description: 'Updated role description.' },
        systemPrompt: { type: 'string', description: 'Updated system prompt. {{task}} resolves once to a fixed pointer on first delegation; changing this only affects newly-created sessions.' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Updated tool whitelist.',
        },
        maxTurns: { type: 'number', description: 'Updated max execution turns.' },
        session_ttl_minutes: { type: 'number', description: 'Updated session TTL in minutes.' },
      },
      required: ['instance_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const instanceId = args.instance_id as string;
      const partial: Record<string, unknown> = {};

      if (args.description !== undefined) partial.description = args.description;
      if (args.systemPrompt !== undefined) partial.systemPrompt = args.systemPrompt;
      if (args.allowedTools !== undefined) partial.allowedTools = args.allowedTools;
      if (args.maxTurns !== undefined) partial.maxTurns = args.maxTurns;
      if (args.session_ttl_minutes !== undefined) partial.sessionTtlMinutes = args.session_ttl_minutes;
      if (Object.keys(partial).length === 0) {
        return 'Error: no fields to update. Specify at least one field to modify.';
      }

      const updated = agentRegistry.update(instanceId, partial);
      if (!updated) {
        return `Error: sub-agent instance "${instanceId}" not found. Use list_sub_agents to see available instances with their IDs.`;
      }

      const lines: string[] = [
        `Sub-agent updated successfully:`,
        `- Instance ID: ${updated.instanceId}`,
        `- Name: ${updated.name}`,
        `- Description: ${updated.description}`,
        `- Allowed Tools: ${updated.allowedTools.join(', ')}`,
        `- Max Turns: ${updated.maxTurns}`,
      ];
      return lines.join('\n');
    },
  };
}

/**
 * destroy_sub_agent — permanently delete a sub-agent instance and its session directory.
 */
export function createDestroySubAgentTool(
  agentRegistry: AgentRegistry,
  parentSessionDir: string,
): Tool {
  return {
    name: 'destroy_sub_agent',
    description: '永久删除子 Agent 实例及其全部会话数据（对话历史、统计、元信息）。对于克隆出来的实例，仅删除指定目标——原始 Agent 和其他克隆不受影响。此操作不可撤销。先用 list_sub_agents 确认要删除的 instance_id。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Instance ID of the sub-agent to destroy (required).' },
      },
      required: ['instance_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const instanceId = args.instance_id as string;
      const def = agentRegistry.getByInstanceId(instanceId);
      if (!def) {
        return `Error: sub-agent instance "${instanceId}" not found.`;
      }

      // 先销毁 session 目录
      const { destroySubAgentSession } = await import('../../agents/delegate-tool.js');
      const sessionCleaned = await destroySubAgentSession(parentSessionDir, instanceId);

      // 再从注册表移除
      agentRegistry.destroyInstance(instanceId);

      const lines = [
        `Sub-agent "${def.name}" (instance: ${instanceId}) destroyed.`,
        sessionCleaned ? '- Session data cleaned' : '- Session directory not found (already cleaned or never created)',
      ];
      return lines.join('\n');
    },
  };
}

/**
 * Persist a sub-agent definition to disk:
 * 1. Write prompt file to src/prompts/agents/{name}.md
 * 2. Write prompt file to dist/prompts/agents/{name}.md (immediate runtime access)
 * 3. Update project-level .agent/agents.json
 */
async function persistSubAgent(
  cwd: string,
  name: string,
  description: string,
  systemPrompt: string,
  allowedTools: string[],
  maxTurns: number,
  sessionTtlMinutes?: number,
): Promise<void> {
  // 纵深防御：即使调用方未校验，落盘前再次拒绝非法名称
  if (!isValidAgentName(name)) {
    throw new Error(`Invalid sub-agent name "${name}": only letters, digits, underscore and hyphen are allowed.`);
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  // 修复：写到 loadPrompt 的第一查找位置 ~/.agent/prompts/agents/{name}.md。
  // 旧实现写 cwd/src 与 cwd/dist，而加载器（prompts/loader.ts）读的是
  // ~/.agent/prompts 与部署 dist——运行时 cwd 为家目录时两个路径全落空，
  // 导致 persist 后 prompt 文件“写成功但加载器读不到”，agent 被静默跳过。
  const externalPromptDir = path.join(os.homedir(), '.agent', 'prompts', 'agents');
  await fs.mkdir(externalPromptDir, { recursive: true });
  await fs.writeFile(path.join(externalPromptDir, `${name}.md`), systemPrompt, 'utf-8');

  // 兼容仓库部署场景：同时写 dist/prompts/agents/{name}.md（loadPrompt 的内置回退目录）
  const distPromptDir = path.join(cwd, 'dist', 'prompts', 'agents');
  try {
    await fs.mkdir(distPromptDir, { recursive: true });
    await fs.writeFile(path.join(distPromptDir, `${name}.md`), systemPrompt, 'utf-8');
  } catch {
    // dist directory may not exist (e.g., dev mode); ignore
  }

  // 3. Update project-level .agent/agents.json
  const agentConfigPath = path.join(cwd, '.agent', 'agents.json');
  let existing: { agents: any[] } = { agents: [] };
  try {
    const content = await fs.readFile(agentConfigPath, 'utf-8');
    existing = JSON.parse(content);
    if (!Array.isArray(existing.agents)) existing.agents = [];
  } catch {
    // file does not exist or invalid json, start fresh
  }

  // Remove existing entry with same name (to support re-registration)
  existing.agents = existing.agents.filter((a: any) => a.name !== name);

  const entry: any = {
    name,
    description,
    promptFile: `agents/${name}`,
    allowedTools,
    maxTurns,
  };
  if (sessionTtlMinutes !== undefined) entry.sessionTtlMinutes = sessionTtlMinutes;
  existing.agents.push(entry);

  await fs.mkdir(path.dirname(agentConfigPath), { recursive: true });
  await fs.writeFile(agentConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
}
