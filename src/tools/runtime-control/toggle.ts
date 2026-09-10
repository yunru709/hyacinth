import type { Tool } from '../interface.js';
import type { ToolRegistry } from '../registry.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { RuntimeConfigCenter } from '../../runtime/config-center.js';
import type { AgentRegistry } from '../../agents/registry.js';

// Registry control tools (6) — tool/skill/sub-agent 开关与列表

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
          lines.push(`- ${agent.name}${idTag} [${status}] (enabled: ${enabled}): ${agent.description} (maxTurns: ${agent.maxTurns})`);
        }
      }

      return lines.join('\n');
    },
  };
}
