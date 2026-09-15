// ============================================================
// UI 协议层 — 模型域（model.*）
// ============================================================
// 覆盖 UI 对模型/提供商/通道的全部操作：
//   model.getActive         获取当前启用通道（provider/model/能力/思考模式）
//   model.listProviders     列出所有提供商（含当前活跃标记）
//   model.switch            切换主通道 provider + model
//   model.setThinking       开关思考/推理模式
//   model.listChannels      列出所有模型通道
//   model.upsertChannel     添加/更新通道
//   model.removeChannel     删除通道（main 除外）
//   model.setChannelModel   设置通道的 provider/model
//   model.resetChannelModel 重置通道为持久化配置
//   model.listRoles         列出角色→通道映射
//   model.getChannelInfo    查询单个通道详情
//
// channel/* 的协议写路径统一收敛到本域（WebUI 与 TUI 共用同一套
// model.*Channel 方法），配合 MODEL_CHANGE 事件广播实现跨 UI 同步。
//
// 依赖两个结构化接口（真实 ModelChannelRegistry / ProviderManager
// 天然兼容），保证协议层可独立测试、可替换实现。
// ============================================================

import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';
import type { ModelChannel, ProviderSummary, LocalModelEntry } from '../types.js';
import type { LoopLike } from './state.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实类兼容）
// ────────────────────────────────────────────────────────────

/** 通道配置（对应 ModelChannelRegistry 的 ChannelConfig） */
export interface ChannelConfigLike {
  provider?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  description?: string;
}

/** 通道详情（对应 getChannelInfo 返回） */
export interface ChannelInfoLike {
  name: string;
  provider: string;
  model: string;
  description?: string;
  roles: string[];
  isMain: boolean;
  providerType: string;
}

/** 最小 Provider 视图（getProviderType/getModel/getCapabilities/setThinking） */
export interface ProviderView {
  getProviderType(): string;
  getModel(): string;
  getCapabilities?(): { isLocal?: boolean; maxContextTokens?: number } | undefined;
  /** 设置思考/推理模式（真实 Provider 级，TUI 同源） */
  setThinking?(enabled: boolean, effort?: string | number): void;
}

/** ModelChannelRegistry 结构化接口 */
export interface ModelRegistryLike {
  listChannels(): Array<ChannelConfigLike & { name: string }>;
  upsertChannel(name: string, config: ChannelConfigLike): void;
  removeChannel(name: string): void;
  setChannelModel(name: string, provider: string, model?: string): void;
  resetChannelModel(name: string): void;
  getChannelInfo(name: string): ChannelInfoLike | null;
  getMainProvider(): ProviderView | null;
  getProviderType(): string;
  getModel(): string;
  getCapabilities?(): ProviderView['getCapabilities'] extends (...a: never[]) => infer R ? R : undefined;
  setThinking?(enabled: boolean, effort?: string | number): void;
  /** 列出角色→通道映射（channel/list 用；真实 ModelChannelRegistry 有） */
  listRoles?(): Record<string, string>;
  /** 设置角色→通道映射（channel/role 用；真实 ModelChannelRegistry 有） */
  setRoleMapping?(role: string, channelName: string): void;
}

/** ProviderManager 结构化接口 */
export interface ProviderManagerLike {
  switchProvider(config: {
    type: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    userId?: string;
  }): void;
}

/** 提供商元数据（对应 ProviderConfigLoader 的 ProviderMeta） */
export interface ProviderMetaLike {
  id: string;
  name: string;
  baseUrl?: string;
  defaultModel?: string;
  envKey?: string;
}

// ────────────────────────────────────────────────────────────
// 模型域选项
// ────────────────────────────────────────────────────────────

export interface ModelDomainOptions {
  /** 模型通道注册表（真实 ModelChannelRegistry） */
  registry: ModelRegistryLike;
  /** 主 Provider 管理器（真实 ProviderManager） */
  manager: ProviderManagerLike;
  /** 提供商元数据列表提供者（listProviders 数据源）。可选，缺省返回 []。 */
  listProvidersMeta?: () => ProviderMetaLike[];
  /** 本地模型列表提供者（listLocalModels 数据源；对应 LocalModelModule.list）。可选，缺省返回 []。 */
  listLocalModels?: () => LocalModelEntry[];
  /** 事件推送（绑定到 server.broadcast）。可选。 */
  emit?: (type: string, payload?: unknown) => void;
  /** 动态获取 AgentLoop（model.switch 委托 loop.switchProvider 用，因 loop 在 initialize 后才就绪）。可选。 */
  getLoop?: () => LoopLike | null;
  /** 动态获取当前活跃 Provider（model.setThinking 委托 provider.setThinking 用）。可选。 */
  getActiveProvider?: () => ProviderView | null;
  /** 本地模型配置写回调（model.setLocalConfig 用；对应 LocalModelModule / configCenter 持久化）。可选。 */
  configureLocalModel?: (config: { ollamaUrl?: string }) => void;
  /** 本地模型写操作（model.local* 用；对应 LocalModelModule 的 start/stop/switch/register/unregister/scan）。可选。 */
  localModelOps?: LocalModelOpsLike;
  /**
   * 配置中心（唯一真相源的写入端）。
   *
   * model.switch 是 provider 选择**唯一**的写入口：应用运行时后，由它把
   * provider.active / provider.<name>.model / provider.routeMode 落盘。
   * UI 不得再自行 setConfig——两端各写一份正是历史上「运行时与配置静默分叉」的根源。
   * 可选：registry-only 假 manager / 测试 mock 可不传（此时跳过持久化）。
   */
  configCenter?: ConfigWriterLike;
}

/** RuntimeConfigCenter 的结构化最小接口（避免协议层耦合运行时实现） */
export interface ConfigWriterLike {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  /** 落盘。缺省（registry-only mock / 只读注入）时仅更新内存运行时。 */
  save?(): Promise<void>;
}

/** 本地模型写操作接口（宽松类型，对应 LocalModelModule 写方法；协议层缺省 mock 可不实现） */
export interface LocalModelOpsLike {
  start?(name: string): Promise<{ name: string; state: string; port?: number; host?: string } | null>;
  stop?(name: string): Promise<void>;
  switch?(name: string): Promise<{ name: string; state: string; port?: number; host?: string } | null>;
  register?(options: Record<string, unknown>): unknown;
  unregister?(name: string): boolean;
  scanUnregistered?(): Promise<Array<{ name: string; modelFile: string; backend?: string }>>;
}

// ────────────────────────────────────────────────────────────
// 模型域工厂
// ────────────────────────────────────────────────────────────

export function createModelDomain(options: ModelDomainOptions): DomainHandler {
  const { registry, manager, listProvidersMeta = () => [], listLocalModels = () => [], emit, getLoop, getActiveProvider, configureLocalModel, localModelOps, configCenter } = options;

  /** 当前活跃 provider 类型 + 模型 */
  const currentActive = (): { provider: string; model: string } => ({
    provider: registry.getProviderType(),
    model: registry.getModel(),
  });

  return {
    // ── model.getActive ────────────────────────────────────
    getActive: () => {
      const main = registry.getMainProvider();
      const caps = main?.getCapabilities?.();
      const { provider, model } = currentActive();
      return {
        provider,
        model,
        providerLabel: provider,
        isLocal: caps?.isLocal ?? false,
        maxContextTokens: caps?.maxContextTokens,
      };
    },

    // ── model.sources ──────────────────────────────────────
    // 各角色模型来源（assessment/planning/compression → main|local），
    // 对应 TUI /models 展示 loop.getModelSources()。
    sources: (): { sources: Record<string, 'main' | 'local'> | null } => {
      const loop = getLoop?.();
      if (!loop || typeof loop.getModelSources !== 'function') {
        return { sources: null };
      }
      return { sources: loop.getModelSources() ?? null };
    },

    // ── model.listProviders ────────────────────────────────
    listProviders: (): { providers: ProviderSummary[] } => {
      const { provider } = currentActive();
      const metas = listProvidersMeta();
      const providers: ProviderSummary[] = metas.map((m) => {
        const isLocal = m.id === 'local' || m.id === 'ollama';
        // 密钥是否配置：本地 provider 无 envKey 视为已就绪；在线 provider 检查 envKey 对应环境变量非空
        const configured = !m.envKey || !!process.env[m.envKey];
        // 就绪状态（协议层派生，前端只做映射展示）：
        // active=当前启用 > local=本地 > configured=已配密钥 > unconfigured=未配密钥
        const status = m.id === provider
          ? 'active'
          : isLocal
            ? 'local'
            : configured
              ? 'configured'
              : 'unconfigured';
        return {
          type: m.id,
          label: m.name,
          model: m.defaultModel ?? '',
          active: m.id === provider,
          isLocal,
          configured,
          status,
        };
      });
      // 确保当前活跃提供商总在列表中（即使元数据缺失）
      if (!providers.some((p) => p.type === provider)) {
        providers.push({
          type: provider,
          label: provider,
          model: registry.getModel(),
          active: true,
          configured: true,
          status: 'active',
        });
      }
      return { providers };
    },

    // ── model.switch ───────────────────────────────────────
    async switch(params: unknown): Promise<unknown> {
      const { provider, model, apiKey, baseUrl } = (params ?? {}) as {
        provider: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
      };
      if (!provider) throw new Error('model.switch requires "provider"');

      // 真实来源优先：委托 loop.switchProvider（与 TUI 同源，含本地模型
      // 检测/自动拉起/上下文裁剪/路由持久化）。loop 在 initialize 后才就绪，
      // 通过 getLoop 动态获取。
      const loop = getLoop?.();
      if (loop?.switchProvider) {
        await loop.switchProvider(provider, model);
      } else {
        // fallback：manager.switchProvider（registry-only 假 manager 或测试 mock）
        manager.switchProvider({ type: provider, model, apiKey, baseUrl });
      }

      // 同步更新 main 通道（保持 registry 与 loop/manager 一致）
      try {
        registry.setChannelModel('main', provider, model);
      } catch {
        // registry 同步失败不阻断切换（loop/manager 已生效）
      }

      // ── 持久化到唯一真相源（协议层是 provider 选择唯一的写入口）──────────
      // UI 不再自行 setConfig：历史上 TUI 先写盘、再发 model.switch，两条写路径
      // 并发触发 config watch 的隐式切换，导致「切换丢失 / 状态栏停留旧模型」。
      // routeMode 置 manual —— 用户显式选择了模型，就不该被 route() 的自动路由抢回去。
      if (configCenter) {
        try {
          if (model) configCenter.set(`provider.${provider}.model`, model);
          configCenter.set('provider.active', provider);
          configCenter.set('provider.routeMode', 'manual');
          await configCenter.save?.();
        } catch (err) {
          // 持久化失败不回滚已生效的运行时切换，但必须如实上报（否则重启后悄悄回退）
          emit?.(UI_EVENT.MODEL_CHANGE, {
            action: 'persistFailed',
            provider,
            model,
            message: (err as Error).message,
          });
        }
      }

      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'switch', provider, model });
      // 返回**生效值**而非请求值：UI 直接渲染这份快照，无需再发一次 state.get 自行比对
      // （旧实现「切完自己读回来比对」是 Switch incomplete 误报的来源）。
      const eff = currentActive();
      return { ok: true, provider: eff.provider, model: eff.model, requested: { provider, model } };
    },

    // ── model.setThinking ──────────────────────────────────
    setThinking(params: unknown): { ok: true; enabled: boolean; effort?: string | number } {
      const { enabled, effort } = (params ?? {}) as { enabled: boolean; effort?: string | number };
      if (typeof enabled !== 'boolean') throw new Error('model.setThinking requires "enabled"');

      // 真实来源优先：委托活跃 Provider 的 setThinking（Provider 级，与 TUI 同源）
      const active = getActiveProvider?.();
      if (active?.setThinking) {
        active.setThinking(enabled, effort);
      } else if (registry.setThinking) {
        // fallback：registry 级 setThinking（测试 mock）
        registry.setThinking(enabled, effort);
      }

      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'setThinking', enabled, effort });
      return { ok: true, enabled, effort };
    },

    // ── model.listChannels ─────────────────────────────────
    listChannels: (): { channels: ModelChannel[] } => {
      const channels: ModelChannel[] = registry.listChannels().map((c) => ({
        name: c.name,
        provider: c.provider,
        model: c.model,
        apiKeyEnv: c.apiKeyEnv,
        baseUrl: c.baseUrl,
        description: c.description,
      }));
      return { channels };
    },

    // ── model.upsertChannel ────────────────────────────────
    async upsertChannel(params: unknown): Promise<unknown> {
      const { name, ...config } = (params ?? {}) as { name: string } & ChannelConfigLike;
      if (!name) throw new Error('model.upsertChannel requires "name"');
      registry.upsertChannel(name, config);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'upsertChannel', name });
      return { ok: true, name };
    },

    // ── model.removeChannel ────────────────────────────────
    async removeChannel(params: unknown): Promise<unknown> {
      const { name } = (params ?? {}) as { name: string };
      if (!name) throw new Error('model.removeChannel requires "name"');
      if (name === 'main') throw new Error('cannot remove main channel');
      registry.removeChannel(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'removeChannel', name });
      return { ok: true, name };
    },

    // ── model.setChannelModel ──────────────────────────────
    async setChannelModel(params: unknown): Promise<unknown> {
      const { name, provider, model } = (params ?? {}) as {
        name: string;
        provider: string;
        model?: string;
      };
      if (!name || !provider) {
        throw new Error('model.setChannelModel requires "name" and "provider"');
      }
      registry.setChannelModel(name, provider, model);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'setChannelModel', name, provider, model });
      return { ok: true, name, provider, model };
    },

    // ── model.resetChannelModel ────────────────────────────
    async resetChannelModel(params: unknown): Promise<unknown> {
      const { name } = (params ?? {}) as { name: string };
      if (!name) throw new Error('model.resetChannelModel requires "name"');
      registry.resetChannelModel(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'resetChannelModel', name });
      return { ok: true, name };
    },

    // ── model.listRoles ────────────────────────────────────
    listRoles: (): { roles: Record<string, string> } => {
      return { roles: registry.listRoles?.() ?? {} };
    },

    // ── model.getChannelInfo ───────────────────────────────
    getChannelInfo: (params: unknown): { info: ChannelInfoLike | null } => {
      const { name } = (params ?? {}) as { name: string };
      if (!name) throw new Error('model.getChannelInfo requires "name"');
      return { info: registry.getChannelInfo(name) ?? null };
    },

    // ── model.listLocalModels ─────────────────────────────
    listLocalModels: (): { models: LocalModelEntry[] } => {
      return { models: listLocalModels() };
    },

    // ── model.setChannelRole ──────────────────────────────
    async setChannelRole(params: unknown): Promise<unknown> {
      const { role, channel } = (params ?? {}) as { role?: string; channel?: string };
      if (!role || !channel) {
        throw new Error('model.setChannelRole requires "role" and "channel"');
      }
      if (!registry.setRoleMapping) {
        throw new Error('setRoleMapping not supported by registry');
      }
      registry.setRoleMapping(role, channel);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'setChannelRole', role, channel });
      return { ok: true, role, channel };
    },

    // ── model.setLocalConfig ─────────────────────────────
    setLocalConfig(params: unknown): { ok: true } {
      const { ollamaUrl } = (params ?? {}) as { ollamaUrl?: string };
      if (!configureLocalModel) {
        throw new Error('configureLocalModel not supported by backend');
      }
      configureLocalModel({ ollamaUrl });
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'setLocalConfig', ollamaUrl });
      return { ok: true };
    },

    // ── model.localStart ─────────────────────────────────
    async localStart(params: unknown): Promise<unknown> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('model.localStart requires "name"');
      if (!localModelOps?.start) throw new Error('local model start not supported by backend');
      const info = await localModelOps.start(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'localStart', name, info });
      return { ok: true, name, info };
    },

    // ── model.localStop ──────────────────────────────────
    async localStop(params: unknown): Promise<unknown> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('model.localStop requires "name"');
      if (!localModelOps?.stop) throw new Error('local model stop not supported by backend');
      await localModelOps.stop(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'localStop', name });
      return { ok: true, name };
    },

    // ── model.localSwitch ────────────────────────────────
    async localSwitch(params: unknown): Promise<unknown> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('model.localSwitch requires "name"');
      if (!localModelOps?.switch) throw new Error('local model switch not supported by backend');
      const info = await localModelOps.switch(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'localSwitch', name, info });
      return { ok: true, name, info };
    },

    // ── model.toggle ─────────────────────────────────────
    toggle(): { ok: true } {
      // 循环切换主 provider（Ctrl+P 语义）：委托 loop.toggleProvider。
      // 切换后 UI 侧可经 model.getActive / state.get 读回当前 provider。
      const loop = getLoop?.();
      if (!loop?.toggleProvider) {
        throw new Error('model.toggle not supported (loop.toggleProvider unavailable)');
      }
      loop.toggleProvider();
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'toggle' });
      return { ok: true };
    },

    // ── model.localRegister ──────────────────────────────
    async localRegister(params: unknown): Promise<unknown> {
      const opts = (params ?? {}) as Record<string, unknown>;
      if (!opts.name || !opts.modelFile) {
        throw new Error('model.localRegister requires "name" and "modelFile"');
      }
      if (!localModelOps?.register) throw new Error('local model register not supported by backend');
      const entry = await localModelOps.register(opts);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'localRegister', name: opts.name });
      return { ok: true, name: opts.name, entry };
    },

    // ── model.localUnregister ────────────────────────────
    async localUnregister(params: unknown): Promise<unknown> {
      const name = (params as { name?: string } | undefined)?.name;
      if (!name) throw new Error('model.localUnregister requires "name"');
      if (!localModelOps?.unregister) throw new Error('local model unregister not supported by backend');
      const ok = await localModelOps.unregister(name);
      emit?.(UI_EVENT.MODEL_CHANGE, { action: 'localUnregister', name });
      return { ok, name };
    },

    // ── model.localScan ──────────────────────────────────
    async localScan(): Promise<unknown> {
      if (!localModelOps?.scanUnregistered) throw new Error('local model scan not supported by backend');
      const models = await localModelOps.scanUnregistered();
      return { ok: true, models };
    },
  };
}
