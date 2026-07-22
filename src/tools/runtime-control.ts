import type { Tool } from './interface.js';
import type { ToolRegistry } from './registry.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { ScheduledTask } from '../schedule/types.js';
import type { MCPSystem } from '../mcp/system.js';
import type { CompanionSessionManager } from '../memory/companion-session.js';
import { clearPromptCache } from '../prompts/loader.js';
import { switchRouter } from '../context/profiles.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================
// Provider tools (4)
// ============================================================

/**
 * switch_provider — switch to a specific named provider.
 * Calls agentLoop.switchProvider(name) which does per-named-provider switching
 * and updates the orchestrator (unlike toggleProvider which only flips local/online).
 */
export function createSwitchProviderTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'switch_provider',
    description:
      '切换当前使用的 LLM 提供商及模型。四种用法：只传 name=切换到已配置的提供商；传 name+api_key=动态注册新提供商；传 name+model=覆盖该提供商的默认模型；传 name+max_tokens=限制最大输出 Token。先用 list_providers 查看已注册的提供商。',
    inputSchema: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: 'Provider type: anthropic | openai | deepseek | gemini | qwen | zhipu | minimax | mimo | groq | xai | mistral | openrouter | moonshot | local' },
        api_key:    { type: 'string', description: 'Optional: API key. If not set, uses environment variable.' },
        model:      { type: 'string', description: 'Optional: model name. If not set, uses the provider\'s default model.' },
        max_tokens: { type: 'number', description: 'Optional: max output tokens for this provider. If not set, auto-detected from model catalog or provider config.' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const name = args.name as string;
        if (!name || typeof name !== 'string') {
          return 'Error: provider name is required. Use list_providers to see available names.';
        }
        const apiKey = (args.api_key as string) || undefined;
        const model  = (args.model as string) || undefined;

        // 带 key 的动态注册
        if (apiKey) {
          const { ProviderManager } = await import('../provider/manager.js');
          const { getProviderConfigLoader } = await import('../provider/config.js');
          const provCfg = getProviderConfigLoader().getProvider(name);
          const maxTokens = (args.max_tokens as number) || undefined;
          const config: import('../types.js').ProviderConfig = {
            type: name as import('../types.js').ProviderType,
            apiKey,
            model: model ?? provCfg?.defaultModel ?? 'unknown',
            baseUrl: provCfg?.baseUrl,
            maxOutputTokens: maxTokens,
          };
          const manager = new ProviderManager(config);
          const provider = manager.getProvider();
          agentLoop.registerProvider?.(name, provider);
        }

        await agentLoop.switchProvider(name);
        const after = agentLoop.getActiveProvider();
        return `Provider switched to "${name}" (${after.getProviderType()}/${after.getModel()}).`;
      } catch (err) {
        return `Error switching provider: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_providers — list all registered providers with their types and models.
 */
export function createListProvidersTool(providerRouter: ProviderRouter): Tool {
  return {
    name: 'list_providers',
    description: '列出所有已注册的 LLM 提供商，包含名称、类型和当前使用的模型。当前活跃的提供商前标有 *。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const names = providerRouter.list();
        if (names.length === 0) {
          return 'No providers registered.';
        }

        const routingInfo = providerRouter.getRoutingInfo();

        const lines = names.map((name) => {
          const provider = providerRouter.get(name);
          if (!provider) return `- ${name}: [not found]`;
          const isActive = name === routingInfo.providerName;
        const displayModel = name === 'local' ? '(local backend)' : `${provider.getProviderType()} / ${provider.getModel()}`;
        return `${isActive ? '* ' : '  '}${name}: ${displayModel}${isActive ? ' (active)' : ''}`;
        });

        lines.unshift(`Route mode: ${routingInfo.mode}`);
        return lines.join('\n');
      } catch (err) {
        return `Error listing providers: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * provider_info — show details about the currently active provider.
 */
export function createProviderInfoTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'provider_info',
    description: '查看当前活跃提供商的详细信息：类型、模型名称、能力（如 thinking、图片识别）。当主提供商故障降级到备用时，会显示降级状态。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const provider = agentLoop.getActiveProvider();
        const type = provider.getProviderType();
        const model = provider.getModel();
        const caps = provider.getCapabilities ? provider.getCapabilities() : null;

        const info: Record<string, unknown> = {
          type,
          model,
        };

        // Detect fallback chain
        const chain = provider as { isOnFallback?: boolean; getActiveType?: () => string; getActiveModel?: () => string };
        if (chain.isOnFallback) {
          info.active_type = chain.getActiveType?.() ?? type;
          info.active_model = chain.getActiveModel?.() ?? model;
          info.on_fallback = true;
          info.warning = 'Primary provider failed — currently running on a fallback provider. Check API key or quota for the primary.';
        }

        if (caps) {
          info.capabilities = caps;
        }

        return JSON.stringify(info, null, 2);
      } catch (err) {
        return `Error getting provider info: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * switch_to_auto_route — switch provider routing back to automatic mode.
 */
export function createSwitchToAutoRouteTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'switch_to_auto_route',
    description: '将提供商路由切回自动模式。自动模式下系统根据任务复杂度自动选择最合适的提供商。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        agentLoop.switchToAutoRoute();
        return 'Provider routing switched to auto mode. Use list_providers to see current routing state.';
      } catch (err) {
        return `Error switching to auto route: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ============================================================
// Registry control tools (6)
// ============================================================

/**
 * toggle_tool — enable or disable a specific tool by name.
 */
export function createToggleToolTool(toolRegistry: ToolRegistry, configCenter?: RuntimeConfigCenter): Tool {
  return {
    name: 'toggle_tool',
    description: '启用或禁用指定工具。禁用的工具对 LLM 不可见也不可调用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the tool to toggle' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['name', 'enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const enabled = args.enabled as boolean;

      if (!toolRegistry.has(name)) {
        return `Error: tool "${name}" is not registered.`;
      }

      if (enabled) {
        toolRegistry.enableTool(name);
      } else {
        toolRegistry.disableTool(name);
      }

      // Persist disabled tools list
      if (configCenter) {
        const disabledNames = toolRegistry.getDisabled().map(t => t.name);
        configCenter.set('tools.disabled', disabledNames);
        await configCenter.save();
      }

      return `Tool "${name}" has been ${enabled ? 'enabled' : 'disabled'}.`;
    },
  };
}

/**
 * list_tools — list all registered tools with their enabled/disabled status.
 */
export function createListToolsTool(toolRegistry: ToolRegistry): Tool {
  return {
    name: 'list_tools',
    description: '列出所有已注册的工具及其启用/禁用状态。',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: {
          type: 'boolean',
          description: 'When true, include disabled tools in the listing. Defaults to false.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const includeDisabled = args.includeDisabled as boolean | undefined;

      const all = includeDisabled
        ? [...toolRegistry.getEnabled(), ...toolRegistry.getDisabled()]
        : toolRegistry.getEnabled();

      if (all.length === 0) {
        return 'No tools registered.';
      }

      const disabledSet = new Set(toolRegistry.getDisabled().map((t) => t.name));

      const lines = all.map((tool) => {
        const enabled = !disabledSet.has(tool.name);
        const status = enabled ? 'enabled' : 'disabled';
        return `- ${tool.name} [${status}] (enabled: ${enabled}): ${tool.description}`;
      });

      return `Tools (${all.length} total):\n${lines.join('\n')}`;
    },
  };
}

/**
 * toggle_skill — enable or disable a specific skill by name.
 */
export function createToggleSkillTool(skillRegistry: SkillRegistry, configCenter?: RuntimeConfigCenter): Tool {
  return {
    name: 'toggle_skill',
    description: '启用或禁用指定 Skill。禁用的 Skill 不再对 LLM 暴露。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the skill to toggle' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['name', 'enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const enabled = args.enabled as boolean;

      if (enabled) {
        skillRegistry.enableSkill(name);
      } else {
        skillRegistry.disableSkill(name);
      }

      // Persist disabled skills list
      if (configCenter) {
        const disabledNames = skillRegistry.getDisabled().map(s => s.name);
        configCenter.set('skills.disabled', disabledNames);
        await configCenter.save();
      }

      return `Skill "${name}" has been ${enabled ? 'enabled' : 'disabled'}.`;
    },
  };
}

/**
 * list_skills — list all registered skills with their enabled/disabled status.
 */
export function createListSkillsTool(skillRegistry: SkillRegistry): Tool {
  return {
    name: 'list_skills',
    description: '列出所有已注册的 Skill 及其启用/禁用状态。',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: {
          type: 'boolean',
          description: 'When true, include disabled skills in the listing. Defaults to false.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const includeDisabled = args.includeDisabled as boolean | undefined;

      const all = includeDisabled
        ? [...skillRegistry.getEnabled(), ...skillRegistry.getDisabled()]
        : skillRegistry.getEnabled();

      if (all.length === 0) {
        return 'No skills registered.';
      }

      const disabledSet = new Set(skillRegistry.getDisabled().map((s) => s.name));

      const lines = all.map((skill) => {
        const enabled = !disabledSet.has(skill.name);
        const status = enabled ? 'enabled' : 'disabled';
        return `- ${skill.name} [${status}] (enabled: ${enabled}): ${skill.description}`;
      });

      return `Skills (${all.length} total):\n${lines.join('\n')}`;
    },
  };
}

/**
 * toggle_sub_agent — enable or disable a specific sub-agent by name.
 */
export function createToggleSubAgentTool(agentRegistry: AgentRegistry, configCenter?: RuntimeConfigCenter): Tool {
  return {
    name: 'toggle_sub_agent',
    description: '按名称启用或禁用子 Agent。禁用后该 Agent 从 list_sub_agents 中隐藏且不可被委派——适用于临时移除行为异常或当前不需要的 Agent，保留配置不销毁。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the sub-agent to toggle' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['name', 'enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const enabled = args.enabled as boolean;

      if (enabled) {
        agentRegistry.enableAgent(name);
      } else {
        agentRegistry.disableAgent(name);
      }

      // Persist disabled agents list
      if (configCenter) {
        const disabledNames = agentRegistry.getDisabled().map(a => a.name);
        configCenter.set('agents.disabled', disabledNames);
        await configCenter.save();
      }

      return `Sub-agent "${name}" has been ${enabled ? 'enabled' : 'disabled'}.`;
    },
  };
}

/**
 * list_sub_agents — list all registered sub-agents with their enabled/disabled status and instance IDs.
 */
export function createListSubAgentsTool(agentRegistry: any): Tool {
  return {
    name: 'list_sub_agents',
    description: '列出所有已注册的子 Agent，按名称分组展示。包含：名称、启用状态、instance ID、描述、协作模式、最大轮次。spawn_sub_agent 克隆出的多份实例会在同一名称下分组。用列表中的 instance_id 配合 delegate_to_agent / update_sub_agent / destroy_sub_agent 精确定位目标。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const all = [...agentRegistry.getEnabled(), ...agentRegistry.getDisabled()];

      if (all.length === 0) {
        return 'No sub-agents registered.';
      }

      const disabledSet = new Set(agentRegistry.getDisabled().map((a: any) => a.instanceId));

      // Group by name to show multiple instances
      const grouped = new Map<string, any[]>();
      for (const agent of all) {
        const list = grouped.get(agent.name) || [];
        list.push(agent);
        grouped.set(agent.name, list);
      }

      const lines: string[] = [`Sub-agents (${all.length} total, ${grouped.size} types):`];
      for (const [name, instances] of grouped) {
        const isMulti = instances.length > 1;
        for (const agent of instances) {
          const enabled = !disabledSet.has(agent.instanceId);
          const status = enabled ? 'enabled' : 'disabled';
          const idTag = isMulti ? ` [id: ${agent.instanceId}]` : '';
          lines.push(`- ${agent.name}${idTag} [${status}] (enabled: ${enabled}): ${agent.description} (mode: ${agent.collaborationMode}, maxTurns: ${agent.maxTurns})`);
        }
      }

      return lines.join('\n');
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

      try {
        const spawned = agentRegistry.spawnInstance(name, customName);
        if (!spawned) {
          const available = agentRegistry.getAll().map((a: any) => a.name).join(', ');
          return `Error: No sub-agent named "${name}" found. Available: ${available}`;
        }
        return `New instance created:\n- Name: ${spawned.name}\n- Instance ID: ${spawned.instanceId}\n- Description: ${spawned.description}\n- Mode: ${spawned.collaborationMode}\n- Max Turns: ${spawned.maxTurns}\n\nUse this instance_id with delegate_to_agent to target this specific copy.`;
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
    description: '创建一个新的自定义子 Agent。定义其角色（description）、行为准则（systemPrompt）、可用工具（allowedTools）和协作模式（collaborationMode）。系统提示词中使用 {{task}} 作为占位符——委派时自动替换为实际任务。persist=true 时将 Agent 定义持久化到磁盘，重启后仍可用。协作模式选择：delegate=单Agent执行，adversarial=双Agent交叉审查，parallel=多Agent并行。默认可用工具为 read/glob/grep/write，可按需扩展。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for the new sub-agent (e.g. "doc-reviewer")' },
        description: { type: 'string', description: 'Role description — helps the orchestrator decide when to use this agent.' },
        systemPrompt: { type: 'string', description: 'Full system prompt defining the sub-agent\'s behavior, expertise, and constraints. Use {{task}} as a placeholder for the delegated task.' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool whitelist for this agent. Default: ["read", "glob", "grep", "write"]. Use ["self"] for all tools.',
        },
        maxTurns: { type: 'number', description: 'Maximum execution turns. Default: 10.' },
        collaborationMode: {
          type: 'string',
          enum: ['delegate', 'adversarial', 'parallel'],
          description: 'Collaboration mode. Default: "delegate".',
        },
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
      const collaborationMode = (args.collaborationMode as string | undefined) ?? 'delegate';
      const persist = args.persist === true;
      const sessionTtlMinutes = (args.session_ttl_minutes as number | undefined) ?? 10;

      // Validate mode
      const validModes = ['delegate', 'adversarial', 'parallel'];
      if (!validModes.includes(collaborationMode)) {
        return `Error: invalid collaborationMode "${collaborationMode}". Must be one of: ${validModes.join(', ')}`;
      }

      try {
        const def = agentRegistry.register({
          name,
          description,
          systemPrompt,
          allowedTools,
          maxTurns,
          collaborationMode,
          sessionTtlMinutes,
        });

        const lines: string[] = [
          `Sub-agent created successfully:`,
          `- Name: ${def.name}`,
          `- Instance ID: ${def.instanceId}`,
          `- Description: ${def.description}`,
          `- Mode: ${def.collaborationMode}`,
          `- Allowed Tools: ${def.allowedTools.join(', ')}`,
          `- Max Turns: ${def.maxTurns}`,
          ``,
          `Use delegate_to_agent with agent_name="${def.name}" or instance_id="${def.instanceId}" to invoke this agent.`,
        ];

        if (persist) {
          await persistSubAgent(cwd, name, systemPrompt, allowedTools, maxTurns, collaborationMode, sessionTtlMinutes);
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
    description: '运行时修改子 Agent 配置，下次委派时生效。只更新你指定的字段，其余保持不变。名称不可修改（需改名则先 destroy 再重建）。常见场景：根据实际需要增减 allowedTools、为复杂任务拉高 maxTurns、将 collaborationMode 从 delegate 切换为 adversarial 以加强审查。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Instance ID of the sub-agent to update (required).' },
        description: { type: 'string', description: 'Updated role description.' },
        systemPrompt: { type: 'string', description: 'Updated system prompt. Use {{task}} as placeholder.' },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Updated tool whitelist.',
        },
        maxTurns: { type: 'number', description: 'Updated max execution turns.' },
        collaborationMode: {
          type: 'string',
          enum: ['delegate', 'adversarial', 'parallel'],
          description: 'Updated collaboration mode.',
        },
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
      if (args.collaborationMode !== undefined) {
        const mode = args.collaborationMode as string;
        const validModes = ['delegate', 'adversarial', 'parallel'];
        if (!validModes.includes(mode)) {
          return `Error: invalid collaborationMode "${mode}". Must be one of: ${validModes.join(', ')}`;
        }
        partial.collaborationMode = mode;
      }

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
        `- Mode: ${updated.collaborationMode}`,
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
      const { destroySubAgentSession } = await import('../agents/delegate-tool.js');
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
  systemPrompt: string,
  allowedTools: string[],
  maxTurns: number,
  collaborationMode: string,
  sessionTtlMinutes?: number,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const srcPromptDir = path.join(cwd, 'src', 'prompts', 'agents');
  const distPromptDir = path.join(cwd, 'dist', 'prompts', 'agents');

  // 1. Write src/prompts/agents/{name}.md
  await fs.mkdir(srcPromptDir, { recursive: true });
  await fs.writeFile(path.join(srcPromptDir, `${name}.md`), systemPrompt, 'utf-8');

  // 2. Write dist/prompts/agents/{name}.md (immediate runtime readiness)
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
    description: `Custom sub-agent created at runtime`,
    promptFile: `agents/${name}`,
    allowedTools,
    maxTurns,
    collaborationMode,
  };
  if (sessionTtlMinutes !== undefined) entry.sessionTtlMinutes = sessionTtlMinutes;
  existing.agents.push(entry);

  await fs.mkdir(path.dirname(agentConfigPath), { recursive: true });
  await fs.writeFile(agentConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
}

// ============================================================
// Session / Training control tools (5)
// ============================================================

/**
 * interrupt — interrupt the currently running agent loop.
 */
export function createInterruptTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'interrupt',
    description: '中断当前正在执行的 Agent 以及所有进行中的 LLM 请求。传入 instance_id 可精确中断指定子 Agent，不传则中断主 Agent。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Optional instance ID of a running sub-agent to interrupt. If omitted, interrupts the main agent.',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const instanceId = args.instance_id as string | undefined;
        if (instanceId) {
          // 动态 import 避免循环依赖：runtime-control → delegate-tool → filtered-registry → tool.registry → runtime-control
          const { interruptSubAgentLoop } = await import('../agents/delegate-tool.js');
          const ok = interruptSubAgentLoop(instanceId);
          return ok
            ? `Sub-agent "${instanceId}" interrupted.`
            : `No running sub-agent found with instance ID "${instanceId}". Use list_sub_agents to see available instances.`;
        }
        agentLoop.interrupt();
        return 'Agent execution interrupted.';
      } catch (err) {
        return `Error interrupting agent: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * current_session — show which session is currently active.
 */
export function createCurrentSessionTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'current_session',
    description:
      '查看当前活跃会话信息：会话 ID、类型（normal/precise）、所属渠道和创建时间。在切换或列出会话之前，先确认自己当前在哪个会话中。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const fs = await import('node:fs');
        const sessionDir = (agentLoop as any).sessionDir as string;
        const sessionId = path.basename(sessionDir);

        // 读取 meta.json 获取 session 元信息
        let type = 'unknown';
        let channel: string | undefined;
        let createdAt = 'unknown';
        try {
          const metaPath = path.join(sessionDir, 'meta.json');
          if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            type = meta.type ?? 'unknown';
            channel = meta.channel;
            createdAt = meta.createdAt ?? 'unknown';
          }
        } catch { /* meta.json may not exist for legacy sessions */ }

        const lines = [
          `Current session:`,
          `- ID: ${sessionId}`,
          `- Type: ${type}`,
          `- Channel: ${channel ?? '(none)'}`,
          `- Created: ${createdAt}`,
          `- Directory: ${sessionDir}`,
        ];

        if (channel) {
          lines.push(`\nThis session is bound to the "${channel}" channel. Use new_session to create a fresh session if needed.`);
        }

        return lines.join('\n');
      } catch (err) {
        return `Error getting current session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * session_stats — show current session statistics.
 */
export function createSessionStatsTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'session_stats',
    description: '查看当前会话的统计信息：轮次数、Token 使用量、压缩次数和上下文状态。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        // getTurnInfo requires current turnCount and tokensUsed.
        // Since we don't track these externally, use 0 as fallback.
        const info = agentLoop.getTurnInfo(0, 0);
        return JSON.stringify(info, null, 2);
      } catch (err) {
        return `Error getting session stats: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── Session management tools (4) ──

/**
 * list_sessions — list all existing sessions.
 */
export function createListSessionsTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'list_sessions',
    description: '列出所有会话，包含创建时间、类型和渠道信息。当前活跃会话标有 ← current。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const { SessionManager } = await import('../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessions = await sm.list();

        if (sessions.length === 0) {
          return 'No sessions found. Use new_session to create one.';
        }

        const currentSessionId = path.basename((agentLoop as any).sessionDir as string);

        const lines = sessions.map((s) => {
          const typeLabel = s.type ?? 'normal';
          const channelLabel = s.channel ? ` [${s.channel}]` : '';
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ← current' : '';
          return (
            `${s.id}` +
            ` | created: ${s.createdAt}` +
            ` | updated: ${s.updatedAt}` +
            ` | type: ${typeLabel}${channelLabel}${marker}`
          );
        });

        return (
          `Sessions (${sessions.length} total, newest first):\n` +
          lines.map((l) => `  ${l}`).join('\n') +
          `\n\nUse switch_session to load a session, delete_session to remove one. ` +
          `⚠ The session marked "← current" is active and CANNOT be deleted.`
        );
      } catch (err) {
        return `Error listing sessions: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * new_session — create a brand-new session and switch to it immediately.
 */
export function createNewSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'new_session',
    description:
      '创建新会话并立即切换。当前对话上下文将被清空。可选 channel 参数生成渠道前缀的会话 ID（如 tui / feishu / webui）。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Optional channel name for the session ID prefix. Auto-detected from current session if omitted.',
        },
        type: {
          type: 'string',
          enum: ['normal', 'precise'],
          description: 'Session type. "precise" enables precise mode with keyword-based context filtering. Default: "normal".',
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const { SessionManager } = await import('../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessionType = (args.type as 'normal' | 'precise') ?? 'normal';
        let channel = (args.channel as string | undefined);

        const path = await import('node:path');
        const fs = await import('node:fs');

        // 自动检测当前 session 的渠道（飞书 → feishu, TUI → tui, WebUI → webui）
        if (!channel) {
          try {
            const currentSessionDir = (agentLoop as any).sessionDir as string;
            const metaPath = path.join(currentSessionDir, 'meta.json');
            if (fs.existsSync(metaPath)) {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              if (typeof meta.channel === 'string' && meta.channel.length > 0) {
                channel = meta.channel;
              }
            }
          } catch { /* 读取失败不阻塞 */ }
        }

        const session = await sm.create(sessionType, channel);
        const sessionDir = sm.getSessionDir(session.id);
        await agentLoop.switchSession(sessionDir);

        return (
          `New session created and activated:\n` +
          `- ID: ${session.id}\n` +
          `- Type: ${session.type}\n` +
          `- Channel: ${channel ?? '(auto: none detected)'}\n` +
          `- Created: ${session.createdAt}`
        );
      } catch (err) {
        return `Error creating new session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * switch_session — load and switch to an existing session.
 *
 * 注册链路：
 *   src/tools/runtime-control.ts（本文件）→ 工具实现
 *   → 注册到 ToolRegistry（factory.ts 中通过 registerSessionTools 调用）
 *   → tool_result 写入 conversation.jsonl（loop.ts append 阶段）
 *   → 出现在 Zone 3 (History) 的对话历史中
 *
 * ⚠️ tool_result 的文案会影响模型对当前会话状态的认知。
 *    如需修改返回文案，注意与 new_session、current_session 保持一致。
 */
export function createSwitchSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'switch_session',
    description:
      '按会话 ID 切换到已有会话。当前对话上下文替换为目标会话的历史记录。先用 list_sessions 查看可用会话及其 ID。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to switch to (e.g. "tui-20260627-120000-abcd"). Use list_sessions to find IDs.',
        },
      },
      required: ['session_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const sessionId = args.session_id as string;
        const { SessionManager } = await import('../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessionDir = sm.getSessionDir(sessionId);

        // Verify the session directory exists
        const fsPromises = await import('node:fs/promises');
        try {
          await fsPromises.access(sessionDir);
        } catch {
          const sessions = await sm.list();
          const ids = sessions.map((s) => s.id).join(', ');
          return `Error: Session "${sessionId}" not found. Available sessions: ${ids || '(none)'}`;
        }

        await agentLoop.switchSession(sessionDir);
        return `当前会话为 ${sessionId}`;
      } catch (err) {
        return `Error switching session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * delete_session — permanently delete a session and its data.
 */
export function createDeleteSessionTool(agentLoop: AgentLoop, cwd: string): Tool {
  return {
    name: 'delete_session',
    description:
      '永久删除指定会话及其全部对话数据，不可撤销。不能删除当前活跃的会话——需先切换到其他会话。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID to delete. Use list_sessions to find IDs. Cannot be the currently active session.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be explicitly set to true to confirm deletion.',
        },
      },
      required: ['session_id'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const path = await import('node:path');
        const sessionId = args.session_id as string;
        const confirm = args.confirm as boolean | undefined;

        // 保护当前活跃 session
        const currentSessionId = path.basename((agentLoop as any).sessionDir as string);
        if (sessionId === currentSessionId) {
          return (
            `⚠ Cannot delete the currently active session "${sessionId}". ` +
            `Use switch_session to switch to a different session first, then retry deletion.`
          );
        }

        if (confirm !== true) {
          return (
            `⚠ This will permanently delete session "${sessionId}" and all its data. ` +
            `This cannot be undone.\n` +
            `To confirm, call delete_session again with session_id="${sessionId}" and confirm=true.`
          );
        }

        const { SessionManager } = await import('../memory/session.js');
        const sm = new SessionManager(cwd);
        const sessionDir = sm.getSessionDir(sessionId);

        const fsPromises = await import('node:fs/promises');
        try {
          await fsPromises.access(sessionDir);
        } catch {
          return `Session "${sessionId}" not found (may have been already deleted).`;
        }

        await fsPromises.rm(sessionDir, { recursive: true, force: true });
        return `Session "${sessionId}" deleted.`;
      } catch (err) {
        return `Error deleting session: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── Permission whitelist management tools ──

/**
 * allow_tool — add a tool to the safety allowedTools whitelist.
 */
export function createAllowToolTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'allow_tool',
    description: '将工具加入安全白名单，加入后该工具不再需要用户确认即可执行。对危险工具列表中的工具同样生效。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to whitelist (e.g. "write", "bash")' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = args.name as string;
      if (!toolName) return 'Error: tool name is required.';

      try {
        const current = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        if (current.includes(toolName)) {
          return `Tool "${toolName}" is already in the allowlist.`;
        }
        current.push(toolName);
        configCenter.set('safety.allowedTools', current);
        await configCenter.save();
        return `Tool "${toolName}" added to allowlist. It will no longer require confirmation (effective immediately).`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * disallow_tool — remove a tool from the safety allowedTools whitelist.
 */
export function createDisallowToolTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'disallow_tool',
    description: '将工具从安全白名单中移除。若该工具在危险工具列表中，恢复需要用户确认才能执行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name to remove from the whitelist' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const toolName = args.name as string;
      if (!toolName) return 'Error: tool name is required.';

      try {
        const current = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        const idx = current.indexOf(toolName);
        if (idx === -1) {
          return `Tool "${toolName}" is not in the allowlist.`;
        }
        current.splice(idx, 1);
        configCenter.set('safety.allowedTools', current);
        await configCenter.save();
        return `Tool "${toolName}" removed from allowlist. It will require confirmation again if it is in the dangerousTools list.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_allowlist — show current allowed tools and commands.
 */
export function createListAllowlistTool(configCenter: RuntimeConfigCenter): Tool {
  return {
    name: 'list_allowlist',
    description: '查看当前安全白名单：allowedTools（免确认的工具列表）和 allowedCommands（免确认的 bash 命令模式列表）。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const tools = configCenter.get('safety.allowedTools') as unknown as string[] || [];
        const commands = configCenter.get('safety.allowedCommands') as unknown as string[] || [];

        const lines: string[] = ['=== Safety Whitelist ==='];
        lines.push(`\nAllowed Tools (skip confirmation):`);
        if (tools.length === 0) {
          lines.push('  (none)');
        } else {
          tools.forEach(t => lines.push(`  - ${t}`));
        }
        lines.push(`\nAllowed Commands (bash patterns, * = wildcard):`);
        if (commands.length === 0) {
          lines.push('  (none)');
        } else {
          commands.forEach(c => lines.push(`  - ${c}`));
        }
        lines.push(`\nUse allow_tool / disallow_tool to manage tools.`);
        lines.push(`Use agent config set safety.allowedCommands.+ "<pattern>" to add command patterns.`);
        return lines.join('\n');
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ── Schedule task management tools ──

/**
 * add_task — create a new scheduled task on the HeartbeatScheduler.
 */
export function createAddTaskTool(
  scheduler: HeartbeatScheduler,
  /** 可选：自动检测当前渠道的函数（从 session meta.json 读取） */
  getChannel?: () => string | undefined,
  /** 可选：自动检测当前 sessionId 的函数 */
  getSessionId?: () => string | undefined,
  /** 可选：自动检测当前模式的函数（normal / companion） */
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'add_task',
    description:
      '创建新的定时任务。支持 5 种调度类型：\n' +
      '- "interval": 固定间隔触发，如每 5 分钟（intervalMs: 300000）\n' +
      '- "cron": 标准 5 字段 cron，如 "0 3 * * *"（每天凌晨 3 点）\n' +
      '- "daily": 每日定点触发，如 { time: "09:30" }\n' +
      '- "fixed-time": 在指定 ISO 时间单次触发\n' +
      '- "random": 每周期 N 次随机触发，支持时间窗口、可变次数范围和概率权重。如每日 0-5 次、仅 9-18 点、午间权重 3 倍（periodMs: 86400000, countRange: { min: 0, max: 5, distribution: "extremes" }, timeWindow: { start: "09:00", end: "18:00" }, timeWeights: [{ time: "12:00", weight: 3.0 }]）',
    companionDescription: '得记住他刚才说的东西，到时候叫他。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名称。' },
        scheduleType: {
          type: 'string',
          enum: ['interval', 'cron', 'daily', 'fixed-time', 'random'],
          description: '调度策略。',
        },
        schedule: {
          type: 'object',
          description: '与所选类型匹配的调度配置。' +
            'interval 示例: { intervalMs: 300000 }。' +
            'cron 示例: { expression: "0 */2 * * *" }。' +
            'daily 示例: { time: "09:00" }。' +
            'fixed-time 示例: { runAt: "2026-06-01T12:00:00.000Z" }。' +
            'random 示例: { periodMs: 86400000, count: 10, minIntervalMs: 300000, timeWindow: { start: "09:00", end: "18:00" }, countRange: { min: 0, max: 5, distribution: "extremes" }, timeWeights: [{ time: "12:00", weight: 3.0 }] }',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签，用于分组和筛选（默认 []）。',
        },
        channel: {
          type: 'string',
          description: '任务触发的目标渠道（如 "tui"、"webui"、"feishu"）。不传则自动检测当前会话渠道。',
        },
        fallback: {
          type: 'array',
          items: { type: 'string' },
          description: 'Channel fallback chain when the target channel is offline. E.g. ["webui", "tui"] tries webui first, then tui. If omitted, uses the global default (config.channelFallback, default: ["tui"]).',
        },
      },
      required: ['name', 'scheduleType', 'schedule'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const scheduleType = args.scheduleType as string;
      const schedule = args.schedule as Record<string, unknown>;
      const tags = (args.tags as string[]) ?? [];
      // 优先用模型指定的 channel，否则自动检测当前 session 的渠道
      const channel = (args.channel as string | undefined) ?? getChannel?.();
      const fallback = args.fallback as string[] | undefined;

      if (!['interval', 'cron', 'daily', 'fixed-time', 'random'].includes(scheduleType)) {
        return `Error: invalid scheduleType "${scheduleType}". Must be one of: interval, cron, daily, fixed-time, random.`;
      }

      try {
        const task = await scheduler.addTask(
          name,
          scheduleType as ScheduledTask['scheduleType'],
          schedule as unknown as ScheduledTask['schedule'],
          { type: 'callback', target: name },
          tags,
          channel,
          fallback,
        );

        // 自动检测并存储当前 sessionId（多会话渠道如飞书需要此字段来回复到正确的聊天）
        const sessionId = getSessionId?.();
        if (sessionId) {
          task.sessionId = sessionId;
          await scheduler.updateTask(task.id, { sessionId } as any);
        }

        // 自动检测并存储当前模式（正常/陪伴），实现模式间任务隔离
        const mode = getMode?.();
        if (mode) {
          task.mode = mode;
          await scheduler.updateTask(task.id, { mode } as any);
        }

        const nextRun = task.nextRunAt
          ? new Date(task.nextRunAt).toLocaleString()
          : 'N/A';

        const sessionInfo = sessionId ? `\n  Session: ${sessionId}` : '';
        const modeInfo = mode ? `\n  Mode: ${mode}` : '';

        return [
          `Task created: ${task.name} (id: ${task.id})`,
          `  Type: ${task.scheduleType}`,
          `  Channel: ${channel ?? '(auto)'}`,
          `  Next run: ${nextRun}`,
          `  Tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`,
          sessionInfo,
          modeInfo,
          `\nUse list_tasks to see all tasks, remove_task to delete.`,
        ].filter(Boolean).join('\n');
      } catch (err) {
        return `Error creating task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * remove_task — delete a scheduled task by id or name.
 */
export function createRemoveTaskTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'remove_task',
    description: '删除定时任务。优先按 id 精确删除，找不到时按 name 匹配。先用 list_tasks 确认要删除的任务 ID。',
    companionDescription: '他之前说的那个东西不用管了，不叫了。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id (returned by add_task or list_tasks). Preferred.' },
        name: { type: 'string', description: 'Task name. Falls back to name match if id not provided.' },
      },
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const taskId = args.id as string | undefined;
      const taskName = args.name as string | undefined;
      const mode = getMode?.();

      try {
        const findTask = (tasks: ScheduledTask[]) => {
          if (taskId) return tasks.find(t => t.id === taskId);
          if (taskName) return tasks.find(t => t.name === taskName);
          return undefined;
        };

        const tasks = scheduler.getTasks();
        const match = findTask(tasks);
        if (!match) {
          return `Task not found. Use list_tasks to see current tasks.`;
        }

        // 模式隔离：只能删除当前模式（或无模式限制）的任务
        if (mode && match.mode && match.mode !== mode) {
          return `Task "${match.name}" belongs to "${match.mode}" mode. Switch to that mode to delete it.`;
        }

        await scheduler.deleteTask(match.id);
        return `Task "${match.name}" (id: ${match.id}) deleted.`;
      } catch (err) {
        return `Error removing task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_tasks — list all scheduled tasks.
 */
export function createListTasksTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'list_tasks',
    description: '列出所有当前已注册的定时任务及其状态。',
    companionDescription: '得回想一下，有哪些需要提醒他的东西。现况如何？',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const mode = getMode?.();
        let tasks = scheduler.getTasks();
        // 按模式过滤：只显示当前模式的任务（或无模式限制的旧任务）
        if (mode) {
          tasks = tasks.filter(t => !t.mode || t.mode === mode);
        }
        if (tasks.length === 0) {
          return 'No scheduled tasks. Use add_task to create one.';
        }

        const lines: string[] = [`=== Scheduled Tasks (${tasks.length}) ===`];
        for (const t of tasks) {
          const nextRun = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : 'N/A';
          const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'never';
          const status = t.enabled ? 'enabled' : 'disabled';
          const randomExtra = t.scheduleType === 'random' && t.pendingSlots
            ? ` | slots left: ${t.pendingSlots.length}`
            : '';
          const channelInfo = t.channel ? ` | Channel: ${t.channel}` : '';

          lines.push(
            `\n  ${t.name} (id: ${t.id})`,
            `    Type: ${t.scheduleType} | Status: ${status} | Runs: ${t.runCount} | Errors: ${t.errorCount}${channelInfo}`,
            `    Last: ${lastRun} | Next: ${nextRun}${randomExtra}`,
          );
        }
        lines.push(`\nUse toggle_task to enable/disable, remove_task to delete.`);
        return lines.join('\n');
      } catch (err) {
        return `Error listing tasks: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * toggle_task — enable or disable a scheduled task.
 */
export function createToggleTaskTool(
  scheduler: HeartbeatScheduler,
  getMode?: () => 'normal' | 'companion' | undefined,
): Tool {
  return {
    name: 'toggle_task',
    description: '启用或禁用指定定时任务。禁用后任务保留但不触发。',
    companionDescription: '关于提醒这个事儿，他有别的想法。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id to toggle.' },
        enabled: { type: 'boolean', description: 'True to enable, false to disable.' },
      },
      required: ['id', 'enabled'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const taskId = args.id as string;
      const enabled = args.enabled as boolean;
      const mode = getMode?.();

      try {
        const tasks = scheduler.getTasks();
        const match = tasks.find(t => t.id === taskId);
        if (!match) {
          return `Task "${taskId}" not found. Use list_tasks to see current tasks.`;
        }

        // 模式隔离：只能切换当前模式（或无模式限制）的任务
        if (mode && match.mode && match.mode !== mode) {
          return `Task "${match.name}" belongs to "${match.mode}" mode. Switch to that mode to toggle it.`;
        }

        const ok = enabled
          ? await scheduler.enableTask(taskId)
          : await scheduler.disableTask(taskId);

        return `Task "${taskId}" ${enabled ? 'enabled' : 'disabled'}.`;
      } catch (err) {
        return `Error toggling task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * mcp_status — query MCP server connection states.
 */
export function createMcpStatusTool(mcpSystem: MCPSystem): Tool {
  return {
    name: 'mcp_status',
    description: '查询 MCP Server 连接状态。返回各 Server 名称、是否已连接。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const status = mcpSystem.getStatus();
      if (status.length === 0) return 'No MCP servers configured.';
      const lines = status.map(s => `- ${s.name}: ${s.connected ? 'connected' : 'disconnected'}`);
      return lines.join('\n');
    },
  };
}

// ============================================================
// Model channel tools (4)
// ============================================================

export function createListModelChannelsTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'list_model_channels',
    description: '列出所有模型通道，包含各通道的提供商、模型和角色映射关系。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      const registry = modelRouter.getRegistry();
      const channels = registry.listChannels();
      const roles = registry.listRoles();

      if (channels.length === 0) return 'No model channels configured. Using main provider for all roles.';

      const lines: string[] = ['## 通道列表'];
      for (const ch of channels) {
        const channelRoles = Object.entries(roles)
          .filter(([, chName]) => chName === ch.name)
          .map(([role]) => role);
        const roleStr = channelRoles.length > 0 ? ` → roles: ${channelRoles.join(', ')}` : '';
        lines.push(`- **${ch.name}**: ${ch.provider} / ${ch.model || '(default)'}${ch.description ? ` (${ch.description})` : ''}${roleStr}`);
      }

      lines.push('\n## 角色映射');
      for (const [role, channel] of Object.entries(roles)) {
        lines.push(`- ${role} → ${channel}`);
      }

      return lines.join('\n');
    },
  };
}

export function createAddModelChannelTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'add_model_channel',
    description: '新增模型通道。只需提供 name，provider 默认使用主通道提供商。之后可用 set_channel_model 修改提供商/模型。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name (e.g. "compression", "sub-agent")' },
        provider: { type: 'string', description: 'Provider type: anthropic/openai/deepseek/gemini/groq/xai/mistral/openrouter/moonshot/qwen/zhipu/minimax/mimo/local. Defaults to main channel provider.' },
        model: { type: 'string', description: 'Model name (optional, defaults to provider default)' },
        apiKey: { type: 'string', description: 'API key (optional)' },
        apiKeyEnv: { type: 'string', description: 'Env variable name for API key (optional)' },
        baseUrl: { type: 'string', description: 'Custom API base URL (optional)' },
        description: { type: 'string', description: 'Channel description (optional)' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const provider = args.provider as string;
      try {
        modelRouter.getRegistry().upsertChannel(name, {
          provider,
          model: args.model as string | undefined,
          apiKey: args.apiKey as string | undefined,
          apiKeyEnv: args.apiKeyEnv as string | undefined,
          baseUrl: args.baseUrl as string | undefined,
          description: args.description as string | undefined,
        });
        const info = modelRouter.getRegistry().getChannelInfo(name);
        return `Channel "${name}" added (${info?.provider}/${info?.model}). Use set_channel_role to map roles to this channel.`;
      } catch (err) {
        return `Error adding channel: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createRemoveModelChannelTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'remove_model_channel',
    description: '删除模型通道。主通道不可删除。原本指向该通道的角色自动回退到主通道。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要删除的通道名称' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      try {
        modelRouter.getRegistry().removeChannel(name);
        return `Channel "${name}" has been removed. Roles that pointed to it have been redirected to main.`;
      } catch (err) {
        return `Error removing channel: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createSetChannelModelTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'set_channel_model',
    description: '临时切换通道的提供商/模型（仅当前会话有效，不持久化）。重启后恢复原配置。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '通道名称' },
        provider: { type: 'string', description: 'Provider 类型' },
        model: { type: 'string', description: '模型名（可选，不填则用 provider 默认）' },
      },
      required: ['name', 'provider'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const registry = modelRouter.getRegistry();
        registry.setChannelModel(
          args.name as string,
          args.provider as string,
          args.model as string | undefined,
        );
        const info = registry.getChannelInfo(args.name as string);
        return `Channel "${args.name}" runtime model set to ${info?.provider}/${info?.model}. (Not persisted — reset on restart)`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createResetChannelModelTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'reset_channel_model',
    description: '将通道模型恢复为持久化配置（撤销 set_channel_model 的临时修改）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '通道名称' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      try {
        const registry = modelRouter.getRegistry();
        registry.resetChannelModel(args.name as string);
        const info = registry.getChannelInfo(args.name as string);
        return `Channel "${args.name}" reset to config: ${info?.provider}/${info?.model}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function createChannelInfoTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'model_channel_info',
    description: '查询指定模型通道的详细信息（提供商、模型、角色映射、类型）。先用 list_model_channels 获取可用通道名称。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '通道名称' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const registry = modelRouter.getRegistry();
      const info = registry.getChannelInfo(args.name as string);
      if (!info) return `Channel "${args.name}" not found. Use list_model_channels to see available channels.`;
      return [
        `Channel: ${info.name}${info.isMain ? ' (main)' : ''}`,
        `  Provider: ${info.provider}`,
        `  Model:    ${info.model}`,
        `  Type:     ${info.providerType}`,
        info.description ? `  Desc:     ${info.description}` : '',
        info.roles.length > 0 ? `  Roles:    ${info.roles.join(', ')}` : '  Roles:    (none)',
      ].filter(Boolean).join('\n');
    },
  };
}

export function createSetChannelRoleTool(modelRouter: ModelRouter): Tool {
  return {
    name: 'set_channel_role',
    description: '将角色映射到指定通道。角色类型：assessment（评估）、planning（规划）、compression（压缩）、sub-agent（子Agent）。一个通道可服务多个角色。',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色名（如 compression、sub-agent、planning 等）' },
        channel: { type: 'string', description: '通道名（须已通过 add_model_channel 创建）' },
      },
      required: ['role', 'channel'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const role = args.role as string;
      const channel = args.channel as string;
      try {
        modelRouter.getRegistry().setRoleMapping(role, channel);
        const allRoles = modelRouter.getRegistry().listRoles();
        const shared = Object.entries(allRoles)
          .filter(([, ch]) => ch === channel)
          .map(([r]) => r);
        return `Role "${role}" → channel "${channel}". Channel "${channel}" now serves: ${shared.join(', ')}.`;
      } catch (err) {
        return `Error setting role mapping: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

// ============================================================
// 陪伴模式工具
// ============================================================

/**
 * companion_mode — 陪伴模式切换（进入 / 退出）。
 */
export function createCompanionModeTool(
  agentLoop: AgentLoop,
  companionSessionManager: CompanionSessionManager,
): Tool {
  return {
    name: 'companion_mode',
    description:
      '陪伴模式开关与角色管理（只有此工具能做到）。' +
      '用户请求中出现的角色名必须填入 name 参数；没有角色名才省略。' +
      'action="activate"进入陪伴，action="create"新建角色并激活，action="deactivate"退出陪伴。' +
      '触发词：进入/退出/切换陪伴、找人聊天、创造角色。',
    companionDescription:
      '他离开了，道个别。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'create', 'deactivate'],
          description: 'activate=进入陪伴, create=新建角色并激活, deactivate=退出陪伴',
        },
        name: {
          type: 'string',
          description: '角色名。只要用户提到了就填进来，完全没提才可省略。',
        },
        persona: {
          type: 'string',
          description: '角色人设/性格描述（仅在 create 时需要），将写入 persona.md',
        },
        memory: {
          type: 'string',
          description: '初始记忆文本（仅在 create 时需要，可选），将写入 memory.md',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = args.action as string;
      const loop = agentLoop;

      try {
        switch (action) {
          case 'activate': {
            // 列出所有可用角色（= companion 下每个有 persona.md 的目录）
            const companionRoot = path.join(os.homedir(), '.agent', 'companion');
            const availableChars: string[] = (() => {
              try {
                return fs.readdirSync(companionRoot, { withFileTypes: true })
                  .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                  .map(e => e.name)
                  .filter(n => fs.existsSync(path.join(companionRoot, n, 'persona.md')));
              } catch { return []; }
            })();

            // 确定目标角色名
            const charName: string | null = (() => {
              if (typeof args.name === 'string' && args.name.trim()) return args.name.trim();
              if (availableChars.length === 1) return availableChars[0];
              if (availableChars.length === 0) return null;
              // 多个可用 → 优先上次用过的
              try {
                const last = fs.readFileSync(path.join(companionRoot, '.last-character'), 'utf-8').trim();
                if (last && availableChars.includes(last)) return last;
              } catch {}
              return availableChars[0];
            })();

            if (!charName) {
              return '还没有创建任何陪伴角色。请用 companion_mode action="create" 来创建第一个角色。';
            }

            const charDir = path.join(os.homedir(), '.agent', 'companion', charName);
            const personaFile = path.join(charDir, 'persona.md');
            if (!fs.existsSync(personaFile)) {
              const hint = availableChars.length
                ? `当前已有角色：${availableChars.join('、')}`
                : '当前还没有任何角色';
              return [
                `角色「${charName}」尚未创建。${hint}。`,
                '请向用户确认以下信息后，用 companion_mode action="create" 来初始化：',
                '  - persona：角色人设/性格描述（必填）',
                '  - memory：初始记忆（可选，如角色背景故事、关键关系等）',
                '用户确认后你直接调 create，写完后会自动激活。',
              ].join('\n');
            }

            // 角色存在但缺少 world-engine.json → 自动生成最小默认配置
            const charConfig = path.join(charDir, 'world-engine.json');
            if (!fs.existsSync(charConfig)) {
              const defaultConfig = {
                enabled: true,
                worldName: '我们的世界',
                companion: { name: charName, desc: '' },
                ticker: {
                  heartbeatMs: 5000,
                  timeScale: 1,
                  weatherAvgHours: 4,
                  overcastHoursBeforeRain: 1.5,
                },
              };
              fs.writeFileSync(charConfig, JSON.stringify(defaultConfig, null, 2), 'utf-8');
            }

            // 拿到 CompanionRouter 单例
            const companionRouter = switchRouter('companion');

            if (loop.activeRouter.name === 'companion') {
              // 已在陪伴模式 → 同角色提示，不同角色手动 deactivate→activate
              const currentName = (loop.activeRouter as any).activeCompanionName || '';
              if (currentName === charName) {
                clearPromptCache();
                return `已在情感陪伴模式（${charName}）中 💫`;
              }
              await loop.activeRouter.onDeactivate?.(loop);
              (companionRouter as any).activeCompanionName = charName;
              await companionRouter.onActivate?.(loop);
            } else {
              // 从正常模式进入 → 设名字后 syncRouter 自动触发 onActivate
              (companionRouter as any).activeCompanionName = charName;
              await loop.syncRouter();
            }
            clearPromptCache();

            // 记住本次选择，下次不指定名称时自动用
            try {
              fs.writeFileSync(
                path.join(os.homedir(), '.agent', 'companion', '.last-character'),
                charName, 'utf-8'
              );
            } catch { /* 写入失败不影响激活 */ }

            return `已切换到情感陪伴模式（${charName}）💫 现在可以放松聊天了。想退出时告诉我就好。`;
          }

          case 'create': {
            const charName = typeof args.name === 'string' && args.name.trim()
              ? args.name.trim()
              : null;
            if (!charName) return '请提供角色名（name 参数）。';

            const persona = typeof args.persona === 'string' && args.persona.trim()
              ? args.persona.trim()
              : null;
            if (!persona) return '请提供角色人设（persona 参数），这是必填的。可以请用户描述这个角色的性格、背景、说话方式等。';

            const memory = typeof args.memory === 'string' && args.memory.trim()
              ? args.memory.trim()
              : null;

            // 创建角色目录与文件
            const charDir = path.join(os.homedir(), '.agent', 'companion', charName);

            // 角色已存在 → 拒绝覆盖，提示用 activate
            if (fs.existsSync(path.join(charDir, 'persona.md'))) {
              return `角色「${charName}」已存在。若要切换到此角色，请用 companion_mode action="activate" name="${charName}"。`;
            }

            fs.mkdirSync(charDir, { recursive: true });
            fs.writeFileSync(path.join(charDir, 'persona.md'), persona, 'utf-8');
            if (memory) {
              fs.writeFileSync(path.join(charDir, 'memory.md'),
                `# ${charName} 的记忆\n\n${memory}`, 'utf-8');
            }
            // 生成最小默认 world-engine.json（不依赖任何外部模板）
            const charConfig = path.join(charDir, 'world-engine.json');
            if (!fs.existsSync(charConfig)) {
              const defaultConfig = {
                enabled: true,
                worldName: '我们的世界',
                companion: { name: charName, desc: '' },
                ticker: {
                  heartbeatMs: 5000,
                  timeScale: 1,
                  weatherAvgHours: 4,
                  overcastHoursBeforeRain: 1.5,
                },
              };
              fs.writeFileSync(charConfig, JSON.stringify(defaultConfig, null, 2), 'utf-8');
            }

            // 创建完直接激活
            const companionRouter = switchRouter('companion');
            if (loop.activeRouter.name === 'companion') {
              // 已在陪伴模式 → 手动 deactivate→activate（syncRouter 检测不到 router 名变化）
              await loop.activeRouter.onDeactivate?.(loop);
              (companionRouter as any).activeCompanionName = charName;
              await companionRouter.onActivate?.(loop);
            } else {
              (companionRouter as any).activeCompanionName = charName;
              await loop.syncRouter();
            }
            clearPromptCache();

            // 记住本次选择
            try {
              fs.writeFileSync(
                path.join(os.homedir(), '.agent', 'companion', '.last-character'),
                charName, 'utf-8'
              );
            } catch { /* ignore */ }

            const created = [
              `✅ 角色「${charName}」已创建并激活`,
              `  - ${path.join(charDir, 'persona.md')}（人设）`,
            ];
            if (memory) created.push(`  - memory.md（初始记忆）`);
            if (fs.existsSync(charConfig)) created.push(`  - world-engine.json`);
            return created.join('\n');
          }

          case 'deactivate': {
            if (loop.activeRouter.name !== 'companion') {
              return '当前已是正常模式，无需退出。';
            }

            const companionDir = (loop as any).sessionDir as string;

            // JSONL 清理：移除触发切换的用户消息（tool 专属逻辑）
            try {
              const jsonlPath = path.join(companionDir, 'conversation.jsonl');
              if (fs.existsSync(jsonlPath)) {
                const content = fs.readFileSync(jsonlPath, 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());
                if (lines.length > 0) {
                  try {
                    const last = JSON.parse(lines[lines.length - 1]);
                    if (last.role === 'user') {
                      lines.pop();
                      fs.writeFileSync(jsonlPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
                    }
                  } catch { /* JSON 解析失败 */ }
                }
              }
            } catch { /* 文件操作失败不阻塞 */ }

            // 通过 Router 切换模式（自动恢复 normal session）
            switchRouter('normal');
            await loop.syncRouter();
            clearPromptCache();

            return '已退出情感陪伴模式，恢复正常模式 ✓';
          }

          default:
            return `未知操作: "${action}"。支持的操作: activate, deactivate。`;
        }
      } catch (err) {
        return `陪伴模式操作失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * reset_companion_session — 重置陪伴 session，清空所有陪伴记忆。
 * 仅在陪伴模式下可用。
 */
export function createResetCompanionSessionTool(
  agentLoop: AgentLoop,
  companionSessionManager: CompanionSessionManager,
): Tool {
  return {
    name: 'reset_companion_session',
    description: '清空陪伴记忆并开启新对话。触发词：清空记忆、重新开始、开新对话、启动新会话、重置会话。',
    companionDescription:
      '这样可以和他重新聊聊了。',
    inputSchema: {
      type: 'object',
      properties: {
        greeting: { type: 'string', description: '新对话第一句问候语' },
      },
      required: ['greeting'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const loop = agentLoop;
      if (loop.activeRouter?.name !== 'companion') {
        return '当前不在情感陪伴模式下。请先进入陪伴模式后再重置。';
      }

      try {
        const companionDir = await companionSessionManager.reset();
        await loop.switchSession(companionDir);
        clearPromptCache();
        (loop as any)._sessionSwitched = companionDir;
        const greeting = (args.greeting as string) || '你好，很高兴认识你。';
        return greeting;
      } catch (err) {
        return `重置陪伴 session 失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
