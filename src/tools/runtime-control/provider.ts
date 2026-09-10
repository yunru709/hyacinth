import type { Tool } from '../interface.js';
import type { AgentLoop } from '../../orchestrator/loop.js';
import type { ProviderRouter } from '../../provider/router.js';

// Provider tools (4)

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
          const { ProviderManager } = await import('../../provider/manager.js');
          const { getProviderConfigLoader } = await import('../../provider/config.js');
          const provCfg = getProviderConfigLoader().getProvider(name);
          const maxTokens = (args.max_tokens as number) || undefined;
          const config: import('../../types.js').ProviderConfig = {
            type: name as import('../../types.js').ProviderType,
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
