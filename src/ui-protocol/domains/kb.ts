// ============================================================
// UI 协议层 — 知识库域（kb.*）
// ============================================================
// 覆盖 UI 对知识库的开关控制（对应 TUI /zone4、知识库启用）：
//   kb.get          查询当前状态（总开关 + Zone4 联网检索）
//   kb.setEnabled   设置知识库总开关（同步持久化 kb.enabled）
//   kb.setZone4     设置 Zone4（联网检索）开关（同步持久化 kb.zone4）
//
// 依赖结构化 KnowledgeBaseLike 接口（真实 KnowledgeBase 天然
// 兼容：enable/disable/setZone4Enabled/zone4Enabled），可独立测试。
// 开关写入同时同步 ConfigWriterLike（RuntimeConfigCenter 结构
// 兼容），保证 UI 侧单次调用即可完成「对象开关 + 配置持久化」，
// 重启后开关状态保留（对应 TUI 直连期的「对象 + 配置」双写）。
// ============================================================

import type { DomainHandler } from '../server.js';
import type { KnowledgeBaseState } from '../types.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 KnowledgeBase 兼容）
// ────────────────────────────────────────────────────────────

export interface KnowledgeBaseLike {
  /** 知识库总开关是否启用（getter） */
  enabled?: boolean;
  enable?(): void;
  disable?(): void;
  /** Zone 4（联网检索）是否启用（getter） */
  zone4Enabled?: boolean;
  setZone4Enabled?(v: boolean): void;
}

// ────────────────────────────────────────────────────────────
// 最小配置写入器接口（RuntimeConfigCenter 结构兼容）
// ────────────────────────────────────────────────────────────

export interface ConfigWriterLike {
  set(path: string, value: unknown): void;
  save?(): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// 知识库域选项
// ────────────────────────────────────────────────────────────

export interface KbDomainOptions {
  /** 动态获取知识库（agent 在 initialize 后才就绪，通过闭包延迟解析） */
  getKb: () => KnowledgeBaseLike | null;
  /**
   * 配置写入器：setEnabled/setZone4 同步持久化 kb.enabled / kb.zone4。
   * 写入类依赖缺失 → 明确报错（语义约定，不做静默降级）。
   */
  configCenter?: ConfigWriterLike;
  /**
   * 运行时上下文合成器的条件开关集合（对应 contextComposer.activeConditions）。
   * setZone4 同步增删 'zone4_enabled'，使开关「立即生效」而不只是持久化——
   * 吸收 TUI 直连期在本地补 activeConditions 的那一层（协议化收口）。
   */
  getComposerConditions?: () => Set<string> | null;
}

// ────────────────────────────────────────────────────────────
// 知识库域工厂
// ────────────────────────────────────────────────────────────

export function createKbDomain(options: KbDomainOptions): DomainHandler {
  const { getKb, configCenter, getComposerConditions } = options;

  /** 取知识库，不存在时抛错 */
  function requireKb(): KnowledgeBaseLike {
    const kb = getKb();
    if (!kb) throw new Error('knowledge base not available');
    return kb;
  }

  /**
   * 同步 composer 运行时条件（zone4_enabled）：使 Zone4 开关立即作用于
   * 当前会话的上下文合成，而非只持久化（吸收 TUI 直连期本地补丁）。
   */
  function syncComposerCondition(enabled: boolean): void {
    const conds = getComposerConditions?.();
    if (conds) {
      if (enabled) conds.add('zone4_enabled');
      else conds.delete('zone4_enabled');
    }
  }

  /**
   * 同步配置写入 + fire-and-forget 持久化。
   * 与 config 域 maybePersist 同语义：save 内部依赖 this 绑定（
   * ensureInitialized/getAll/configManager），必须 save.call(configCenter)。
   * 持久化失败不阻断 UI 响应，但要留痕（否则静默失败极难排查）。
   */
  async function persistKb(path: string, value: boolean): Promise<void> {
    if (!configCenter) {
      throw new Error('kb.set* requires configCenter (config persistence not available)');
    }
    configCenter.set(path, value);
    const save = configCenter.save;
    if (save) {
      try {
        await save.call(configCenter);
      } catch (err) {
        console.error('[ui-protocol] kb persist failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /** 组装当前状态 */
  function snapshot(kb: KnowledgeBaseLike): KnowledgeBaseState {
    return {
      enabled: kb.enabled ?? true,
      zone4Enabled: kb.zone4Enabled ?? true,
    };
  }

  return {
    // ── kb.get ─────────────────────────────────────────────
    get(): { kb: KnowledgeBaseState } {
      const kb = getKb();
      if (!kb) return { kb: { enabled: true, zone4Enabled: true } };
      return { kb: snapshot(kb) };
    },

    // ── kb.setEnabled ──────────────────────────────────────
    async setEnabled(params: unknown): Promise<{ ok: true; kb: KnowledgeBaseState }> {
      const enabled = (params as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new Error('kb.setEnabled requires boolean "enabled"');
      }
      const kb = requireKb();
      if (enabled) kb.enable?.();
      else kb.disable?.();
      await persistKb('kb.enabled', enabled);
      return { ok: true, kb: snapshot(kb) };
    },

    // ── kb.setZone4 ────────────────────────────────────────
    async setZone4(params: unknown): Promise<{ ok: true; kb: KnowledgeBaseState }> {
      const enabled = (params as { enabled?: boolean } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        throw new Error('kb.setZone4 requires boolean "enabled"');
      }
      const kb = requireKb();
      if (!kb.setZone4Enabled) throw new Error('setZone4Enabled not supported by knowledge base');
      kb.setZone4Enabled(enabled);
      syncComposerCondition(enabled);
      await persistKb('kb.zone4', enabled);
      return { ok: true, kb: snapshot(kb) };
    },
  };
}
