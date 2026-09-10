/**
 * arch-assembly.ts —— 架构监督的装配期构建（扩展注册表方案阶段 4）。
 *
 * 职责（gateway 装配层，supervisor 保持零业务依赖）：
 *  1. createArchRegistries：装配 supervisor 两个注册表 ——
 *     AssemblyRegistry（出厂图：gateway/assembly-graph + kernel.pipeline 槽位 + 服务面键，注入零复制）
 *     ExtensionRegistry（运行时名单 + 生效视图）；
 *  2. applyProviderReplacement：名单 replacements 中 provider:main 的真实替换点 ——
 *     动态 import 用户模块 → 校验 Provider 形状 → setMainProvider 取代出厂主通道。
 *     时序约束：必须在 AgentLoop 构造之前调用（loop 构造时捕获主 provider）。
 *
 * 用户替换模块契约（名单 { point: 'provider:main', module: './modules/xxx.js' }）：
 *   模块为纯 ESM .js（沿用插件入口约定），default 导出 Provider 实例，
 *   或导出工厂函数 `({ cwd }) => Provider | Promise<Provider>`。
 *   最小 Provider 形状：createStream / getModel / getProviderType（provider/interface.ts）。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../logging/logger.js';
import { AssemblyRegistry, type AssemblyEntry } from '../supervisor/assembly-registry.js';
import {
  ExtensionRegistry,
  loadExtensionManifest,
  manifestPaths,
  getReplaceablePoint,
  type ExtensionEntry,
  type ReplaceablePointKind,
  type ReplacementDecl,
  type ResolvedReplacement,
} from '../supervisor/extension-registry.js';
import type { ManifestAccessLike } from '../hot-reload/extension-registry-watcher.js';
import { ASSEMBLY_GRAPH } from './assembly-graph.js';
import { getActiveRouter, registerRouter } from '../context/profiles.js';
import type { IContextRouter } from '../context/router.js';
import type { ContextSource } from '../context/interface.js';
import type { LayeredContextComposer } from '../context/composer.js';
import type { StageServiceMap, StageServiceKey } from '../orchestrator/stage-services.js';
import type { Pipeline, StageModule } from '../kernel/pipeline.js';
import type { AgentDefinition } from '../types.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { Provider } from '../provider/interface.js';

const logger = createLogger('arch-assembly');

/** 服务面键清单（与 supervisor 目录 service:* 一致；守卫测试锁定与 StageServiceMap 同步） */
export const STAGE_SERVICE_KEYS = [
  'conversationStore', 'configCenter', 'compressor', 'turnRecorder', 'sessionDir',
  'toolRegistry', 'contextComposer', 'summaryStore', 'statsManager', 'gitManager',
  'outputHandler', 'maxContextTokens', 'personaDir', 'bundleRegistry', 'kbState',
  'loopHooks', 'getRouter', 'eventStore', 'orchestrator', 'bypassManager',
  'toolService', 'clusterService',
] as const satisfies readonly (keyof StageServiceMap)[];

/** kernel.pipeline 槽位声明（FullConfig.kernel.pipeline 条目的最小面） */
export interface PipelineSlotDecl {
  id: string;
  impl: string;
}

export interface ArchRegistryDeps {
  cwd: string;
  /** kernel.pipeline 槽位（缺省走出厂默认六槽） */
  pipeline?: PipelineSlotDecl[];
}

export interface ArchRegistries {
  assemblyRegistry: AssemblyRegistry;
  extensionRegistry: ExtensionRegistry;
}

/** 装配两个架构注册表（本体数据注入，零复制；名单读两层文件，错误降级保留合法部分） */
export function createArchRegistries(deps: ArchRegistryDeps): ArchRegistries {
  const graphEntries: AssemblyEntry[] = ASSEMBLY_GRAPH;
  const slots = deps.pipeline && deps.pipeline.length > 0
    ? deps.pipeline
    : [
        { id: 'input', impl: 'builtin:input-normalize' },
        { id: 'bypass', impl: 'builtin:bypass-preturn' },
        { id: 'context', impl: 'builtin:layered-composer' },
        { id: 'llm', impl: 'builtin:provider-stream' },
        { id: 'tools', impl: 'builtin:tool-dispatch' },
        { id: 'finalize', impl: 'builtin:turn-finalize' },
      ];
  const slotEntries: AssemblyEntry[] = slots.map((s) => ({
    id: `slot:${s.id}`,
    kind: 'slot',
    phase: 'P-C',
    defaultImpl: s.impl,
  }));
  const serviceEntries: AssemblyEntry[] = STAGE_SERVICE_KEYS.map((k) => ({
    id: `service:${k}`,
    kind: 'service',
    phase: 'P-B',
  }));

  const assemblyRegistry = new AssemblyRegistry({ graphEntries, slotEntries, serviceEntries });
  const extensionRegistry = new ExtensionRegistry();

  const { manifest, errors } = loadExtensionManifest(deps.cwd);
  if (errors.length > 0) {
    logger.warn('extension-registry manifest errors (ignored entries skipped)', { errors });
  }
  extensionRegistry.setManifest(manifest);

  return { assemblyRegistry, extensionRegistry };
}

/**
 * 内置基线上报：未被替换的可替换点补记 builtin 生效条目，
 * 使 arch.list 的运行时视图一屏可见「谁在实际岗位上」。
 * 幂等：已有点（如被名单替换的 provider:main）不覆盖。
 */
export function recordBuiltinBaselines(deps: {
  extensionRegistry: ExtensionRegistry;
  pipeline: PipelineSlotDecl[];
  sources: string[];
}): void {
  const reg = deps.extensionRegistry;
  if (!reg.get('provider:main')) {
    reg.record({ point: 'provider:main', source: 'builtin', impl: 'builtin:main', enabled: true, effective: true });
  }
  for (const slot of deps.pipeline) {
    const point = `slot:${slot.id}`;
    if (!reg.get(point)) {
      reg.record({ point, source: 'builtin', impl: slot.impl, enabled: true, effective: true });
    }
  }
  if (!reg.get('router:active')) {
    let name = 'normal';
    try {
      name = getActiveRouter().name;
    } catch {
      // 路由未初始化（极端装配序），按出厂 normal 记录
    }
    reg.record({ point: 'router:active', source: 'builtin', impl: `router:${name}`, enabled: true, effective: true });
  }
  for (const name of deps.sources) {
    const point = `source:${name}`;
    if (!reg.get(point)) {
      reg.record({ point, source: 'builtin', impl: 'builtin', enabled: true, effective: true });
    }
  }
}

/** 名单访问面工厂：值依赖留在 gateway，watcher 经注入消费（规则 4 类型引用豁免） */
export function createManifestAccess(cwd: string): ManifestAccessLike {
  return {
    listManifestPaths: () => {
      const { globalPath, projectPath } = manifestPaths(cwd);
      return [globalPath, projectPath];
    },
    loadManifest: () => loadExtensionManifest(cwd),
  };
}

// ── provider:main 真实替换点 ────────────────────────────────────────

/** 主通道注册面（ModelChannelRegistry 的最小结构面，测试可注入替身） */
export interface MainProviderSurface {
  setMainProvider(provider: Provider, providerType?: string): void;
  getMainProvider(): Provider | null;
}

export interface ProviderReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  channelRegistry: MainProviderSurface | null;
}

/** 用户模块最小 Provider 形状校验（createStream/getModel/getProviderType 可调用） */
function isProviderLike(x: unknown): x is Provider {
  const p = x as Record<string, unknown> | null;
  return !!p
    && typeof p.createStream === 'function'
    && typeof p.getModel === 'function'
    && typeof p.getProviderType === 'function';
}

function record(deps: ProviderReplacementDeps, entry: ExtensionEntry): void {
  deps.extensionRegistry.record(entry);
}

/**
 * 应用名单中的 provider:main 替换声明（阶段 4 唯一真实替换点）。
 *
 * 每条声明独立成败：失败记 effective=false + error（降级继续走出厂主通道）。
 * 必须在 AgentLoop 构造前调用 —— loop 构造时捕获主 provider 实例。
 */
export async function applyProviderReplacement(deps: ProviderReplacementDeps): Promise<void> {
  // 用 getResolvedReplacements 而非 getReplacements：后者只返回用户名单，
  // 会结构性漏掉插件 architecture 段声明的 provider:main 替换。
  const resolved = deps.extensionRegistry.getResolvedReplacements()
    .filter((r) => r.decl.point === 'provider:main');
  if (resolved.length === 0) return;

  // 多条声明时后一条覆盖前一条（与名单合并的 point 主键语义一致：生效最后一条）
  for (const { decl, source, moduleBase } of resolved) {
    const fail = (error: string) => {
      logger.warn('provider:main replacement failed', { impl: decl.impl, error });
      record(deps, { point: 'provider:main', source, impl: decl.impl, enabled: true, effective: false, error });
    };

    if (!deps.channelRegistry) {
      fail('channel registry unavailable');
      continue;
    }
    if (!decl.module) {
      fail('replacement requires "module" (ESM .js path)');
      continue;
    }

    try {
      const modulePath = path.resolve(moduleBase ?? deps.cwd, decl.module);
      const url = pathToFileURL(modulePath).href;
      const mod: unknown = await import(url);
      const exported = (mod as { default?: unknown }).default ?? mod;
      const provider = typeof exported === 'function'
        ? await (exported as (ctx: { cwd: string }) => Promise<Provider> | Provider)({ cwd: deps.cwd })
        : exported;
      if (!isProviderLike(provider)) {
        fail('module default export is not Provider-shaped (createStream/getModel/getProviderType)');
        continue;
      }
      const previous = deps.channelRegistry.getMainProvider();
      const replacedFrom = previous
        ? `${previous.getProviderType()}/${previous.getModel()}`
        : 'builtin:main';
      deps.channelRegistry.setMainProvider(provider);
      logger.info('provider:main replaced by extension registry', { impl: decl.impl, module: decl.module, source, replacedFrom });
      record(deps, { point: 'provider:main', source, impl: decl.impl, replacedFrom, enabled: true, effective: true, meta: { module: decl.module } });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}

// ── 多 kind 分发表（阶段 4.2：目录 → 名单 → 分发原语） ─────────────────

/**
 * 某 kind 的注册面：形状校验 + 实际注册。与 provider:main 同一语义——
 * 每条名单声明独立成败：失败记 effective=false + error，走出厂实现。
 * 回滚 = 删除名单声明 → 重启恢复出厂（装配期应用，热重载待真实用例接入）。
 */
export interface KindReplacementSurface {
  kind: ReplaceablePointKind;
  /** 形状校验：不满足返回错误信息，满足返回 null */
  validate(exported: unknown): string | null;
  /** 实际注册；可抛错（记 effective=false）。返回 replacedFrom 供回滚目标记录 */
  register(
    decl: ReplacementDecl,
    exported: unknown,
  ): Promise<{ replacedFrom?: string } | void> | { replacedFrom?: string } | void;
}

export interface KindReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  surface: KindReplacementSurface;
}

/**
 * 按 kind 应用替换：动态 import → 形状校验 → 注册原语 → 记录生效/失败。
 *
 * 声明来源 = 裁决后的赢家名单（getResolvedReplacements）：
 *  - user（extension-registry.json 名单，source: 'user'）—— 模块相对 cwd 解析；
 *  - plugin（插件 manifest 的 architecture 段，source: 'plugin'）—— 模块相对插件目录解析；
 *  - 同点多申报已由注册表收敛为唯一赢家，此处每个 point 至多处理一条。
 */
export async function applyReplacementByKind(deps: KindReplacementDeps): Promise<void> {
  const decls: ResolvedReplacement[] = deps.extensionRegistry.getResolvedReplacements()
    .filter((r) => getReplaceablePoint(r.decl.point)?.kind === deps.surface.kind);
  if (decls.length === 0) return;
  for (const { decl, source, moduleBase } of decls) {
    const point = decl.point;
    const fail = (error: string) => {
      logger.warn(`${point} replacement failed`, { impl: decl.impl, source, error });
      deps.extensionRegistry.record({ point, source, impl: decl.impl, enabled: true, effective: false, error });
    };
    try {
      if (!decl.module) {
        fail('replacement requires "module" (ESM .js path)');
        continue;
      }
      const mod: unknown = await import(pathToFileURL(path.resolve(moduleBase ?? deps.cwd, decl.module)).href);
      // 显式 default 导出（含 null/undefined）即实现；无 default 时退化为命名导出空间
      const modNs = mod as Record<string, unknown>;
      const exported = 'default' in modNs ? modNs.default : modNs;
      const shapeError = deps.surface.validate(exported);
      if (shapeError) {
        fail(shapeError);
        continue;
      }
      const res = await deps.surface.register(decl, exported);
      deps.extensionRegistry.record({
        point,
        source,
        impl: decl.impl,
        ...(res && typeof res === 'object' && res.replacedFrom ? { replacedFrom: res.replacedFrom } : {}),
        enabled: true,
        effective: true,
        meta: { module: decl.module },
      });
      logger.info(`${point} replaced by extension registry`, { impl: decl.impl, source, module: decl.module });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
}

// ── 形状校验器（最小运行时面；编译期契约真相源 = extension-contracts.ts） ──

function isContextSourceLike(x: unknown): x is ContextSource {
  const s = x as Record<string, unknown> | null;
  return !!s && typeof s.name === 'string' && typeof s.getContent === 'function';
}

function isRouterLike(x: unknown): x is IContextRouter {
  const r = x as Record<string, unknown> | null;
  return !!r
    && typeof r.name === 'string'
    && Array.isArray(r.toolAllowlist)
    && Array.isArray(r.toolBlacklist)
    && Array.isArray(r.skipSections)
    && Array.isArray(r.skipRuntimeSources)
    && typeof r.sourceOverrides === 'object' && r.sourceOverrides !== null;
}

function isAgentDefinitionLike(x: unknown): x is AgentDefinition {
  const a = x as Record<string, unknown> | null;
  return !!a
    && typeof a.name === 'string'
    && typeof a.description === 'string'
    && typeof a.systemPrompt === 'string'
    && Array.isArray(a.allowedTools)
    && typeof a.maxTurns === 'number';
}

function isStageModuleLike(x: unknown): x is StageModule {
  const m = x as Record<string, unknown> | null;
  return !!m
    && typeof m.id === 'string'
    && typeof m.run === 'function'
    && (m.reads === undefined || Array.isArray(m.reads))
    && (m.writes === undefined || Array.isArray(m.writes));
}

// ── source:* → contextComposer.registerSource（同名覆盖内置源） ──

export interface SourceReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  /** 上下文组装器（registerSource 同名即覆盖内置源） */
  composer: Pick<LayeredContextComposer, 'registerSource'> | null;
}

export async function applySourceReplacements(deps: SourceReplacementDeps): Promise<void> {
  await applyReplacementByKind({
    cwd: deps.cwd,
    extensionRegistry: deps.extensionRegistry,
    surface: {
      kind: 'source',
      validate: (x) => (isContextSourceLike(x)
        ? null
        : 'module default export is not ContextSource-shaped ({ name, strategy, cacheability, getContent })'),
      register: async (decl, exported) => {
        if (!deps.composer) throw new Error('context composer unavailable (source surface not ready)');
        deps.composer.registerSource(exported as ContextSource);
        const replacedFrom = getReplaceablePoint(decl.point)?.defaultImpl ?? 'builtin';
        return { replacedFrom };
      },
    },
  });
}

// ── agent:* → agentRegistry.register（子 Agent 定义） ──

export interface AgentReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  agentRegistry: Pick<AgentRegistry, 'register'> | null;
}

export async function applyAgentReplacements(deps: AgentReplacementDeps): Promise<void> {
  await applyReplacementByKind({
    cwd: deps.cwd,
    extensionRegistry: deps.extensionRegistry,
    surface: {
      kind: 'agent',
      validate: (x) => (isAgentDefinitionLike(x)
        ? null
        : 'module default export is not AgentDefinition-shaped ({ name, description, systemPrompt, allowedTools, maxTurns })'),
      register: async (decl, exported) => {
        if (!deps.agentRegistry) throw new Error('agent registry unavailable (assembly order)');
        deps.agentRegistry.register(exported as AgentDefinition);
        return {};
      },
    },
  });
}

// ── router:* → profiles.registerRouter（同名覆盖出厂路由） ──

export interface RouterReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
}

export async function applyRouterReplacements(deps: RouterReplacementDeps): Promise<void> {
  await applyReplacementByKind({
    cwd: deps.cwd,
    extensionRegistry: deps.extensionRegistry,
    surface: {
      kind: 'router',
      validate: (x) => (isRouterLike(x)
        ? null
        : 'module default export is not IContextRouter-shaped (toolAllowlist/toolBlacklist/skipSections/skipRuntimeSources/sourceOverrides)'),
      register: async (decl, exported) => {
        registerRouter(exported as IContextRouter);
        return {};
      },
    },
  });
}

// ── slot:* → kernel.pipeline.registerStageModule（同名模块 id 即原地替换） ──

export interface SlotReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  /** 内核管道（loop.pluginHost.get('kernel.pipeline')）；模块 id 与出厂同址即替换 */
  pipeline: Pick<Pipeline, 'registerStageModule'> | null;
}

export async function applySlotReplacements(deps: SlotReplacementDeps): Promise<void> {
  await applyReplacementByKind({
    cwd: deps.cwd,
    extensionRegistry: deps.extensionRegistry,
    surface: {
      kind: 'slot',
      validate: (x) => (isStageModuleLike(x)
        ? null
        : 'module default export is not StageModule-shaped ({ id, reads, writes, run })'),
      register: async (decl, exported) => {
        if (!deps.pipeline) throw new Error('kernel.pipeline unavailable (loop not constructed?)');
        deps.pipeline.registerStageModule(exported as StageModule);
        const replacedFrom = getReplaceablePoint(decl.point)?.defaultImpl;
        return { replacedFrom };
      },
    },
  });
}

// ── service:* → AgentLoop.setStageService（键 = point 的 service:<key>） ──

export interface ServiceReplacementDeps {
  cwd: string;
  extensionRegistry: ExtensionRegistry;
  /** 阶段服务面（AgentLoop.setStageService）；值的最弱运行时校验，编译期契约见 StageServiceMap */
  setService: ((key: StageServiceKey, value: unknown) => unknown) | null;
}

export async function applyServiceReplacements(deps: ServiceReplacementDeps): Promise<void> {
  await applyReplacementByKind({
    cwd: deps.cwd,
    extensionRegistry: deps.extensionRegistry,
    surface: {
      kind: 'service',
      validate: (x) => (x === null || x === undefined
        ? 'module default export must not be null/undefined (StageServiceMap[<key>])'
        : null),
      register: async (decl, exported) => {
        if (!deps.setService) throw new Error('stage service surface unavailable (loop not constructed?)');
        deps.setService(decl.point.slice('service:'.length) as StageServiceKey, exported);
        return {};
      },
    },
  });
}
