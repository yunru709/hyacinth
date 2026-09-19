// ============================================================
// UI 协议层 — 架构监督域（arch.*）
// ============================================================
// 扩展注册表方案：架构监督的查询面（第 20 域，对标 supervisor 域）。
//   arch.list   —— 可替换点目录 + 运行时生效条目 + 名单声明 + 本体图文本
//   arch.get    —— 单点查询：目录定义 / 名单声明 / 实际生效条目
//   arch.toggle —— 插件名单裁决翻转（写项目级名单，热生效由名单 watcher 接力）
//
// 物理边界（沿用 supervisor 域红线）：协议层自身零业务依赖 —— 目录/注册表/
// 名单数据由 backend 注入 ArchDataLike，本文件不 import supervisor/*。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（backend 注入；与 supervisor/extension-registry 类型镜像）
// ────────────────────────────────────────────────────────────

/** 可替换点（目录条目视图） */
export interface ArchPointView {
  id: string;
  kind: string;
  defaultImpl?: string;
  description: string;
}

/** 扩展条目（运行时生效视图） */
export interface ArchEntryView {
  point: string;
  source: 'builtin' | 'plugin' | 'user' | 'config';
  impl: string;
  replacedFrom?: string;
  mountAt?: string;
  enabled: boolean;
  effective: boolean;
  order?: number;
  error?: string;
}

/** 名单声明视图（用户可写配置的镜像） */
export interface ArchManifestView {
  replacements: Array<{ point: string; impl: string; module?: string }>;
  plugins: Array<{ id: string; mountAt?: string; enabled: boolean }>;
  orders: Array<{ point: string; order: string[] }>;
}

/** arch 域数据源（backend 从 AgentComponents 的扩展/本体注册表构造） */
export interface ArchDataLike {
  getCatalog: () => ArchPointView[];
  getEntries: () => ArchEntryView[];
  getManifest: () => ArchManifestView | null;
  /** 本体装配图文本（AssemblyRegistry.describe()；未装配为 null） */
  getAssemblyDescribe: () => string | null;
  /** 名单裁决翻转：写项目级名单并同步运行时注册表（backend 实现） */
  togglePlugin: (pluginId: string, enabled: boolean) => { ok: boolean; error?: string };
}

/** arch.list 返回结构 */
export interface ArchListResult {
  catalog: ArchPointView[];
  entries: ArchEntryView[];
  manifest: ArchManifestView | null;
  assembly: string | null;
  /**
   * 联动（links）段：消费者 + 能力提供方状态 + **运行态计数**（calls/fallbacks/lastReason）。
   * 未装配数据源时为 null —— 前端应显示"能力未注册（走核心兜底）"而不是留白。
   */
  links: string | null;
}

/** arch.get 返回结构 */
export interface ArchGetResult {
  point: ArchPointView | null;
  entry: ArchEntryView | null;
  declared: {
    replacement?: { point: string; impl: string; module?: string };
    plugin?: { id: string; mountAt?: string; enabled: boolean };
    order?: string[];
  } | null;
}

// ────────────────────────────────────────────────────────────
// 域工厂
// ────────────────────────────────────────────────────────────

export interface ArchDomainOptions {
  /** 架构监督数据源（backend 注入；未装配为 null，各 action 降级报错） */
  getArch: () => ArchDataLike | null;
  /**
   * 联动（links）段数据源（可选；注入方负责渲染 —— 协议层零业务依赖，故此处不 import 工具层）。
   * 未注入 ⇒ null（前端显示"能力未注册（走核心兜底）"）。
   */
  getLinks?: () => string | null;
}

export function createArchDomain(options: ArchDomainOptions): DomainHandler {
  const { getArch, getLinks } = options;

  return {
    /** 全景：目录 + 生效条目 + 名单 + 本体图 */
    async list(): Promise<ArchListResult> {
      const data = getArch();
      if (!data) throw new Error('arch: extension registry not assembled');
      return {
        catalog: data.getCatalog(),
        entries: data.getEntries(),
        manifest: data.getManifest(),
        assembly: data.getAssemblyDescribe(),
        // links 段：数据源未注入时为 null（不抛 —— 它是附加信息，不该拖垮整屏）
        links: getLinks ? getLinks() : null,
      };
    },

    /** 单点查询：目录定义 + 名单声明 + 实际生效条目 */
    async get(params: unknown): Promise<ArchGetResult> {
      const point = (params as { point?: string })?.point ?? '';
      const data = getArch();
      if (!data) throw new Error('arch: extension registry not assembled');
      const entry = data.getEntries().find((e) => e.point === point) ?? null;
      const manifest = data.getManifest();
      const declared: ArchGetResult['declared'] = entry || manifest
        ? {
            replacement: manifest?.replacements.find((r) => r.point === point),
            plugin: point.startsWith('plugin:')
              ? manifest?.plugins.find((p) => `plugin:${p.id}` === point || p.id === point)
              : undefined,
            order: manifest?.orders.find((o) => o.point === point)?.order,
          }
        : null;
      return {
        point: data.getCatalog().find((p) => p.id === point) ?? null,
        entry,
        declared,
      };
    },

    /** 名单裁决翻转：缺省 enabled 时按当前声明取反（未声明视为 true → false） */
    async toggle(params: unknown): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {
      const { pluginId: pid, enabled: en } = (params ?? {}) as { pluginId?: string; enabled?: boolean };
      const data = getArch();
      if (!data) throw new Error('arch: extension registry not assembled');
      const pluginId = pid ?? '';
      if (!pluginId) return { ok: false, error: 'pluginId is required' };
      const manifest = data.getManifest();
      const current = manifest?.plugins.find((p) => p.id === pluginId)?.enabled ?? true;
      const enabled = en ?? !current;
      const result = data.togglePlugin(pluginId, enabled);
      return result.ok ? { ok: true, enabled } : result;
    },
  };
}
