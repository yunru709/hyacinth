import type { Message, ToolDefinition } from '../types.js';

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
