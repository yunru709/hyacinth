import type { Message, ToolDefinition } from '../types.js';
import type { LayeredComposeOptions, LayeredContext } from './composer.js';

export interface ComposeOptions {
  systemPrompt: string;
  tools: ToolDefinition[];
  history: Message[];
  userInput: string;
  maxContextTokens: number;
  /** conversation.jsonl 全量历史，用于 Zone 4 池检索 */
  fullHistory?: Message[];
}

export interface ContextComposer {
  compose(options: ComposeOptions): Message[] | Promise<Message[]>;
}

/**
 * 上下文组装器最小接口（阶段 B 收窄：内核阶段/插件不再依赖 LayeredContextComposer
 * 具体类，只用本接口消费 —— 解 §5.2 插件反向依赖具体类）。
 * LayeredContextComposer 天然兼容（implements）。
 */
export interface ContextComposerLike {
  /** 分层组装（内置 context 阶段与可替换模块使用） */
  compose(options: LayeredComposeOptions): Promise<LayeredContext>;
  /** 平面组装（旧 ComposeOptions 路径） */
  compose(options: ComposeOptions): Promise<Message[]>;
  /** 条件开关（如 zone4_enabled / precise_mode） */
  activeConditions: Set<string>;
}

// Re-export new types from composer.ts for centralized access
export type {
  LayeredComposeOptions,
  ZoneBreakdown,
  LayeredContext,
} from './composer.js';
export type { CacheMarker } from './cache-strategy.js';

/** Strategy for loading a context source */
export type ContextSourceStrategy = 'always_inline' | 'index_only' | 'lazy_expand' | 'phase_bound';

/** Cacheability zone for a context source */
export type ContextSourceCacheability = 'anchor' | 'manifest' | 'summarized' | 'live';

/** A registered context source with loading strategy */
export interface ContextSource {
  /** Unique name for this source */
  name: string;
  /** Loading strategy */
  strategy: ContextSourceStrategy;
  /** Which cache zone this source belongs to */
  cacheability: ContextSourceCacheability;
  /** Short description for index display (used by index_only strategy) */
  description?: string;
  /** Callback to get the full content (used by always_inline and lazy_expand) */
  getContent: () => string | Promise<string>;
}
