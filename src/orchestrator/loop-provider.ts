/**
 * Provider 路由族（B4 拆出）——切换 Provider、动态注册、配置订阅、路由模式。
 *
 * 原为 loop.ts 的七个方法：toggleProvider / registerProvider / switchProvider /
 * tryCreateProviderFromConfig / subscribeConfig / switchToAutoRoute /
 * getProviderRoutingInfo（~345 行）。外部调用点（TUI / ui-protocol-session /
 * factory / switch_provider 工具）经 loop 同名方法转发，签名不变。
 * 行为零变更：纯搬移，`this.xxx` 参数化为 deps / 回调。
 */
import path from 'node:path';
import type { Provider } from '../provider/interface.js';
import type { ProviderRouter } from '../provider/router.js';
import type { ModelRouter, ModelRole } from '../provider/model-router.js';
import type { LifecycleSupervisor } from '../supervisor/shutdown.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { OutputHandler } from './loop.js';
import { ProviderManager } from '../provider/manager.js';
import { LocalProvider } from '../provider/local.js';
import { mainUserId } from '../provider/user-id.js';
import { getModelContextWindow } from '../setup/model-defaults.js';

/** Provider 路由族依赖快照（可变状态经访问器读写，每轮现取当前值） */
export interface ProviderDeps {
  providerRouter?: ProviderRouter;
  modelRouter?: ModelRouter;
  lifecycleSupervisor?: LifecycleSupervisor | null;
  configCenter?: RuntimeConfigCenter;
  outputHandler?: OutputHandler | null;
  /** 当前主 provider（实时读取） */
  getProvider: () => Provider;
  /** 当前激活 provider（Router 路由优先，实时读取） */
  getActiveProvider: () => Provider;
  /** 当前上下文 token 数（实时读取） */
  getLastContextTokens: () => number;
  /** 当前上下文上限（实时读取，switchProvider 裁剪判断用） */
  getCurrentMaxContextTokens: () => number;
  /** 当前会话目录（tryCreateProviderFromConfig 推导 userId 用） */
  getSessionDir: () => string;
}

/** switchProvider 执行后需要回写 loop 的可变状态 */
export interface ProviderSwitchResult {
  /** 新的主 provider（写回 loop.provider） */
  provider: Provider;
  /** 是否切换到本地模型（写回 loop.previousProviderWasLocal） */
  previousProviderWasLocal?: boolean;
  /** 裁剪后的上下文上限（写回 loop.maxContextTokens） */
  maxContextTokens?: number;
  /** 是否需要强制压缩（写回 loop.needsCompression） */
  needsCompression?: boolean;
}

/** 本地类 provider 类型集合 */
function isLocalType(t: string): boolean {
  return t === 'local' || t === 'llamacpp' || t === 'ollama';
}

/**
 * 切换 Provider 路由模式：manual ↔ auto（本地 ↔ 在线）。
 * 本地→在线：停止本地模型；在线→本地：按需拉起。
 * 返回需回写的状态（previousProviderWasLocal）。
 */
export function toggleProvider(deps: ProviderDeps): Pick<ProviderSwitchResult, 'previousProviderWasLocal'> | null {
  const { providerRouter, lifecycleSupervisor, configCenter } = deps;
  if (!providerRouter) return null;
  const info = providerRouter.getRoutingInfo();
  if (info.mode === 'manual') {
    providerRouter.clearDefault();
    return null;
  } else {
    const localProviders = providerRouter.list().filter(name => {
      const p = providerRouter?.get(name);
      const t = p?.getProviderType();
      return t === 'llamacpp' || t === 'local' || t === 'ollama';
    });
    const onlineProviders = providerRouter.list().filter(name => {
      const p = providerRouter?.get(name);
      const t = p?.getProviderType();
      return t !== 'llamacpp' && t !== 'local' && t !== 'ollama';
    });
    if (info.isLocal && onlineProviders.length > 0) {
      providerRouter.setDefault(onlineProviders[0]);
      // 从本地切走 → 停止本地模型
      if (lifecycleSupervisor) {
        const modelKey = configCenter?.get('provider.local.modelKey') as string || '';
        lifecycleSupervisor.stopModel(modelKey).catch(() => {});
      }
      return { previousProviderWasLocal: false };
    } else if (!info.isLocal && localProviders.length > 0) {
      providerRouter.setDefault(localProviders[0]);
      if (lifecycleSupervisor) {
        const existingBaseUrl = configCenter?.get('provider.local.baseUrl') as string;
        if (!existingBaseUrl) {
          const modelKey = configCenter?.get('provider.local.modelKey') as string || '';
          lifecycleSupervisor.startModelOnDemand(process.cwd(), modelKey)
            .catch(() => {});
        }
      }
      return { previousProviderWasLocal: true };
    }
    return null;
  }
}

/**
 * 切换到指定名称的 Provider（核心流程）：
 * 查路由表 → 未命中则自动检测本地服务 / 从配置创建 → 管理 lifecycle →
 * 回写主 provider → 同步 ModelRouter → 按新模型上限裁剪上下文。
 * 返回需回写 loop 的可变状态（调用方负责写回）。
 */
export async function switchProvider(
  deps: ProviderDeps,
  providerName: string,
  model?: string,
): Promise<ProviderSwitchResult> {
  const { providerRouter, modelRouter, lifecycleSupervisor, configCenter, outputHandler } = deps;
  if (!providerRouter) {
    throw new Error('ProviderRouter not available');
  }

  let newProvider = providerRouter.get(providerName);

  // 路由表命中同名实例但目标模型不同 → 按新 model 重建，避免复用旧实例导致换模型不生效
  if (newProvider && model && !isLocalType(newProvider.getProviderType())
    && newProvider.getModel() !== model) {
    const recreated = tryCreateProviderFromConfig(deps, providerName, model);
    // fail-fast：重建失败（配置段缺失 / apiKeyEnv 无法解析）时旧实例仍持有旧
    // model，静默保留会让 "切到 X" 实际继续用旧模型且 status 显示旧值——
    // 必须显式抛错让调用方（TUI/协议层）如实报告切换失败。
    if (!recreated) {
      throw new Error(
        `Cannot switch "${providerName}" to model "${model}": config section ` +
        `"provider.${providerName}" is missing or has no resolvable API key (apiKeyEnv).`,
      );
    }
    providerRouter.register(providerName, recreated);
    newProvider = recreated;
  }

  if (!newProvider && configCenter) {
    // 本地模型：跳过 configCenter，始终自动检测
    if (providerName === 'local' || providerName === 'llamacpp' || providerName === 'ollama') {
      const { getLocalProviderConfigLoader, detectLocalBackend } = await import('../provider/local-config.js');
      const localCfg = getLocalProviderConfigLoader();
      let detected = await detectLocalBackend();

      // 未检测到运行中的服务 → 尝试自动拉起（通过 lifecycle supervisor 管理进程）
      if (!detected && lifecycleSupervisor) {
        // 先试 Ollama
        const ollamaInfo = await lifecycleSupervisor.startOllamaOnDemand(process.cwd());
        if (ollamaInfo) {
          const { getOllamaEndpoints } = await import('../provider/local-config.js');
          detected = { backend: 'ollama', baseUrl: ollamaInfo.baseUrl, port: ollamaInfo.port ?? getOllamaEndpoints().port };
        } else {
          // 再试 llama.cpp
          const { getLocalProviderConfigLoader: getCfg } = await import('../provider/local-config.js');
          const cfg = getCfg();
          const modelKey = (configCenter?.get('provider.local.modelKey') as string)
            || cfg?.defaultModel || 'local';
          try {
            const info = await lifecycleSupervisor.startModelOnDemand(process.cwd(), modelKey);
            if (info) {
              detected = { backend: 'llamacpp', baseUrl: info.baseUrl, port: info.port ?? 8080 };
            }
          } catch { /* 启动失败 */ }
        }
      }

      if (!detected && !localCfg?.defaultModel) {
        throw new Error(
          '本地模型服务未配置。请安装 Ollama 或 llama.cpp，并确保服务正在运行。',
        );
      }

      // 检测到的优先，否则 fallback 到默认配置（getLocalProviderConfigLoader 永不返回 null）
      const baseUrl = detected?.baseUrl || localCfg?.baseUrl;
      const backend = detected?.backend || localCfg?.backend;

      // 模型名解析优先级：
      //   1. Ollama 后端 → 查询 /api/tags 获取真实模型列表，匹配配置或取第一个
      //   2. RuntimeConfigCenter 中已有的 provider.local.model（TUI /model 命令写入）
      //   3. 硬编码兜底 llama3.2
      let model: string;
      if (backend === 'ollama') {
        const { fetchOllamaModels, pickBestOllamaModel } = await import('../provider/local-config.js');
        const ollamaModels = await fetchOllamaModels();
        // 优先匹配运行时配置中的 model（TUI 切换时写入）或 localCfg 的 defaultModel
        const preferred = (configCenter?.get('provider.local.model') as string)
          || localCfg?.defaultModel
          || null;
        const best = pickBestOllamaModel(ollamaModels, preferred);
        if (best) {
          model = best;
        } else {
          // Ollama 在运行但没有任何模型 → 给出明确错误
          throw new Error(
            'Ollama is running but no models found. ' +
            'Run "ollama pull <model>" to download a model first.',
          );
        }
      } else {
        model = (configCenter?.get('provider.local.model') as string)
          || localCfg?.defaultModel
          || 'llama3.2';
      }

      try {
        newProvider = new LocalProvider({ baseUrl, model, backend });
        if (newProvider) {
          providerRouter.register(providerName, newProvider);
        }
      } catch {
        // fallback failed
      }
    } else {
      const created = tryCreateProviderFromConfig(deps, providerName, model);
      if (created) {
        newProvider = created;
        providerRouter.register(providerName, created);
      }
    }
  }

  if (!newProvider) {
    const available = providerRouter.list().join(', ');
    throw new Error(
      `Provider "${providerName}" not found. Available in router: ${available}. ` +
      `Use list_providers to see all options.`,
    );
  }

  const newType = newProvider.getProviderType();
  const isLocal = isLocalType(newType);

  const result: ProviderSwitchResult = { provider: newProvider };

  // 如果切换到本地模型，启动服务；如果从本地模型切走，停止服务
  if (lifecycleSupervisor) {
    const prevProvider = deps.getProvider();
    const prevType = prevProvider.getProviderType();
    const prevWasLocal = isLocalType(prevType);

    if (isLocal && !prevWasLocal) {
      const existingBaseUrl = configCenter?.get('provider.local.baseUrl') as string;
      if (existingBaseUrl) {
        // 模型已通过外部（如 tui 面板 /model/local_*）启动并写入配置
      } else {
        const modelKey = configCenter?.get('provider.local.modelKey') as string || '';
        try {
          const modelInfo = await lifecycleSupervisor?.startModelOnDemand(
            process.cwd(), modelKey,
          );
          if (modelInfo && newProvider && 'setBaseUrl' in newProvider && 'setModel' in newProvider) {
            (newProvider as any).setBaseUrl(modelInfo.baseUrl);
            (newProvider as any).setModel(modelInfo.modelName);
          }
        } catch {
          // 模型启动失败，仍然尝试切换（可能服务已在外部运行）
        }
      }
    } else if (!isLocal && prevWasLocal) {
      const modelKey = configCenter?.get('provider.local.modelKey') as string || '';
      lifecycleSupervisor.stopModel(modelKey).catch(() => {});
    }

    result.previousProviderWasLocal = isLocal;
  }

  // 同步主通道到 ModelRouter，确保 registry 中 main 通道持有最新 Provider
  modelRouter?.setMainProvider(newProvider, providerName);

  // 自动裁剪上下文到新模型上限
  const modelLimit = getModelContextWindow(
    newProvider.getProviderType(),
    newProvider.getModel(),
  );

  // 1. 如果当前上下文已经超过新模型上限 → 触发压缩
  if (deps.getLastContextTokens() > modelLimit) {
    result.maxContextTokens = modelLimit;
    result.needsCompression = true;
    if (configCenter) {
      // 仅内存更新，不持久化——避免覆盖用户自定义值
      configCenter.set('session.maxContext', modelLimit);
    }
    outputHandler?.onStatus?.(
      `Context (${deps.getLastContextTokens().toLocaleString()}) exceeds new model limit (${modelLimit.toLocaleString()}), will force compression on next turn`,
      'warn',
    );
  }
  // 2. 当前上下文没超，但 maxContextTokens 设置得比新模型上限高 → 只裁剪上限
  else if (deps.getCurrentMaxContextTokens() > modelLimit) {
    result.maxContextTokens = modelLimit;
    if (configCenter) {
      // 仅内存更新，不持久化——避免覆盖用户自定义值
      configCenter.set('session.maxContext', modelLimit);
    }
    outputHandler?.onStatus?.(
      `maxContextTokens updated: ${modelLimit.toLocaleString()} (model: ${newProvider.getModel()})`,
      'info',
    );
  }
  // 3. 当前上下文和新模型上限都够用 → 无需操作

  // 注意：不在依赖注入层写 configCenter.set('provider.active') + save()，
  // 避免共享同一 RuntimeConfigCenter 单例的其他 AgentLoop 被迫切换 provider。
  // 持久化由调用方（如 TUI /model 命令）显式负责。
  // "Provider switched to ..." 状态消息同样由调用方（AgentLoop.switchProvider）
  // 在状态回写完成后发出——若在此处提前发出，UI 随即触发的 state.get 刷新
  // 会读到旧的 activeProvider（竞态：状态栏停留在旧模型）。

  return result;
}

/** 从 RuntimeConfigCenter 中的配置 + 环境变量动态创建 Provider */
export function tryCreateProviderFromConfig(
  deps: ProviderDeps,
  providerName: string,
  modelOverride?: string,
): Provider | undefined {
  const configCenter = deps.configCenter;
  if (!configCenter) return undefined;

  const section = configCenter.get(`provider.${providerName}`);
  if (!section || typeof section !== 'object') return undefined;

  const { model, apiKeyEnv, baseUrl } = section as { model?: string; apiKeyEnv?: string; baseUrl?: string };
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  const isLocal = providerName === 'local' || providerName === 'llamacpp' || providerName === 'ollama';

  if (!apiKey && !isLocal) return undefined;

  try {
    const sessionDir = deps.getSessionDir();
    return ProviderManager.createProviderFromConfig({
      type: providerName as import('../types.js').ProviderType,
      apiKey: apiKey ?? '',
      model: modelOverride ?? model ?? '',
      baseUrl,
      userId: sessionDir ? mainUserId(path.basename(sessionDir)) : undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * 订阅 RuntimeConfigCenter 变更，让 update_config 即时生效。
 * provider.active / provider.*.model → 自动切换；
 * session.maxTurns / session.maxContext → 即时更新（经回调回写 loop）。
 */
export function subscribeConfig(
  deps: ProviderDeps,
  hooks: {
    /** 执行切换（loop.switchProvider 薄壳，保持重入守卫与状态回写在 loop 侧）；
     *  model 可选——config watch 路径需要把新模型一并传下去，避免只切 provider 不切模型 */
    switchProvider: (name: string, model?: string) => Promise<void>;
    /** 回写 maxTurns */
    setMaxTurns: (n: number) => void;
    /** 回写 maxContextTokens */
    setMaxContextTokens: (n: number) => void;
  },
): void {
  const { providerRouter, configCenter, outputHandler } = deps;
  if (!configCenter) return;

  /**
   * 把 catch 到的 err 归一成可读后缀。
   * 只报「switch failed」会丢掉真实原因——最常见的两种是「该厂商 apiKeyEnv 未配置」
   * （tryCreateProviderFromConfig 返回 undefined → switchProvider 抛
   * `Provider "X" not found`）与「provider.<name> 配置段缺失」。带出 message
   * 才能让用户直接看懂该去配 key 还是改 active。
   */
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  // provider.active 变更 → 自动切换 provider
  configCenter.watch('provider.active', (event) => {
    const name = event.newValue as string;
    if (!name || typeof name !== 'string') return;
    // 守卫：如果与当前 provider 相同，跳过，避免重复切换
    const currentType = deps.getActiveProvider().getProviderType();
    if (name === currentType) return;
    // 直接委托 switchProvider(name, model)：内部在 router 未注册类型名时，
    // 会从 configCenter 的 provider.<name> 段 tryCreateProviderFromConfig 创建
    // 并 register。旧实现用 `providerRouter.get(name)` 做守卫——类型名（volcengine
    // /deepseek…）初始未注册（router 只有 main/local），导致「改 active 但首选不跟随」。
    hooks.switchProvider(name, configCenter.get<string>(`provider.${name}.model`)).catch((err) => {
      outputHandler?.onStatus?.(
        `Config changed provider to "${name}" but switch failed: ${errText(err)}`,
        'error',
      );
    });
  });

  // provider.<name>.model 变更 → 如果当前 active provider 匹配，重新创建 provider 并切换
  configCenter.watch('provider.*.model', (event) => {
    const newModel = event.newValue as string;
    if (!newModel || typeof newModel !== 'string') return;
    if (!providerRouter || !configCenter) return;
    const activeName = configCenter.get<string>('provider.active');
    if (!activeName) return;

    // 解析路径 provider.X.model → 提取 X
    const watchPath = event.path as string;
    const parts = watchPath.split('.');
    if (parts.length < 3 || parts[0] !== 'provider' || parts[2] !== 'model') return;
    const changedProvider = parts[1];

    // 只响应当前 active provider 的 model 变更
    if (changedProvider !== activeName) return;

    // 幂等：运行时已经是该模型 → 说明这次变更正是 model.switch 自己写下的，
    // 无需再重建/再切换。旧实现无条件 unregister + 重建 + 再切一次，与显式切换
    // 并发竞争（两条写路径），是「切换丢失 / 状态栏停留旧模型」的成因之一。
    const existing = providerRouter.get(activeName);
    if (existing && !isLocalType(existing.getProviderType()) && existing.getModel() === newModel) return;

    // 先建后换：创建失败时保留旧实例，不能先 unregister 把路由表清空——
    // 否则 route() 会因 defaultName 悬空而抛错，整个 loop 崩掉。
    const created = tryCreateProviderFromConfig(deps, activeName, newModel);
    if (!created) {
      outputHandler?.onStatus?.(
        `Config changed model for "${activeName}" but provider rebuild failed: ` +
          `config section "provider.${activeName}" is missing or has no resolvable API key (apiKeyEnv)`,
        'error',
      );
      return;
    }
    providerRouter.register(activeName, created);

    hooks.switchProvider(activeName, newModel).catch((err) => {
      outputHandler?.onStatus?.(
        `Config changed model for "${activeName}" but switch failed: ${errText(err)}`,
        'error',
      );
    });
  });

  // 把 routeMode 投影到 router：唯一真相源是配置，router 的 defaultName
  // 只是它的投影，不独立存在。manual 时钉住 provider.active，route() 便不会
  // 再抢回注册表第一个。
  const applyRouteMode = (mode: string): void => {
    if (!providerRouter) return;
    if (mode === 'manual') {
      const activeName = configCenter.get<string>('provider.active');
      if (!activeName) return;
      if (providerRouter.get(activeName)) {
        providerRouter.setDefault(activeName);
      } else if (providerRouter.get('main')) {
        // 启动初期 router 只以 'main' 注册了当前活跃 Provider
        // （orchestrator-contributions：register('main', d.provider)），
        // provider.active 的类型名尚未注册 —— 此时钉 'main' 与钉 provider.active
        // 等价（'main' 按构造即当前活跃 Provider），否则钉住会被跳过。
        providerRouter.setDefault('main');
      }
    } else if (mode === 'auto') {
      providerRouter.clearDefault();
    }
  };

  configCenter.watch('provider.routeMode', (event) => {
    applyRouteMode(event.newValue as string);
  });

  // 电平触发补齐（治本）：watch 只在「变更」时回调，而启动路径里
  // RuntimeConfigCenter.initialize(defaults) + merge(cfg) 的 diff 发生在 watch
  // 注册之前（loop 创建晚于配置装配）—— 此时 routeMode 早已是最终值 manual，
  // 变更事件被永久错过 → defaultName 停留 null → 每轮 route() 抢回注册表第一个
  // Provider，用户持久化的 provider.active 在重启后静默丢失。
  // 故注册后立即按「当前值」应用一次，让持久化选择在启动时即生效。
  applyRouteMode(configCenter.get<string>('provider.routeMode') ?? 'auto');

  // session.maxTurns 变更 → 即时更新
  configCenter.watch('session.maxTurns', (event) => {
    if (typeof event.newValue === 'number' && event.newValue > 0) {
      hooks.setMaxTurns(event.newValue);
      outputHandler?.onStatus?.(`maxTurns updated to ${event.newValue}`, 'info');
    }
  });

  // session.maxContext 变更 → 即时更新（裁剪到当前模型上限）
  configCenter.watch('session.maxContext', (event) => {
    if (typeof event.newValue === 'number' && event.newValue > 0) {
      const activeP = deps.getActiveProvider();
      const modelLimit = getModelContextWindow(
        activeP.getProviderType(),
        activeP.getModel(),
      );
      const clamped = Math.min(event.newValue, modelLimit);
      hooks.setMaxContextTokens(clamped);
      if (clamped < event.newValue) {
        outputHandler?.onStatus?.(
          `maxContextTokens capped to ${clamped} (model limit: ${modelLimit})`,
          'warn',
        );
      } else {
        outputHandler?.onStatus?.(`maxContextTokens updated to ${clamped}`, 'info');
      }
    }
  });
}

/** 切换回自动路由模式 */
export function switchToAutoRoute(deps: ProviderDeps): void {
  deps.providerRouter?.clearDefault();
  deps.outputHandler?.onStatus?.('Switched to auto route mode', 'info');
}

/** 获取 Provider 路由信息 */
export function getProviderRoutingInfo(
  deps: ProviderDeps,
): { providerLabel: string; isLocal: boolean; mode: string } | null {
  if (!deps.providerRouter) return null;
  const info = deps.providerRouter.getRoutingInfo();
  return {
    providerLabel: info.providerName,
    isLocal: info.isLocal,
    mode: info.mode,
  };
}

/** 运行时切换模型来源（main | local）并持久化 */
export function setModelSource(
  deps: ProviderDeps,
  role: ModelRole,
  source: 'main' | 'local',
): void {
  const { modelRouter, configCenter } = deps;
  if (!modelRouter || !configCenter) return;
  const currentModels = configCenter.get('models') as any;
  if (currentModels) {
    currentModels[role] = { ...currentModels[role], source };
    configCenter.set('models', currentModels);
    configCenter.save().catch(() => {});
  }
}

/** 读取模型来源配置 */
export function getModelSources(
  deps: ProviderDeps,
): Record<ModelRole, 'main' | 'local'> | null {
  const { modelRouter, configCenter } = deps;
  if (!modelRouter || !configCenter) return null;
  const models = configCenter.get('models') as any;
  if (!models) return null;
  return {
    assessment: models.assessment?.source ?? 'main',
    planning: models.planning?.source ?? 'main',
    compression: models.compression?.source ?? 'main',
  };
}
