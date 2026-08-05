/**
 * 生成能力模块统一出口 — GenerationService + 供应商注册表。
 *
 * 用法：
 *   const registry = GenerationRegistry.load(cwd);
 *   registry.registerAdapter('volcengine', createVolcengineAdapter); // 各适配器注册
 *   const svc = new GenerationService(registry, cwd);
 *   const artifact = await svc.generate({ provider: 'volcengine', taskType: 'text_to_image', prompt: '...' });
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
} from './interface.js';

export { GenerationRegistry } from './registry.js';
export type { GenerationAdapterFactory } from './registry.js';
export { GenerationService } from './service.js';
export type { GenerateOptions } from './service.js';
export { VolcSeedreamProvider, createVolcSeedreamProvider } from './adapters/volc-seedream.js';
export { VolcSeedanceProvider, createVolcSeedanceProvider } from './adapters/volc-seedance.js';
export {
  loadGenerationConfig,
  getGenerationConfigPath,
  getGlobalGenerationConfigPath,
} from './config.js';
