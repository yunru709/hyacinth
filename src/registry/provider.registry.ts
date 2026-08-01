import { GenericRegistry, type RegistryItem } from './base.js';
import { ProviderRouter, type AssessmentInput } from '../provider/router.js';
import type { Provider } from '../provider/interface.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredProvider extends RegistryItem {
  name: string;
  provider: Provider;
  source?: string;
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

/**
 * ProviderRegistry — 带 enable/disable 能力的 Provider 路由注册表。
 *
 * 包装 ProviderRouter，在其基础上添加启用/禁用控制：
 * - 禁用的 Provider 不会参与路由
 * - 查询接口（get / list）仅返回已启用的 Provider
 */
export class ProviderRegistry extends GenericRegistry<RegisteredProvider> {
  private router: ProviderRouter;

  constructor(router?: ProviderRouter) {
    super();
    this.router = router ?? new ProviderRouter();
  }

  // ── 注册 / 注销 ──────────────────────────────────────────────

  register(item: RegisteredProvider): void {
    super.register(item);
    this.router.register(item.name, item.provider);
  }

  unregister(name: string): boolean {
    this.router.unregister(name);
    return super.unregister(name);
  }

  // ── 启用 / 禁用 ──────────────────────────────────────────────

  /** 禁用一个 Provider（将排除在路由之外） */
  disable(name: string): void {
    super.disable(name);
  }

  /** 启用一个之前禁用的 Provider */
  enable(name: string): void {
    super.enable(name);
  }

  // ── 查询（仅已启用） ──────────────────────────────────────────

  /** 获取指定 Provider（禁用的返回 undefined） */
  get(name: string): RegisteredProvider | undefined {
    return super.get(name);
  }

  /** 列出所有已启用的 Provider 名称 */
  list(): string[] {
    return this.getAll().map((r) => r.name);
  }

  // ── 路由代理 ─────────────────────────────────────────────────

  /**
   * 根据复杂度评估选择 Provider。
   *
   * 委托 ProviderRouter.route() 进行路由，但如果结果被禁用，
   * 则 fallback 到其他已启用的 Provider。
   */
  route(assessment: AssessmentInput): Provider {
    const result = this.router.route(assessment);

    // 检查路由结果对应的注册条目是否被禁用
    const regItem = this.findRegisteredProvider(result);
    if (regItem && this.isEnabled(regItem.name)) {
      return result;
    }

    // 路由结果被禁用或未找到，fallback 到第一个已启用的 Provider
    const enabled = this.getAll();
    if (enabled.length === 0) {
      throw new Error(
        'ProviderRegistry.route: No enabled providers available.',
      );
    }

    return enabled[0].provider;
  }

  // ── 手动覆盖代理 ─────────────────────────────────────────────

  /** 设置默认 Provider（手动覆盖） */
  setDefault(name: string): void {
    this.router.setDefault(name);
  }

  /** 清除手动覆盖，恢复自动路由 */
  clearDefault(): void {
    this.router.clearDefault();
  }

  // ── 路由信息 ─────────────────────────────────────────────────

  /** 获取当前路由模式信息 */
  getRoutingInfo() {
    return this.router.getRoutingInfo();
  }

  // ── 内部工具 ─────────────────────────────────────────────────

  /** 获取内部 ProviderRouter */
  getRouter(): ProviderRouter {
    return this.router;
  }

  /**
   * 在注册表中查找匹配给定 Provider 的条目。
   * 通过引用相等或 getProviderType 进行匹配。
   */
  private findRegisteredProvider(
    provider: Provider,
  ): RegisteredProvider | undefined {
    for (const [, item] of (this as any).items as Map<string, RegisteredProvider>) {
      if (item.provider === provider) return item;
    }
    // fallback: 通过 getProviderType 匹配
    const providerType = provider.getProviderType();
    for (const [, item] of (this as any).items as Map<string, RegisteredProvider>) {
      if (item.provider.getProviderType() === providerType) return item;
    }
    return undefined;
  }
}