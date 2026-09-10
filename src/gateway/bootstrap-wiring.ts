/**
 * bootstrap-wiring.ts —— 引导/持久化接线抽离（行数收尾第十七批）。
 *
 * 迁移 factory 的两段引导逻辑：
 * 1. persona 引导（ensureGlobalPersonaFiles + 7 个内置 Prompt 目录同步 +
 *    effectivePersonaDir 解析）
 * 2. Flow 状态持久化恢复（setPersistenceDir + load，崩溃后恢复活跃 flow）
 * 3. Model catalog 初始化（getModelCatalogLoader + init + maxContext 原生上限兜底）
 *
 * 均为「纯副作用、无产出」（effectivePersonaDir 除外），函数化 + deps 注入。
 */

import { ensureGlobalPersonaFiles, ensureGlobalPromptDir } from '../setup/persona-bootstrap.js';
import { getModelCatalogLoader } from '../provider/model-catalog-loader.js';
import { modelCatalog } from '../provider/catalog.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { MachineRegistry } from '../machine/index.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { Provider } from '../provider/interface.js';

/** persona 引导：全局文件 + 内置 Prompt 目录同步，返回生效的 personaDir */
export async function bootstrapPersona(personaDir: string | undefined): Promise<string> {
  const personaSetup = await ensureGlobalPersonaFiles();
  const effectivePersonaDir = personaDir ?? personaSetup.personaDir;

  // ── 内置 Prompt 同步 ─────────────────────────────────────────────
  // 将所有内置 prompt 同步到 ~/.agent/prompts/ 下，
  // 使得 loadPrompt() 的查找优先级正确：外部覆盖 > 内置兜底。
  await ensureGlobalPromptDir('attention');
  await ensureGlobalPromptDir('tools');
  await ensureGlobalPromptDir('agents');
  await ensureGlobalPromptDir('flows');
  await ensureGlobalPromptDir('skills');
  await ensureGlobalPromptDir('precise');
  await ensureGlobalPromptDir('environment');
  // root 级文件 summary.md 由 loadPrompt 递归搜索找到，暂不单独同步

  return effectivePersonaDir;
}

/** Flow 状态持久化恢复（崩溃后恢复活跃 flow；内置 Flow 注册已随 base 批迁入） */
export async function restoreFlowState(flowRegistry: MachineRegistry, sessionDir: string): Promise<void> {
  flowRegistry.setPersistenceDir(sessionDir);
  await flowRegistry.load();
}

/** Model catalog 初始化 + session.maxContext 原生上限兜底（仅当无用户自定义值时） */
export function initModelCatalog(options: {
  cwd: string;
  provider: Provider;
  configCenter: RuntimeConfigCenter;
}): void {
  const { cwd, provider, configCenter } = options;
  getModelCatalogLoader(cwd);
  modelCatalog.init(cwd);

  const modelCtx = getModelContextWindow(provider.getProviderType(), provider.getModel());
  const existingMaxContext = configCenter.get<number>('session.maxContext');
  if (!existingMaxContext || existingMaxContext <= 0) {
    configCenter.set('session.maxContext', modelCtx);
  }
}
