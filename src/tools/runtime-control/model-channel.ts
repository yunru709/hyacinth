import type { Tool } from '../interface.js';
import type { MCPSystem } from '../../mcp/system.js';
import type { ModelRouter } from '../../provider/model-router.js';

// Model channel tools (8) — MCP 状态 + 模型通道管理

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
        provider: { type: 'string', description: 'Provider type: anthropic/openai/deepseek/gemini/groq/xai/mistral/openrouter/moonshot/qwen/zhipu/minimax/mimo/volcengine/local. Defaults to main channel provider.' },
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
