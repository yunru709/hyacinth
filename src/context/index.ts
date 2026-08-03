export { type ComposeOptions, type ContextComposer } from './interface.js';
export type {
  ContextSourceStrategy,
  ContextSourceCacheability,
  ContextSource,
} from './interface.js';
export type {
  LayeredComposeOptions,
  ZoneBreakdown,
  CacheMarker,
  LayeredContext,
} from './interface.js';
export { LayeredContextComposer } from './composer.js';
export type {
  LayeredComposeOptions as LayeredComposeOptionsDirect,
  ZoneBreakdown as ZoneBreakdownDirect,
  LayeredContext as LayeredContextDirect,
} from './composer.js';
export type { CacheMarker as CacheMarkerDirect } from './cache-strategy.js';
export {
  getCacheStrategy,
  registerStrategy,
} from './cache-strategy.js';
export type {
  CacheStrategy,
  CacheMode,
  ZoneInfo,
  ComputeMarkersInput,
} from './cache-strategy.js';
export {
  ToolOutputTrimmer,
  StructuredSummarizer,
  CompressorOrchestrator,
} from './compressor.js';
export type { CompressionResult, CompressionStats } from './compressor.js';
export {
  type SystemPromptSection,
  SystemPromptBuilder,
  loadProjectContext,
} from './prompt-builder.js';
export { Retriever } from './retriever.js';
export type { RetrieveOptions, RetrieveResult } from './retriever.js';
// ScheduleMode is already exported above via ./interface.js (re-exported from ./composer.js)
// modes.ts defines an identical ScheduleMode type; we export it only once to avoid duplicates.
