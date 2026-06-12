export type SectionType = 'static' | 'template' | 'runtime' | 'retrieval' | 'conditional';

export type ContextSourceStrategy = 'always_inline' | 'index_only' | 'lazy_expand' | 'phase_bound';

export type ConditionName = 'bootstrap_pending' | 'bootstrap_incomplete' | 'precise_mode';

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
