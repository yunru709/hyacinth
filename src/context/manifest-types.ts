// ============================================================
// manifest-types — 上下文清单的类型定义【机制 1/7: manifest】
// ============================================================
//
// 职责：管结构 —— 定义"上下文中有哪些 section，每个 section 在哪个 zone"。
//
// 这是上下文系统的"菜单/蓝图"。Composer 和 SectionResolver
// 根据这些定义来组装最终的 LLM 输入。用户可通过
// .agent/context-manifest.json 覆盖默认定义。
//
// 与 Composer 的关系：Manifest 声明"有什么"，Composer 负责"怎么拼"。
// Zone 布局决定了缓存断点位置和压缩器的保护区策略。
// ============================================================

export type SectionType = 'static' | 'template' | 'runtime' | 'retrieval' | 'conditional';

export type ContextSourceStrategy = 'always_inline' | 'index_only' | 'lazy_expand' | 'phase_bound';

export type ConditionName = 'precise_mode';

export interface SectionEntry {
  name: string;
  source: string;
  priority: number;
  type: SectionType;
  templateVars?: string[];
  strategy?: ContextSourceStrategy;
  condition?: ConditionName;
  description?: string;
  role?: 'system' | 'user' | 'assistant';
}

export interface ZoneEntry {
  name: string;
  order: number;
  enabled: boolean;
  sections: SectionEntry[];
  role?: 'system' | 'user' | 'assistant';
}

export interface ContextManifest {
  version: number;
  zones: Record<string, ZoneEntry>;
}
