/**
 * 生成能力模块统一出口 — GenerationService + 供应商注册表。
 *
 * 用法：
 *   const registry = GenerationRegistry.load(cwd);
 *   const svc = new GenerationService(registry, cwd);
 *   const artifact = await svc.generate({ provider: 'volc', taskType: 'text_to_image', prompt: '...' });
 *
 * 供应商类型（providers[].type）由 adapters/ 下的 meta 定义，
 * 通过 adapters/index.ts 聚合，registry 自动注册。
 */

export type {
  GenerationProvider,
  GenerationCapabilities,
  GenerationConfig,
  GenerationProviderConfig,
  GenerationRequest,
  GenerationTask,
  GenerationStatus,
  GenerationStatusResult,
  GeneratedArtifact,
  GenerationModality,
  GenerationTaskType,
  MediaInput,
  AdapterMeta,
} from './interface.js';

export { GenerationRegistry } from './registry.js';
export type { GenerationAdapterFactory } from './registry.js';
export { GenerationService } from './service.js';
export type { GenerateOptions } from './service.js';
export { VolcengineProvider, createVolcengineProvider, meta as volcengineMeta } from './adapters/volcengine.js';
export { BUILTIN_ADAPTERS } from './adapters/index.js';
export {
  loadGenerationConfig,
  getGenerationConfigPath,
  getGlobalGenerationConfigPath,
  getGlobalGenerationOutputDir,
} from './config.js';
