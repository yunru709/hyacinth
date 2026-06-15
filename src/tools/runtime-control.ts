import type { Tool } from './interface.js';
import type { ToolRegistry } from './registry.js';
import type { AgentLoop } from '../orchestrator/loop.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter } from '../provider/model-router.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { TrainingScheduler } from '../training/scheduler.js';
import type { HeartbeatScheduler } from '../schedule/scheduler.js';
import type { ScheduledTask } from '../schedule/types.js';
import type { MCPSystem } from '../mcp/system.js';

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
      'Switch the active provider. If api_key is provided, the provider is dynamically created and registered. ' +
      'Use list_providers to see already-registered names. Model name defaults to the provider\'s default model.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Provider type: anthropic | openai | deepseek | gemini | qwen | zhipu | minimax | mimo | groq | xai | mistral | openrouter | moonshot | local' },
        api_key: { type: 'string', description: 'Optional: API key for this provider. If not set, uses environment variable.' },
        model:   { type: 'string', description: 'Optional: model name. If not set, uses the provider\'s default model.' },
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
          const config = {
            type: name as import('../types.js').ProviderType,
            apiKey,
            model: model ?? provCfg?.defaultModel ?? 'unknown',
            baseUrl: provCfg?.baseUrl,
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
    description: 'List all registered provider names, their types, and current models.',
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
    description: 'Get detailed information about the currently active provider (type, model, capabilities). Shows fallback status when the primary provider has failed over.',
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
    description: 'Switch provider routing back to automatic mode. In auto mode, the system selects the best provider based on task complexity.',
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
    description: 'Enable or disable a specific tool. Disabled tools will not be available to the LLM.',
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
    description: 'List all registered tools with their enabled/disabled status.',
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
    description: 'Enable or disable a specific skill. Disabled skills will not be available to the LLM.',
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
    description: 'List all registered skills with their enabled/disabled status.',
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
    description: 'Enable or disable a specific sub-agent. Disabled sub-agents will not be available for delegation.',
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
    description: 'List all registered sub-agents with their enabled/disabled status and instance IDs. Use instance_id to target a specific spawned copy.',
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
    description: 'Clone an existing sub-agent for parallel execution on different tasks.',
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
    description: 'Create a custom sub-agent at runtime. Set persist=true to save to disk.',
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
    description: 'Modify an existing sub-agent\'s configuration at runtime. Updates are applied immediately (in-memory). Use instance_id to target a specific instance. Fields left unspecified remain unchanged. Note: name cannot be changed — destroy and re-create if you need to rename.',
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
    description: 'Delete a sub-agent instance and its session data. For spawned clones, removes only that clone.',
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
    description: 'Interrupt the currently running agent execution. Stops the agent and any in-progress provider requests. Use instance_id to target a specific running sub-agent.',
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
 * session_stats — show current session statistics.
 */
export function createSessionStatsTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'session_stats',
    description: 'Show current session statistics including turn count, token usage, compression count, and context info.',
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

/**
 * trigger_training — trigger training immediately regardless of schedule.
 */
export function createTriggerTrainingTool(trainingScheduler: TrainingScheduler): Tool {
  return {
    name: 'trigger_training',
    description: 'Trigger a training run immediately, bypassing the scheduled time. If preconditions are not met (e.g. no local model), training will fail.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const result = await trainingScheduler.triggerNow();
        return `Training triggered successfully.\n${result.summary}\n\nDetails:\n${JSON.stringify(result.run, null, 2)}`;
      } catch (err) {
        return `Training failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * cancel_training — cancel the currently running training process.
 */
export function createCancelTrainingTool(trainingScheduler: TrainingScheduler): Tool {
  return {
    name: 'cancel_training',
    description: 'Cancel the currently running training process if one is in progress.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const status = trainingScheduler.getStatus();
        if (!status.isTraining) {
          return 'No training is currently running.';
        }
        trainingScheduler.cancelTraining();
        return 'Training cancelled. The current run will be marked as cancelled.';
      } catch (err) {
        return `Error cancelling training: ${err instanceof Error ? err.message : String(err)}`;
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
    description: 'Add a tool to the safety allowedTools whitelist so it no longer requires confirmation. Works even for tools in the dangerousTools list.',
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
    description: 'Remove a tool from the safety allowedTools whitelist. It will require confirmation again if in dangerousTools.',
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
    description: 'Show the current safety whitelist: allowedTools (tools that skip confirmation) and allowedCommands (bash command patterns that skip confirmation).',
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
export function createAddTaskTool(scheduler: HeartbeatScheduler): Tool {
  return {
    name: 'add_task',
    description:
      'Create a new scheduled task. Supports 5 schedule types:\n' +
      '- "interval": fixed interval, e.g. every 5min (intervalMs: 300000)\n' +
      '- "cron": standard 5-field cron, e.g. "0 3 * * *" (daily at 3am)\n' +
      '- "daily": fixed time each day, e.g. { time: "09:30" }\n' +
      '- "fixed-time": one-shot at a specific ISO time\n' +
      '- "random": N random triggers per period, e.g. 10 times/day ({ periodMs: 86400000, count: 10 })',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable task name.' },
        scheduleType: {
          type: 'string',
          enum: ['interval', 'cron', 'daily', 'fixed-time', 'random'],
          description: 'Scheduling strategy.',
        },
        schedule: {
          type: 'object',
          description: 'Schedule config matching the chosen type. Examples:\n' +
            '  interval: { intervalMs: 300000 }\n' +
            '  cron: { expression: "0 */2 * * *" }\n' +
            '  daily: { time: "09:00" }\n' +
            '  fixed-time: { runAt: "2026-06-01T12:00:00.000Z" }\n' +
            '  random: { periodMs: 86400000, count: 10, minIntervalMs: 300000 }',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for grouping/filtering (default: []).',
        },
      },
      required: ['name', 'scheduleType', 'schedule'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const name = args.name as string;
      const scheduleType = args.scheduleType as string;
      const schedule = args.schedule as Record<string, unknown>;
      const tags = (args.tags as string[]) ?? [];

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
        );

        const nextRun = task.nextRunAt
          ? new Date(task.nextRunAt).toLocaleString()
          : 'N/A';

        return [
          `Task created: ${task.name} (id: ${task.id})`,
          `  Type: ${task.scheduleType}`,
          `  Next run: ${nextRun}`,
          `  Tags: ${tags.length > 0 ? tags.join(', ') : '(none)'}`,
          `\nUse list_tasks to see all tasks, remove_task to delete.`,
        ].join('\n');
      } catch (err) {
        return `Error creating task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * remove_task — delete a scheduled task by id or name.
 */
export function createRemoveTaskTool(scheduler: HeartbeatScheduler): Tool {
  return {
    name: 'remove_task',
    description: 'Delete a scheduled task by its id (preferred) or name.',
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

      try {
        if (taskId) {
          const deleted = await scheduler.deleteTask(taskId);
          return deleted
            ? `Task "${taskId}" deleted.`
            : `Task "${taskId}" not found. Use list_tasks to see current tasks.`;
        }

        if (taskName) {
          const tasks = scheduler.getTasks();
          const match = tasks.find(t => t.name === taskName);
          if (!match) {
            return `No task with name "${taskName}" found. Use list_tasks to see current tasks.`;
          }
          await scheduler.deleteTask(match.id);
          return `Task "${taskName}" (id: ${match.id}) deleted.`;
        }

        return 'Error: provide either "id" or "name" to identify the task.';
      } catch (err) {
        return `Error removing task: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/**
 * list_tasks — list all scheduled tasks.
 */
export function createListTasksTool(scheduler: HeartbeatScheduler): Tool {
  return {
    name: 'list_tasks',
    description: 'List all currently scheduled tasks with their status.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const tasks = scheduler.getTasks();
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

          lines.push(
            `\n  ${t.name} (id: ${t.id})`,
            `    Type: ${t.scheduleType} | Status: ${status} | Runs: ${t.runCount} | Errors: ${t.errorCount}`,
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
export function createToggleTaskTool(scheduler: HeartbeatScheduler): Tool {
  return {
    name: 'toggle_task',
    description: 'Enable or disable a scheduled task.',
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

      try {
        const ok = enabled
          ? await scheduler.enableTask(taskId)
          : await scheduler.disableTask(taskId);

        if (!ok) {
          return `Task "${taskId}" not found. Use list_tasks to see current tasks.`;
        }

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
    description: 'Query MCP server connection states. Returns each server name and whether it is connected.',
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
    description: 'List all model channels with provider, model, and role mappings.',
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
    description: 'Add a new model channel. Only name is required; provider defaults to main channel provider. Use set_channel_model to change provider/model later.',
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
    description: 'Remove a model channel. Main channel cannot be removed. Roles pointing to it revert to main.',
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
    description: 'Temporarily switch a channel provider/model (session-only, not persisted). Resets on restart.',
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
    description: 'Reset a channel model to its persisted config (undo set_channel_model).',
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
    name: 'channel_info',
    description: 'Get detailed info for a channel (provider, model, roles, type).',
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
    description: 'Map a role to a channel. Roles: assessment, planning, compression, sub-agent. One channel can serve multiple roles.',
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
