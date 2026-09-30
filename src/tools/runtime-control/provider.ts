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
        name:       { type: 'string', description: 'Provider type: anthropic | openai | deepseek | gemini | qwen | zhipu | minimax | mimo | volcengine | groq | xai | mistral | openrouter | moonshot | local' },
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
 * list_providers — 两个视角合一（声明层 + 实例层）。
 *
 * 背景：旧实现只列 providerRouter（**运行时已实例化**的），于是
 *   - 声明了但没 key 的厂商 → 不显示
 *   - 声明了但还没被用过的 → 不显示
 *   - 而描述写的是"所有已注册" ⇒ 极易被误读成"配置没生效"（2026-10-01 实际踩到）。
 *
 * 现在回答三个问题：
 *   ① 我配了哪些 —— DECLARED（配置声明的全部）
 *   ② 哪些现在能用、差什么 —— 每个标 ready / no key（附缺失的环境变量名）
 *   ③ 手上真的有哪个 —— LOADED（router 注册表）+ active 标记
 *
 * 输出契约：首行 `Route mode: <mode>`；含 `DECLARED (n)` 与 `LOADED (n)` 两节。
 */
export function createListProvidersTool(providerRouter: ProviderRouter): Tool {
  return {
    name: 'list_providers',
    description:
      '列出提供商：① DECLARED＝配置里声明的全部（标明是否可用、缺哪个环境变量，回答"我配了哪些"）'
      + '② LOADED＝运行时已实例化的实例。当前活跃者标 *。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const routingInfo = providerRouter.getRoutingInfo();
        const loaded = providerRouter.list();
        // ⚠️ router 里注册的是**通道名**（main / compression …），不是厂商 id ——
        // 两个命名空间。active 标记必须按**实例类型**对齐回声明层，否则声明层永远标不上。
        const activeName = routingInfo.providerName;
        const activeType = providerRouter.get(activeName)?.getProviderType() ?? activeName;

        // ---- ① 声明层：配置里有哪些、哪些现在能用 ----
        // 可用性判定与 ProviderManager.getAvailableProviders 同源（同一套 envKeys/checkAvailability 约定），
        // 避免这里另造一套判定而与实际能否创建分叉。
        const declaredRows: string[] = [];
        try {
          const { getProviderConfigLoader } = await import('../../provider/config.js');
          const { listProviderFactories } = await import('../../provider/factory-registry.js');
          const factories = new Map(listProviderFactories());

          for (const meta of getProviderConfigLoader().getAll()) {
            const factory = factories.get(meta.id);
            const expectedKeys = factory?.envKeys ?? (factory?.meta ? [factory.meta.envKey] : [meta.envKey]);
            const check = factory?.checkAvailability
              ?? (() => expectedKeys.some((k) => k && process.env[k]));
            const ready = !!factory && check();
            const missing = expectedKeys.filter((k) => k && !process.env[k]);

            const state = !factory ? 'NO-FACTORY' : ready ? 'ready' : 'no-key';
            const detail = !factory
              ? '无法创建（检查 baseUrl / protocol 声明）'
              : ready
                ? `default=${meta.defaultModel ?? '?'}`
                : `needs ${missing.join(' or ') || 'API key'}`;
            declaredRows.push(`${meta.id === activeType ? '*' : ' '} ${meta.id.padEnd(12)} ${state.padEnd(10)} ${detail}`);
          }
        } catch (err) {
          // loader 未初始化（启动早期）等 —— 降级到只报实例层，不整段失败
          declaredRows.push(`(声明层不可用: ${err instanceof Error ? err.message : String(err)})`);
        }

        // ---- ② 实例层：运行时真的有哪个（通道名 → 厂商/模型）----
        const loadedRows = loaded.length
          ? loaded.map((name) => {
              const p = providerRouter.get(name);
              const detail = p ? ` -> ${p.getProviderType()}/${p.getModel()}` : '';
              return `${name === activeName ? '* ' : '  '}${name}${detail}`;
            })
          : ['(none)'];

        return [
          `Route mode: ${routingInfo.mode}`,
          '',
          `DECLARED (${declaredRows.length}) — 配置声明的全部`,
          ...declaredRows,
          '',
          `LOADED (${loaded.length}) — 运行时已实例化`,
          ...loadedRows,
        ].join('\n');
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
