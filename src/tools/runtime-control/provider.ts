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
        name:       { type: 'string', description: 'Provider 类型：anthropic | openai | deepseek | gemini | qwen | zhipu | minimax | mimo | volcengine | groq | xai | mistral | openrouter | moonshot | local' },
        api_key:    { type: 'string', description: '可选：API key。未设置时使用环境变量。' },
        model:      { type: 'string', description: '可选：模型名。未设置时使用该提供商的默认模型。' },
        max_tokens: { type: 'number', description: '可选：该提供商的最大输出 Token 数。未设置时从模型目录或提供商配置自动推断。' },
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
 *   ③ 谁在用哪条通道 —— CHANNELS（通道注册表）+ 每条通道服务哪些调用点
 *
 * 输出契约：首行 `Route mode: <mode>`；含 `DECLARED (n)` 与 `CHANNELS (n)` 两节。
 *
 * ⚠️ 2026-10-01 通道统一：原第三节是 LOADED（ProviderRouter 的注册表），那用的是**老机制的
 * 命名空间** —— 里面那个 `main` 与通道的 `main` 同名却是两个独立对象，是"两套并存"最直观的
 * 误导源。改为直接列通道：它才是"谁在用哪个厂商/模型"的真源。
 */
export function createListProvidersTool(
  providerRouter: ProviderRouter,
  /** 通道注册表（经 ModelRouter 取）。缺省时该节降级为提示，不影响厂商层。 */
  modelRouter?: {
    getRegistry(): {
      listChannels(): Array<{ name: string; provider?: string; model?: string }>;
      getChannelInfo?(name: string): { provider: string; model: string; roles: string[] } | null;
      listRoles(): Record<string, string>;
    };
  },
): Tool {
  return {
    name: 'list_providers',
    description:
      '列出厂商与通道：① DECLARED＝配置里声明的全部厂商（标明是否可用、缺哪个环境变量，回答"我配了哪些"）'
      + '② CHANNELS＝已有的通道（各自用什么厂商/模型）并标出服务哪些调用点（回答"谁在用哪个模型"）。主对话所用通道标 *。',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>): Promise<string> {
      try {
        const routingInfo = providerRouter.getRoutingInfo();
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

        // ---- ② 通道层：谁在用哪条通道（通道名 → 厂商/模型 → 服务哪些调用点）----
        const channelRows: string[] = [];
        let chatChannel = '';
        try {
          const reg = modelRouter?.getRegistry();
          const roles = reg?.listRoles() ?? {};
          chatChannel = roles['chat'] ?? '';
          const channels = reg?.listChannels() ?? [];
          if (!reg || channels.length === 0) {
            channelRows.push('(通道注册表不可用)');
          } else {
            // 主对话所用通道排最前（最常关心），其余按名字排序
            const sorted = [...channels].sort((a, b) => (
              a.name === chatChannel ? -1 : b.name === chatChannel ? 1 : a.name.localeCompare(b.name)
            ));
            for (const c of sorted) {
              const info = reg.getChannelInfo?.(c.name) ?? null;
              const provider = info?.provider ?? c.provider ?? '?';
              const model = info?.model ?? c.model ?? '?';
              const served = info?.roles ?? [];
              const hasChat = served.includes('chat');
              const who = [hasChat ? '主对话' : '', ...served.filter((r) => r !== 'chat')]
                .filter(Boolean).join(', ');
              channelRows.push(
                `${c.name === chatChannel ? '* ' : '  '}${c.name.padEnd(13)}${`${provider}/${model}`.padEnd(31)}${who ? ` ← ${who}` : ''}`,
              );
            }
          }
        } catch (err) {
          channelRows.push(`(通道层不可用: ${err instanceof Error ? err.message : String(err)})`);
        }

        return [
          `Route mode: ${routingInfo.mode}`,
          '',
          `DECLARED (${declaredRows.length}) — 厂商（配置里声明的全部）`,
          ...declaredRows,
          '',
          `CHANNELS (${channelRows.length}) — 通道（谁在用哪个厂商/模型）`,
          ...channelRows,
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
