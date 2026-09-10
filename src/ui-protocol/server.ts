// ============================================================
// UI 协议层 — UiProtocolServer 核心路由
// ============================================================
// 职责：
//  1. registerDomain(domain, handler) 注册领域处理器
//  2. 按 method 前缀（<domain>.<action>）分发请求
//  3. 响应关联：通过 adapter + request id 将结果回传给正确的客户端
//  4. emitEvent / broadcast：向全部或指定 adapter 推送事件
//  5. 错误包装：未知域 / 未知方法 / 处理器异常 → UiError
//
// 协议服务器不感知具体传输：任何实现了 UIAdapter 的适配器
// （InProc / WebSocket / 未来渠道）都能 attach 进来。
// ============================================================

import type { UIAdapter } from './adapter.js';
import {
  type UiMessage,
  type UiRequest,
  type UiResponse,
  type UiEvent,
  type UiError,
  type RequestId,
  type ProtocolMeta,
  UI_PROTOCOL_VERSION,
} from './types.js';

// ────────────────────────────────────────────────────────────
// 领域处理器类型
// ────────────────────────────────────────────────────────────

/** 领域动作处理器：接收 params，返回 result（可异步） */
export type DomainAction = (
  params: unknown,
  ctx: RequestContext,
) => unknown | Promise<unknown>;

/** 领域处理器：action 名 → 处理器 */
export type DomainHandler = Record<string, DomainAction>;

/** 请求上下文（传递给领域处理器） */
export interface RequestContext {
  /** 发起请求的客户端适配器 */
  adapter: UIAdapter;
  /** 服务器引用（可广播事件等） */
  server: UiProtocolServer;
}

// ────────────────────────────────────────────────────────────
// UiProtocolServer
// ────────────────────────────────────────────────────────────

export class UiProtocolServer {
  /**
   * 已注册领域：<domain> → { <action>: handler }
   *
   * 注意：dispatch **不直接读这里**，而是读 methodTables。原因见下。
   */
  private domains = new Map<string, DomainHandler>();

  /**
   * 协议方法表：<domain> → { <action> → handler }，registerDomain 时快照。
   *
   * 为什么要在注册时快照一份，而不是 dispatch 时直接 `handler[action]`：
   * 域工厂常把生命周期方法（如 config.dispose）一并挂在 handler 对象上，
   * 属性访问不受 enumerable 影响 —— 只要挂在同一个对象上，就既能被
   * `handler[action]` 取到（= 可被任意客户端远程调用），又会被
   * `Object.keys` 枚举进能力清单。快照只收录注册那一刻的**可枚举**
   * 属性，等于把「协议方法面」冻结成一个显式契约：后挂的、不可枚举的
   * 东西一律不是协议方法，既不可调用也不上报。
   */
  private methodTables = new Map<string, Map<string, DomainAction>>();

  /** 已接入的客户端适配器 */
  private adapters = new Set<UIAdapter>();

  /** 默认错误码 */
  private static readonly ERR_UNKNOWN_DOMAIN = 'UNKNOWN_DOMAIN';
  private static readonly ERR_UNKNOWN_METHOD = 'UNKNOWN_METHOD';
  private static readonly ERR_INTERNAL = 'INTERNAL_ERROR';

  /** 内建 meta 域（版本/能力协商，P5-3）；客户端注册的 'meta' 会覆盖 */
  private readonly builtinMeta: DomainHandler;

  constructor() {
    this.builtinMeta = {
      /**
       * protocol.meta.get —— 版本/能力协商。
       * 返回协议版本、已注册域、每域可用方法（运行时实时生成，
       * 反映当前装配状态；schemas 保留为扩展点）。
       */
      get: (): ProtocolMeta => this.buildMeta(),
    };
    // 走 registerDomain（而非直接 domains.set）：内建域同样需要进入
    // 方法表，否则 meta.get 既不可调用也不在 listDomains 中。
    this.registerDomain('meta', this.builtinMeta);
  }

  /** 实时生成能力描述（读当前注册状态，不含自身） */
  private buildMeta(): ProtocolMeta {
    const domains: string[] = [];
    const methods: Record<string, string[]> = {};
    for (const [domain, table] of this.methodTables) {
      if (domain === 'meta') continue; // 自身不列入能力清单
      domains.push(domain);
      methods[domain] = [...table.keys()];
    }
    return { version: UI_PROTOCOL_VERSION, domains, methods };
  }

  // ── 领域注册 ─────────────────────────────────────────────

  /**
   * 注册一个领域处理器。
   * @param domain 领域名（如 'config'，用于解析 method 'config.get'）
   * @param handler action 名 → 处理器 的映射
   */
  registerDomain(domain: string, handler: DomainHandler): this {
    this.domains.set(domain, handler);
    // 只快照可枚举属性 —— 生命周期方法（不可枚举）不进入协议方法面
    this.methodTables.set(domain, new Map(Object.entries(handler)));
    return this;
  }

  /** 注销一个领域 */
  unregisterDomain(domain: string): void {
    this.domains.delete(domain);
    this.methodTables.delete(domain);
  }

  /** 是否已注册某领域 */
  hasDomain(domain: string): boolean {
    return this.domains.has(domain);
  }

  /** 当前已注册领域名列表 */
  listDomains(): string[] {
    return [...this.domains.keys()];
  }

  // ── 适配器接入 ───────────────────────────────────────────

  /** 接入一个客户端适配器并绑定消息处理 */
  attach(adapter: UIAdapter): this {
    if (this.adapters.has(adapter)) return this;
    this.adapters.add(adapter);
    adapter.onMessage((msg) => {
      this.handleMessage(adapter, msg).catch((err) => {
        // 顶层兜底：向客户端回一个内部错误
        if (msg.kind === 'request') {
          adapter.send(this.errorResponse(msg.id, UiProtocolServer.ERR_INTERNAL, err));
        }
      });
    });
    return this;
  }

  /** 移除一个客户端适配器 */
  detach(adapter: UIAdapter): void {
    this.adapters.delete(adapter);
  }

  /** 当前接入的适配器数量 */
  get adapterCount(): number {
    return this.adapters.size;
  }

  // ── 消息处理与分发 ───────────────────────────────────────

  /**
   * 处理来自某适配器的一条消息。
   * - request → 分发到领域处理器 → 回响应
   * - response / event → 忽略（服务器不消费客户端响应）
   */
  async handleMessage(adapter: UIAdapter, message: UiMessage): Promise<void> {
    if (message.kind !== 'request') return;
    await this.dispatch(adapter, message);
  }

  /** 将请求分发到对应领域处理器，并回传响应 */
  private async dispatch(adapter: UIAdapter, request: UiRequest): Promise<void> {
    const { id, method, params } = request;
    const dotIdx = method.indexOf('.');
    const domainName = dotIdx > 0 ? method.slice(0, dotIdx) : method;
    const actionName = dotIdx > 0 ? method.slice(dotIdx + 1) : '';

    const table = this.methodTables.get(domainName);
    if (!table) {
      adapter.send(
        this.errorResponse(id, UiProtocolServer.ERR_UNKNOWN_DOMAIN, `Unknown domain: "${domainName}"`),
      );
      return;
    }

    // 只认注册时快照的方法表：生命周期方法（如 config.dispose）
    // 即便挂在 handler 对象上，也不在表内 → 不可被远程调用。
    const action = table.get(actionName);
    if (!action) {
      adapter.send(
        this.errorResponse(id, UiProtocolServer.ERR_UNKNOWN_METHOD, `Unknown method: "${method}"`),
      );
      return;
    }

    const ctx: RequestContext = { adapter, server: this };
    try {
      const result = await action(params, ctx);
      adapter.send(this.okResponse(id, result));
    } catch (err) {
      adapter.send(
        this.errorResponse(id, UiProtocolServer.ERR_INTERNAL, err, {
          method,
          domain: domainName,
        }),
      );
    }
  }

  // ── 事件推送 ─────────────────────────────────────────────

  /**
   * 向指定适配器（或全部）推送一条事件。
   * @param type 事件类型（如 'message.text'）
   * @param payload 事件数据
   * @param target 可选：仅推送给该适配器；缺省广播给所有
   */
  emit(type: string, payload?: unknown, target?: UIAdapter): void {
    const event: UiEvent = { kind: 'event', type, payload };
    if (target) {
      target.send(event);
      return;
    }
    for (const adapter of this.adapters) {
      adapter.send(event);
    }
  }

  /** 广播事件给所有接入的适配器（emit 的别名，语义更明确） */
  broadcast(type: string, payload?: unknown): void {
    this.emit(type, payload);
  }

  // ── 响应构造 ─────────────────────────────────────────────

  private okResponse(id: RequestId, result: unknown): UiResponse {
    return { kind: 'response', id, ok: true, result };
  }

  private errorResponse(
    id: RequestId,
    code: string,
    err: unknown,
    details?: unknown,
  ): UiResponse {
    const error: UiError = {
      code,
      message: err instanceof Error ? err.message : String(err),
    };
    if (details !== undefined) error.details = details;
    return { kind: 'response', id, ok: false, error };
  }
}
