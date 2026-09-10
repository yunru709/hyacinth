import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('extension-registry');

// ── 可替换点目录（ReplaceablePointCatalog） ─────────────────────────

/** 可替换点种类。目录必须枚举原架构中所有可被替换/可挂载的位置（守卫测试强制）。 */
export type ReplaceablePointKind =
  | 'slot'      // 内核管线槽位（kernel.pipeline 六槽）
  | 'service'   // 内核服务面（StageServiceMap / pluginHost.register）
  | 'provider'  // 模型供应商（factory-registry / 通道）
  | 'router'    // 上下文模式路由（context/profiles）
  | 'source'    // 上下文数据源（contextComposer.registerSource）
  | 'adapter'   // 生成适配器：图/视频/音频（generation/registry）
  | 'channel'   // 接入渠道（channels/manager.register）
  | 'tool'      // 工具（registry/tool.registry）
  | 'skill'     // 技能（registry/skill.registry）
  | 'agent'     // 子 Agent（registry/agent.registry）
  | 'plugin';   // 插件本体（plugins/manager + kernel/plugin-host）

/**
 * 可替换点契约 —— 「换的东西长什么样」（开发者手册，注册表索引 → extension-contracts.ts）。
 * 开发者拿到目录即可按 contract 定位接口形状，实现用户模块并完成安装。
 */
export interface ReplaceableContract {
  /** 契约接口名（src/extension-contracts.ts 导出的类型） */
  interface: string;
  /** 契约定义模块（相对 src/，不带扩展名） */
  module: string;
  /** 一句话形状说明（快速判断该接口要做什么） */
  summary: string;
}

export interface ReplaceablePoint {
  /** '<kind>:<name>'；动态注册族用 '<kind>:*' 通配 */
  id: string;
  kind: ReplaceablePointKind;
  /** 出厂默认实现（动态族无固定默认） */
  defaultImpl?: string;
  description: string;
  /** 该点可替换的接口契约（未声明表示暂不可由名单替换） */
  contract?: ReplaceableContract;
}

// ── 各 kind 共享契约（契约真相源统一收敛到 extension-contracts.ts） ──

const SLOT_CONTRACT: ReplaceableContract = {
  interface: 'StageModule',
  module: 'kernel/pipeline',
  summary: '{ id, reads, writes, run(state, ctx) } —— id 与出厂阶段模块同址即原地替换',
};
const SERVICE_CONTRACT: ReplaceableContract = {
  interface: 'StageServiceMap[<key>]',
  module: 'orchestrator/stage-services',
  summary: '服务面契约 = 类型表 StageServiceMap[<key>]；service:<key> 的替换值须满足该键的类型',
};
const COMPRESSOR_CONTRACT: ReplaceableContract = {
  interface: 'CompressorOrchestrator',
  module: 'context/compressor',
  summary: '压缩编排器（多阶段差分压缩协调，budgetSignal 语义）',
};
const COMPOSER_CONTRACT: ReplaceableContract = {
  interface: 'ContextComposerLike',
  module: 'context/interface',
  summary: '{ compose(options), activeConditions } —— 上下文组装入口',
};
const PROVIDER_CONTRACT: ReplaceableContract = {
  interface: 'Provider',
  module: 'provider/interface',
  summary: 'createStream / getModel / getProviderType（主通道模型最小面）',
};
const ROUTER_CONTRACT: ReplaceableContract = {
  interface: 'IContextRouter',
  module: 'context/router',
  summary: 'name + toolAllowlist/toolBlacklist + skipSections + sourceOverrides …（模式路由）',
};
const SOURCE_CONTRACT: ReplaceableContract = {
  interface: 'ContextSource',
  module: 'context/interface',
  summary: '{ name, strategy, cacheability, getContent } —— 运行时数据供应源',
};
const AGENT_CONTRACT: ReplaceableContract = {
  interface: 'AgentDefinition',
  module: 'types',
  summary: 'name/description/systemPrompt/allowedTools/maxTurns …（子 Agent 定义）',
};
const TOOL_CONTRACT: ReplaceableContract = {
  interface: 'ToolDefinition',
  module: 'types',
  summary: '工具定义（execute 结构，registry/tool.registry 注册）',
};
const SKILL_CONTRACT: ReplaceableContract = {
  interface: 'SkillDefinition',
  module: 'types',
  summary: '技能定义（registry/skill.registry 注册）',
};
const PLUGIN_CONTRACT: ReplaceableContract = {
  interface: 'HyPlugin',
  module: 'kernel/plugin-host',
  summary: '{ id, deps?, activate(ctx, config), deactivate? } —— 内核挂载面插件',
};
const ADAPTER_CONTRACT: ReplaceableContract = {
  interface: 'GenerationAdapterFactory',
  module: 'generation/registry',
  summary: '(ctx) => GenerationAdapter —— 图/视频/音频生成适配器工厂',
};
const CHANNEL_CONTRACT: ReplaceableContract = {
  interface: 'ChannelPlugin',
  module: 'channels/auto-detect',
  summary: '{ name, create(options) } —— 接入渠道插件',
};

/**
 * 全局可替换点目录 —— 「原架构长什么样、哪里能被替换」的唯一名单来源。
 *
 * 守卫测试（gateway/extension-catalog.guard.test.ts）锁死：
 *  - slot:/service: 与内核槽位、StageServiceMap 键双向一致；
 *  - router:/source: 与出厂注册名一致；
 *  - src/ 中出现新的注册原语调用点必须登记进 ALLOWLIST。
 * 新增注册入口（新的 register* 原语）时：先登记目录，再过守卫。
 */
export const REPLACEABLE_POINTS: ReplaceablePoint[] = [
  // ── 内核槽位（kernel.pipeline；defaultImpl = 出厂 builtin 阶段模块 id） ──
  { id: 'slot:input',    kind: 'slot', defaultImpl: 'builtin:input-normalize',  description: '回合输入归一化槽位', contract: SLOT_CONTRACT },
  { id: 'slot:bypass',   kind: 'slot', defaultImpl: 'builtin:bypass-preturn',   description: '旁路 agent 槽位', contract: SLOT_CONTRACT },
  { id: 'slot:context',  kind: 'slot', defaultImpl: 'builtin:layered-composer', description: '上下文组装槽位', contract: SLOT_CONTRACT },
  { id: 'slot:llm',      kind: 'slot', defaultImpl: 'builtin:provider-stream',  description: 'LLM 调用槽位', contract: SLOT_CONTRACT },
  { id: 'slot:tools',    kind: 'slot', defaultImpl: 'builtin:tool-dispatch',    description: '工具执行槽位', contract: SLOT_CONTRACT },
  { id: 'slot:finalize', kind: 'slot', defaultImpl: 'builtin:turn-finalize',    description: '回合收尾槽位', contract: SLOT_CONTRACT },

  // ── 内核服务面（StageServiceMap / pluginHost.register 热替换） ──
  { id: 'service:conversationStore', kind: 'service', description: '会话存储', contract: SERVICE_CONTRACT },
  { id: 'service:configCenter',      kind: 'service', description: '运行时配置中心', contract: SERVICE_CONTRACT },
  { id: 'service:compressor',        kind: 'service', description: '压缩器（可热替换）', contract: COMPRESSOR_CONTRACT },
  { id: 'service:turnRecorder',      kind: 'service', description: '回合记录器（git 回滚账本）', contract: SERVICE_CONTRACT },
  { id: 'service:sessionDir',        kind: 'service', description: '会话目录（数据面）', contract: SERVICE_CONTRACT },
  { id: 'service:toolRegistry',      kind: 'service', description: '工具注册表', contract: SERVICE_CONTRACT },
  { id: 'service:contextComposer',   kind: 'service', description: '上下文组装器', contract: COMPOSER_CONTRACT },
  { id: 'service:summaryStore',      kind: 'service', description: '摘要存储', contract: SERVICE_CONTRACT },
  { id: 'service:statsManager',      kind: 'service', description: '统计管理器', contract: SERVICE_CONTRACT },
  { id: 'service:gitManager',        kind: 'service', description: 'git 管理器', contract: SERVICE_CONTRACT },
  { id: 'service:outputHandler',     kind: 'service', description: '输出处理器', contract: SERVICE_CONTRACT },
  { id: 'service:maxContextTokens',  kind: 'service', description: '上下文预算（数值面）', contract: SERVICE_CONTRACT },
  { id: 'service:personaDir',        kind: 'service', description: '人格目录（数据面）', contract: SERVICE_CONTRACT },
  { id: 'service:bundleRegistry',    kind: 'service', description: '工具包注册表', contract: SERVICE_CONTRACT },
  { id: 'service:kbState',           kind: 'service', description: '知识库状态', contract: SERVICE_CONTRACT },
  { id: 'service:loopHooks',         kind: 'service', description: '主循环钩子总线', contract: SERVICE_CONTRACT },
  { id: 'service:getRouter',         kind: 'service', description: '上下文路由访问器', contract: SERVICE_CONTRACT },
  { id: 'service:eventStore',        kind: 'service', description: '事件存储（ConversationEvent）', contract: SERVICE_CONTRACT },
  { id: 'service:orchestrator',      kind: 'service', description: '旁路编排器（LLMOrchestrator）', contract: SERVICE_CONTRACT },
  { id: 'service:bypassManager',     kind: 'service', description: '旁路管理器访问器', contract: SERVICE_CONTRACT },
  { id: 'service:toolService',       kind: 'service', description: '工具服务', contract: SERVICE_CONTRACT },
  { id: 'service:clusterService',    kind: 'service', description: '簇服务', contract: SERVICE_CONTRACT },

  // ── Provider ──
  { id: 'provider:main', kind: 'provider', description: '主通道模型实现（取代原 provider 层的落点）', contract: PROVIDER_CONTRACT },

  // ── Router（上下文模式） ──
  { id: 'router:normal',    kind: 'router', defaultImpl: 'NormalRouter',    description: '常规上下文模式路由', contract: ROUTER_CONTRACT },
  { id: 'router:companion', kind: 'router', defaultImpl: 'CompanionRouter', description: '陪伴模式上下文路由', contract: ROUTER_CONTRACT },

  // ── ContextSource（出厂内置数据源，gateway/context-sources.ts） ──
  { id: 'source:env-info',              kind: 'source', defaultImpl: 'builtin', description: '环境信息', contract: SOURCE_CONTRACT },
  { id: 'source:channel_context',       kind: 'source', defaultImpl: 'builtin', description: '渠道上下文', contract: SOURCE_CONTRACT },
  { id: 'source:flow',                  kind: 'source', defaultImpl: 'builtin', description: '流程上下文', contract: SOURCE_CONTRACT },
  { id: 'source:memory',                kind: 'source', defaultImpl: 'builtin', description: '记忆区', contract: SOURCE_CONTRACT },
  { id: 'source:companion_memory',      kind: 'source', defaultImpl: 'builtin', description: '陪伴记忆区', contract: SOURCE_CONTRACT },
  { id: 'source:session-tools',         kind: 'source', defaultImpl: 'builtin', description: '会话内工具索引', contract: SOURCE_CONTRACT },
  { id: 'source:intent_cluster_summary', kind: 'source', defaultImpl: 'builtin', description: '意图簇摘要', contract: SOURCE_CONTRACT },
  { id: 'source:image_store',           kind: 'source', defaultImpl: 'builtin', description: '图像存储索引', contract: SOURCE_CONTRACT },
  { id: 'source:tool-bundles',          kind: 'source', defaultImpl: 'builtin', description: '工具包索引', contract: SOURCE_CONTRACT },

  // ── 动态注册族（运行时实例以 point:'<kind>:<id>' 上报） ──
  { id: 'adapter:*', kind: 'adapter', description: '生成适配器族（图/视频/音频，GenerationRegistry.load 动态装载）', contract: ADAPTER_CONTRACT },
  { id: 'channel:*', kind: 'channel', description: '接入渠道族（内置 + 插件渠道动态注册）', contract: CHANNEL_CONTRACT },
  { id: 'tool:*',    kind: 'tool',    description: '工具族（registry/tool.registry，含插件注册）', contract: TOOL_CONTRACT },
  { id: 'skill:*',   kind: 'skill',   description: '技能族（registry/skill.registry）', contract: SKILL_CONTRACT },
  { id: 'agent:*',   kind: 'agent',   description: '子 Agent 族（registry/agent.registry）', contract: AGENT_CONTRACT },
  { id: 'plugin:*',  kind: 'plugin',  description: '插件族（plugins/manager 发现装载，名单裁决 enabled）', contract: PLUGIN_CONTRACT },
];

/** 精确查点；动态族（<kind>:*）对未知 <kind>:<name> 回退命中 */
export function getReplaceablePoint(id: string): ReplaceablePoint | undefined {
  const exact = REPLACEABLE_POINTS.find((p) => p.id === id);
  if (exact) return exact;
  const kind = id.slice(0, id.indexOf(':'));
  return REPLACEABLE_POINTS.find((p) => p.id === `${kind}:*`);
}

// ── 名单（extension-registry.json） ─────────────────────────────────

/** replacements[] 条目：取代某可替换点的出厂实现 */
export interface ReplacementDecl {
  point: string;
  impl: string;
  /** 用户模块相对路径（纯 ESM .js，沿用插件入口约定；装配期动态 import） */
  module?: string;
}

/** 插件架构申报中的单个点（manifest.architecture 的裁剪式条目） */
export interface PluginArchPoint {
  point: string;
  impl: string;
  /** 相对插件目录的 ESM .js 路径（沿用插件入口约定；装配期动态 import） */
  module?: string;
}

/** 插件对架构的声明式贡献（plugin.json 的 architecture + priority 段） */
export interface PluginArchitectureDecl {
  pluginId: string;
  /** 同点冲突权重（数字，大者生效）；缺省 0 */
  priority: number;
  /** 裁剪式申报：只列要碰的点，未填点走出厂实现 */
  points: PluginArchPoint[];
  /** 插件目录绝对路径（module 的解析基准；缺省由装配层回退 cwd） */
  dir?: string;
}

/** 某点裁决后的赢家声明（分发表消费；moduleBase = 插件目录绝对路径，user 名单走 cwd） */
export interface ResolvedReplacement {
  decl: ReplacementDecl;
  source: ExtensionSource;
  moduleBase?: string;
}

/** plugins[] 条目：名单对插件的装载裁决 */
export interface PluginDecl {
  id: string;
  /** 挂载位置提示（与 plugin.json 共同决定；缺省沿用插件自身声明） */
  mountAt?: string;
  /** 名单裁决：false = 即使已安装也不装载 */
  enabled: boolean;
}

/** orders[] 条目：同一可替换点多实现的排序（如竞争同一 section 的多个源） */
export interface OrderDecl {
  point: string;
  order: string[];
}

/** 名单文件结构（用户可写，配置面） */
export interface ExtensionManifest {
  replacements: ReplacementDecl[];
  plugins: PluginDecl[];
  orders: OrderDecl[];
}

export function emptyManifest(): ExtensionManifest {
  return { replacements: [], plugins: [], orders: [] };
}

/**
 * 解析并校验名单 JSON。宽容策略：非法条目剔除并记入 errors，合法条目保留。
 * point 必须能命中目录（精确或动态族）；module 须为 ./ 开头的 .js 相对路径。
 */
export function parseExtensionManifest(raw: unknown): { manifest: ExtensionManifest; errors: string[] } {
  const manifest = emptyManifest();
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { manifest, errors: ['manifest root must be an object'] };
  }
  const obj = raw as Record<string, unknown>;

  const replacements = Array.isArray(obj.replacements) ? obj.replacements : [];
  for (const [i, item] of replacements.entries()) {
    const r = item as Record<string, unknown>;
    const point = typeof r.point === 'string' ? r.point : '';
    const impl = typeof r.impl === 'string' ? r.impl : '';
    if (!getReplaceablePoint(point)) {
      errors.push(`replacements[${i}]: unknown point "${point}"`);
      continue;
    }
    if (!impl) {
      errors.push(`replacements[${i}]: missing impl`);
      continue;
    }
    const module = typeof r.module === 'string' ? r.module : undefined;
    if (module && !(module.startsWith('./') && module.endsWith('.js'))) {
      errors.push(`replacements[${i}]: module must be a relative "./xxx.js" ESM path`);
      continue;
    }
    manifest.replacements.push({ point, impl, ...(module ? { module } : {}) });
  }

  const plugins = Array.isArray(obj.plugins) ? obj.plugins : [];
  for (const [i, item] of plugins.entries()) {
    const p = item as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : '';
    if (!id) {
      errors.push(`plugins[${i}]: missing id`);
      continue;
    }
    if (typeof p.enabled !== 'boolean') {
      errors.push(`plugins[${i}]: enabled must be boolean`);
      continue;
    }
    const mountAt = typeof p.mountAt === 'string' ? p.mountAt : undefined;
    manifest.plugins.push({ id, enabled: p.enabled, ...(mountAt ? { mountAt } : {}) });
  }

  const orders = Array.isArray(obj.orders) ? obj.orders : [];
  for (const [i, item] of orders.entries()) {
    const o = item as Record<string, unknown>;
    const point = typeof o.point === 'string' ? o.point : '';
    if (!getReplaceablePoint(point)) {
      errors.push(`orders[${i}]: unknown point "${point}"`);
      continue;
    }
    const order = Array.isArray(o.order) && o.order.every((x) => typeof x === 'string')
      ? (o.order as string[])
      : undefined;
    if (!order || order.length === 0) {
      errors.push(`orders[${i}]: order must be a non-empty string array`);
      continue;
    }
    manifest.orders.push({ point, order });
  }

  return { manifest, errors };
}

/**
 * 合并两层名单：项目级覆盖全局级（按 replacements.point / plugins.id / orders.point 主键）。
 */
export function mergeManifests(globalM: ExtensionManifest, projectM: ExtensionManifest): ExtensionManifest {
  const merged = emptyManifest();
  const globalRepl = new Map(globalM.replacements.map((r) => [r.point, r]));
  for (const [point, r] of globalRepl) merged.replacements.push(r);
  for (const r of projectM.replacements) {
    const idx = merged.replacements.findIndex((x) => x.point === r.point);
    if (idx >= 0) merged.replacements[idx] = r;
    else merged.replacements.push(r);
  }
  const globalPlugins = new Map(globalM.plugins.map((p) => [p.id, p]));
  for (const p of globalPlugins.values()) merged.plugins.push(p);
  for (const p of projectM.plugins) {
    const idx = merged.plugins.findIndex((x) => x.id === p.id);
    if (idx >= 0) merged.plugins[idx] = p;
    else merged.plugins.push(p);
  }
  const globalOrders = new Map(globalM.orders.map((o) => [o.point, o]));
  for (const o of globalOrders.values()) merged.orders.push(o);
  for (const o of projectM.orders) {
    const idx = merged.orders.findIndex((x) => x.point === o.point);
    if (idx >= 0) merged.orders[idx] = o;
    else merged.orders.push(o);
  }
  return merged;
}

/** 名单文件位置约定：全局 ~/.agent/extension-registry.json ＋ 项目 .agent/extension-registry.json（覆盖） */
export function manifestPaths(projectDir: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: path.join(os.homedir(), '.agent', 'extension-registry.json'),
    projectPath: path.join(projectDir, '.agent', 'extension-registry.json'),
  };
}

function readManifestFile(p: string): { manifest?: ExtensionManifest; error?: string } {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    const { manifest, errors } = parseExtensionManifest(parsed);
    if (errors.length > 0) return { error: `${p}: ${errors.join('; ')}` };
    return { manifest };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    return { error: `${p}: ${(err as Error).message}` };
  }
}

/**
 * 读取两层名单并合并。文件缺失视为空名单；解析错误记录并跳过该层。
 */
export function loadExtensionManifest(projectDir: string): {
  manifest: ExtensionManifest;
  errors: string[];
  paths: { globalPath: string; projectPath: string };
} {
  const paths = manifestPaths(projectDir);
  const errors: string[] = [];
  const g = readManifestFile(paths.globalPath);
  if (g.error) errors.push(g.error);
  const pr = readManifestFile(paths.projectPath);
  if (pr.error) errors.push(pr.error);
  const manifest = mergeManifests(g.manifest ?? emptyManifest(), pr.manifest ?? emptyManifest());
  return { manifest, errors, paths };
}

/**
 * 名单裁决翻转（arch.toggle / CLI 的落地点）：读两层名单 → 项目层写回该插件的
 * enabled 声明（其余条目原样保留）。只写项目级名单（用户当前工作区的声明）。
 * 返回写回后的裁决值；写盘失败返回 { ok: false, error }。
 */
export function togglePluginInManifest(
  projectDir: string,
  pluginId: string,
  enabled: boolean,
): { ok: boolean; error?: string } {
  const { projectPath } = manifestPaths(projectDir);
  let projectManifest = emptyManifest();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
    projectManifest = parseExtensionManifest(raw).manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: `read ${projectPath}: ${(err as Error).message}` };
    }
    // 文件不存在 → 从空名单开始写
  }
  const plugins = projectManifest.plugins.filter((p) => p.id !== pluginId);
  plugins.push({ id: pluginId, enabled });
  try {
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, `${JSON.stringify({ ...projectManifest, plugins }, null, 2)}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `write ${projectPath}: ${(err as Error).message}` };
  }
}

// ── 运行时注册表（ExtensionRegistry） ───────────────────────────────/** 条目来源：builtin 出厂 / plugin 插件 / user 名单用户模块 / config 配置推导 */
export type ExtensionSource = 'builtin' | 'plugin' | 'user' | 'config';

/** 扩展注册表条目：某可替换点「现在实际是谁、是否生效」 */
export interface ExtensionEntry {
  point: string;
  source: ExtensionSource;
  impl: string;
  /** 被取代的出厂实现（回滚目标） */
  replacedFrom?: string;
  /** 插件挂载位置（plugin 类条目） */
  mountAt?: string;
  /** 名单裁决（用户声明，决定性） */
  enabled: boolean;
  /** 运行态确认：是否真的装载/生效成功 */
  effective: boolean;
  order?: number;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * 扩展注册表：名单（用户声明）+ 运行时各注册点实际注册结果的汇聚面。
 *
 * 分层边界：
 *  - 本类只持有数据与裁决语义，不知道任何具体注册原语；
 *  - 「按 point.kind 分发到注册原语」的分发表由装配层（gateway/agent-assembly）
 *    注入执行 —— supervisor 目录保持零业务依赖；
 *  - providers.json / plugins.config.json 管实现内部参数，本名单管「换谁、挂哪、生不生效」。
 */
export class ExtensionRegistry {
  private manifest: ExtensionManifest = emptyManifest();
  private entries = new Map<string, ExtensionEntry>();
  /** 插件架构申报表（plugin.json 的 architecture 段；key = pluginId） */
  private pluginArchs = new Map<string, PluginArchitectureDecl>();

  /** 装配期注入名单（loadExtensionManifest 的产物，含校验错误则由调用方决定 fail-fast/降级） */
  setManifest(manifest: ExtensionManifest): void {
    this.manifest = manifest;
  }

  getManifest(): ExtensionManifest {
    return {
      replacements: [...this.manifest.replacements],
      plugins: [...this.manifest.plugins],
      orders: [...this.manifest.orders],
    };
  }

  /**
   * 插件装载裁决：名单显式声明 > 调用方折叠的 fallback（plugins.config.json → manifest.enabledByDefault）。
   * 这是「名单决定插件能否生效」的落地点。
   */
  adjudicatePluginEnabled(pluginId: string, fallback: boolean): boolean {
    const decl = this.manifest.plugins.find((p) => p.id === pluginId);
    return decl ? decl.enabled : fallback;
  }

  /** 插件名单条目（含 mountAt 提示），无声明返回 undefined */
  getPluginDecl(pluginId: string): PluginDecl | undefined {
    return this.manifest.plugins.find((p) => p.id === pluginId);
  }

  /** 装配期待应用的替换申请（仅用户名单声明） */
  getReplacements(): ReplacementDecl[] {
    return [...this.manifest.replacements];
  }

  /** 某点的多实现排序声明 */
  getOrder(point: string): string[] | undefined {
    return this.manifest.orders.find((o) => o.point === point)?.order;
  }

  // ── 插件架构申报（source: 'plugin'）─────────────────────────────────

  /**
   * 插件申报架构贡献（plugin.json 的 architecture 段）。同名插件重复申报=覆盖。
   * 目录不可命中的点宽容剔除并记日志（与名单解析的宽容策略一致）。
   */
  submitPluginArchitecture(decl: PluginArchitectureDecl): void {
    const points = decl.points.filter((p) => getReplaceablePoint(p.point));
    if (points.length !== decl.points.length) {
      const dropped = decl.points
        .filter((p) => !getReplaceablePoint(p.point))
        .map((p) => p.point);
      logger.warn('plugin architecture has unknown points, dropped', { pluginId: decl.pluginId, dropped });
    }
    this.pluginArchs.set(decl.pluginId, { ...decl, points });
  }

  /** 已申报的插件架构贡献清单（arch 诊断 / 守卫测试用） */
  listPluginArchitectures(): Array<{ pluginId: string; priority: number; points: PluginArchPoint[] }> {
    return [...this.pluginArchs.values()].map((a) => ({ pluginId: a.pluginId, priority: a.priority, points: a.points }));
  }

  /**
   * 某点（<kind>:<name>）的裁决赢家 —— 四层权威链：
   *   ① 用户名单 replacements（外部配置，决定性）＞
   *   ② 插件 priority（数字，大者生效）＞
   *   ③ 插件 id 字典序（确定性 tie-break，永不歧义）＞
   *   ④ builtin 基线（无任何申报 → undefined，走出厂实现）
   */
  resolvePoint(point: string): ResolvedReplacement | undefined {
    const user = this.manifest.replacements.find((r) => r.point === point);
    if (user) return { decl: user, source: 'user' };
    const candidates: Array<{ pluginId: string; priority: number; p: PluginArchPoint }> = [];
    for (const a of this.pluginArchs.values()) {
      for (const p of a.points) {
        if (p.point === point) candidates.push({ pluginId: a.pluginId, priority: a.priority, p });
      }
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((x, y) =>
      y.priority - x.priority
      || x.pluginId.localeCompare(y.pluginId)
      || x.p.impl.localeCompare(y.p.impl),
    );
    const win = candidates[0];
    return {
      decl: { point, impl: win.p.impl, ...(win.p.module ? { module: win.p.module } : {}) },
      source: 'plugin',
      moduleBase: this.pluginArchs.get(win.pluginId)?.dir,
    };
  }

  /**
   * 分发表消费：全部被裁决为生效的替换声明（用户名单 + 插件赢家）。
   * 每个 point 至多一条 —— 同点多申报已在此收敛为唯一赢家。
   */
  getResolvedReplacements(): ResolvedReplacement[] {
    const points = new Set<string>();
    for (const r of this.manifest.replacements) points.add(r.point);
    for (const a of this.pluginArchs.values()) for (const p of a.points) points.add(p.point);
    const out: ResolvedReplacement[] = [];
    for (const point of points) {
      const r = this.resolvePoint(point);
      if (r) out.push(r);
    }
    return out;
  }

  /** 运行时上报（upsert，主键 point；插件条目 point 约定 'plugin:<id>'） */
  record(entry: ExtensionEntry): void {
    this.entries.set(entry.point, entry);
  }

  list(kind?: ReplaceablePointKind): ExtensionEntry[] {
    const all = [...this.entries.values()];
    if (!kind) return all;
    return all.filter((e) => e.point.startsWith(`${kind}:`));
  }

  get(point: string): ExtensionEntry | undefined {
    return this.entries.get(point);
  }

  /** 文本视图：名单 + 实际生效状态一屏可见 */
  describe(): string {
    const lines: string[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => a.point.localeCompare(b.point))) {
      const flag = e.effective ? '✓' : '✗';
      const from = e.replacedFrom ? ` (replaces ${e.replacedFrom})` : '';
      const err = e.error ? ` — ${e.error}` : '';
      lines.push(`${flag} ${e.point} ← ${e.impl}${from} [${e.source}]${err}`);
    }
    for (const r of this.manifest.replacements) {
      if (!this.entries.has(r.point)) lines.push(`… ${r.point} ← ${r.impl} [declared, not applied]`);
    }
    return lines.length > 0 ? lines.join('\n') : 'No extension entries recorded.';
  }
}
