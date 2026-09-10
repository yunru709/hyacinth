// ============================================================
// UI 协议层 — 上下文域（context.*）
// ============================================================
// 覆盖 UI 对上下文组装信息的查询与 zone 开关控制：
//   context.previewZone      返回指定 Zone 组装后的真实文本（设置页预览用）
//   context.manifest         查询 zone 清单与 enabled 状态（设置页开关初始化）
//   context.setZoneEnabled   开关 Zone（写 .agent/context-manifest.json，
//                            watcher 热重载自动生效；旧 context.zones 死键勿再用）
//
// 实现：通过闭包延迟解析 AgentLoop（loop 在 initialize 后才就绪），
// 委托 loop.previewContextZone() —— 复用真实 composer 与已注册的
// ContextSource（skills/agents/mcp/memory 等），保证内容与线上一致。
// zone 开关走注入的 ManifestLike（桥接层包装 ManifestLoader 单例），
// 协议层不直接碰文件系统。
// ============================================================

import type { DomainHandler } from '../server.js';

// ────────────────────────────────────────────────────────────
// 最小 loop 接口（AgentLoop 结构兼容）
// ────────────────────────────────────────────────────────────

export interface ContextLoopLike {
  previewContextZone?(zoneKey: string): Promise<{ zone: string; text: string; tokens: number } | null>;
}

// ── manifest 最小接口（.agent/context-manifest.json 的真实开关源）──
// 对应 context/manifest-loader.ts 的 ManifestLoader（getZone / getManifest）。
// 读取类缺依赖 → 降级返回空列表；写入类缺依赖 → 明确报错。

export interface ManifestZoneView {
  name: string;
  order: number;
  enabled: boolean;
  sectionCount: number;
}

export interface ManifestLike {
  /** 全部 zone（含 disabled）视图，按 order 排序 */
  getZones(): ManifestZoneView[];
  /** 设置 zone 开关并落盘（watcher 监听文件自动热重载） */
  setZoneEnabled(zone: string, enabled: boolean): void;
}

export interface ContextDomainOptions {
  /** 动态获取 AgentLoop（loop 在 initialize 后才就绪时的延迟解析）。 */
  getLoop: () => ContextLoopLike | null;
  /** zone 开关读写（桥接层注入 ManifestLoader 包装；null = 不支持 manifest 动作）。 */
  getManifest: () => ManifestLike | null;
}

// ────────────────────────────────────────────────────────────
// 上下文域工厂
// ────────────────────────────────────────────────────────────

export function createContextDomain(options: ContextDomainOptions): DomainHandler {
  const { getLoop } = options;

  return {
    // ── context.previewZone ────────────────────────────────
    async previewZone(params: unknown): Promise<{ zone: string; text: string; tokens: number } | null> {
      const zone = (params as { zone?: string } | undefined)?.zone ?? 'zone1';
      const loop = getLoop();
      if (!loop?.previewContextZone) {
        throw new Error('context.previewZone not supported (loop.previewContextZone not available)');
      }
      return loop.previewContextZone(zone);
    },

    // ── context.manifest ───────────────────────────────────
    // 查询全部 zone 状态（含 disabled）。读取类：缺依赖降级返回空列表。
    manifest(): { zones: ManifestZoneView[] } {
      const m = options.getManifest();
      if (!m) return { zones: [] };
      return { zones: m.getZones() };
    },

    // ── context.setZoneEnabled ─────────────────────────────
    // 写入类：缺依赖明确报错；zone 不存在 / enabled 非 boolean 报错。
    setZoneEnabled(params: unknown): { ok: true; zone: string; enabled: boolean } {
      const { zone, enabled } = (params ?? {}) as { zone?: string; enabled?: unknown };
      if (!zone) throw new Error('setZoneEnabled requires "zone"');
      if (typeof enabled !== 'boolean') throw new Error('setZoneEnabled requires boolean "enabled"');
      const m = options.getManifest();
      if (!m) throw new Error('context.setZoneEnabled not supported (manifest not injected)');
      m.setZoneEnabled(zone, enabled);
      return { ok: true, zone, enabled };
    },
  };
}
