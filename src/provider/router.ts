import type { Provider } from './interface.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 路由评估输入 */
export interface AssessmentInput {
  complexity: 'low' | 'medium' | 'high';
}

/** 当前路由模式信息 */
export interface RoutingInfo {
  /** 当前使用的 Provider 名称 */
  providerName: string;
  /** 路由模式：'auto' | 'manual' */
  mode: 'auto' | 'manual';
  /** Provider 是否本地 */
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// ProviderRouter
// ---------------------------------------------------------------------------

/**
 * ProviderRouter — 在已注册的 Provider 之间进行动态路由。
 *
 * 支持：
 * - 按名称注册/注销/查询 Provider
 * - 手动覆盖默认 Provider（setDefault / clearDefault）
 * - 基于复杂度评估自动路由：
 *   - high → 优先在线 Provider
 *   - low / medium → 优先本地 Provider
 */
export class ProviderRouter {
  /** 注册表：名称 → Provider */
  private registry: Map<string, Provider> = new Map();

  /** 手动覆盖的默认 Provider 名称（为 null 时走自动路由） */
  private defaultName: string | null = null;

  // ---- 注册管理 -----------------------------------------------------------

  /** 按名称注册 Provider */
  register(name: string, provider: Provider): void {
    this.registry.set(name, provider);
  }

  /** 移除注册的 Provider */
  unregister(name: string): void {
    this.registry.delete(name);
  }

  /** 获取已注册的 Provider */
  get(name: string): Provider | undefined {
    return this.registry.get(name);
  }

  /** 列出所有已注册的 Provider 名称 */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  // ---- 手动覆盖 -----------------------------------------------------------

  /** 设置默认 Provider（手动覆盖） */
  setDefault(name: string): void {
    if (!this.registry.has(name)) {
      throw new Error(
        `ProviderRouter.setDefault: Provider "${name}" is not registered. ` +
        `Call register() first.`,
      );
    }
    this.defaultName = name;
  }

  /** 清除手动覆盖，恢复自动路由 */
  clearDefault(): void {
    this.defaultName = null;
  }

  // ---- 核心路由 -----------------------------------------------------------

  /**
   * 根据复杂度评估选择 Provider。
   *
   * 路由逻辑：
   * 1. 存在手动覆盖 → 返回指定 Provider
   * 2. complexity === 'high' → 优先第一个在线 Provider
   * 3. 其他情况 → 优先第一个本地 Provider
   * 4. 找不到匹配 → 返回第一个已注册 Provider
   * 5. 注册表为空 → 抛出错误
   */
  route(assessment: AssessmentInput): Provider {
    // 手动覆盖
    if (this.defaultName !== null) {
      const provider = this.registry.get(this.defaultName);
      if (!provider) {
        // 理论上不会进入这里（setDefault 已校验），但作为防御性代码保留
        throw new Error(
          `ProviderRouter.route: Default Provider "${this.defaultName}" ` +
          `is no longer registered.`,
        );
      }
      return provider;
    }

    // 自动路由
    if (this.registry.size === 0) {
      throw new Error(
        'ProviderRouter.route: No providers registered. ' +
        'Call register() before routing.',
      );
    }

    const preferOnline = assessment.complexity === 'high';

    const entries = Array.from(this.registry.entries());

    // 按偏好查找第一个匹配的 Provider
    for (const [, provider] of entries) {
      const isLocal = this.isLocalProvider(provider);
      if (preferOnline ? !isLocal : isLocal) {
        return provider;
      }
    }

    // 没有匹配类型的 Provider，fallback 到第一个已注册的
    return entries[0][1];
  }

  // ---- 路由信息 -----------------------------------------------------------

  /**
   * 获取当前路由模式信息。
   *
   * 注意：该方法在 route() 之前调用时，返回的是当前配置状态；
   * 在 route() 之后调用则反映上一次路由的实际结果。
   */
  getRoutingInfo(): RoutingInfo {
    let providerName: string;
    let mode: 'auto' | 'manual';
    let isLocal: boolean;

    if (this.defaultName !== null) {
      mode = 'manual';
      providerName = this.defaultName;
      const provider = this.registry.get(this.defaultName);
      isLocal = provider ? this.isLocalProvider(provider) : false;
    } else {
      mode = 'auto';
      // 自动模式下，优先报告在线 Provider（high 复杂度路径）
      const entries = Array.from(this.registry.entries());

      if (entries.length === 0) {
        return {
          providerName: '(none)',
          mode: 'auto',
          isLocal: false,
        };
      }

      // 找到第一个在线 Provider 作为感知名称
      const online = entries.find(([, p]) => !this.isLocalProvider(p));
      if (online) {
        providerName = online[0];
        isLocal = false;
      } else {
        providerName = entries[0][0];
        isLocal = true;
      }
    }

    return { providerName, mode, isLocal };
  }

  // ---- 内部工具 -----------------------------------------------------------

  /**
   * 判断 Provider 是否为本地部署。
   *
   * 优先通过 getCapabilities()?.isLocal 判断；
   * fallback: 通过 getProviderType() 返回值判断。
   */
  private isLocalProvider(provider: Provider): boolean {
    if (provider.getCapabilities) {
      return provider.getCapabilities().isLocal;
    }
    // fallback: 通过 type 判断
    const type = provider.getProviderType();
    return type === 'llamacpp' || type === 'local' || type === 'ollama';
  }
}