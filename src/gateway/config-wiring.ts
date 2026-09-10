/**
 * config-wiring.ts —— 配置中心引导接线抽离（行数收尾第十六批）。
 *
 * 迁移 factory 的 P-A 配置段：RuntimeConfigCenter 初始化 + 日志级别同步 +
 * 5 个 inject*ConfigCenter 全局注入 + provider.userId 前缀 + effectiveMaxTurns/
 * effectiveMaxContext 计算 + model catalog 初始化。
 *
 * 时序锚「Provider Config Loader 必须在 getDefaultConfig 之前」随块迁入，
 * 守卫 C2 扫描装配全集仍可命中。
 */

import { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { FullConfig } from '../runtime/config-schema.js';
import type { ConfigManager, AgentConfig } from '../setup/config.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import { setLogLevel } from '../logging/logger.js';
import { setUserIdPrefix, DEFAULT_USER_ID } from '../provider/user-id.js';
import { injectConfigCenter } from '../provider/local-config.js';
import { injectToolConfigCenter } from '../tools/tool-config.js';
import { injectContextConfigCenter } from '../context/context-config.js';
import { injectGenerationConfigCenter } from '../generation/generation-config.js';
import { injectHotReloadConfigCenter } from '../hot-reload/hot-reload-config.js';

export interface ConfigWiringResult {
  configCenter: RuntimeConfigCenter;
  effectiveMaxTurns: number;
  effectiveMaxContext: number;
}

/**
 * 初始化 RuntimeConfigCenter + 全局注入面 + 日志级别同步。
 * 前置条件：providerConfigLoader.load() 已完成（时序锚，随块迁入）。
 */
export function wireConfigCenter(options: {
  configManager: ConfigManager;
  config: AgentConfig;
  maxTurns: number;
  maxContext: number;
}): ConfigWiringResult {
  const { configManager, config, maxTurns, maxContext } = options;

  // ── Runtime Config Center ──────────────────────────────────────────
  const configCenter = RuntimeConfigCenter.getInstance();
  configCenter.initialize(getDefaultConfig(), configManager);
  configCenter.merge(config as unknown as Partial<FullConfig>);

  // 把配置中心的 logging.level 同步给 logger（配置为权威来源，LOG_LEVEL env 仅兜底），
  // 并订阅变更使运行时修改即时生效
  const applyLogLevel = () => {
    setLogLevel(configCenter.get<'debug' | 'info' | 'warn' | 'error' | 'off'>('logging.level') ?? 'info');
  };
  applyLogLevel();
  configCenter.watch('logging.level', applyLogLevel);

  // 同步 userId 前缀到 user-id 模块（后续所有 userId 生成使用此前缀）
  setUserIdPrefix(configCenter.get<string>('provider.userId') ?? DEFAULT_USER_ID);

  // 注入 configCenter 到 local-config 模块，此后所有本地模型配置读取统一走 configCenter
  injectConfigCenter(configCenter);

  // 注入 configCenter 到工具层，内置工具参数默认值（tools.*）统一走配置
  injectToolConfigCenter(configCenter);

  // 注入 configCenter 到上下文层，压缩器阈值与 zone 预算（context.*）统一走配置
  injectContextConfigCenter(configCenter);

  // 注入 configCenter 到生成层与热重载层（generation.* / hotReload.*）
  injectGenerationConfigCenter(configCenter);
  injectHotReloadConfigCenter(configCenter);

  // 统一从 configCenter 读取 maxTurns（合并了 defaults + config.json 覆盖）
  const effectiveMaxTurns = configCenter.get<number>('session.maxTurns') ?? maxTurns;
  // 统一使用 configCenter 中的 maxContext，确保与 loop.ts 一致
  const effectiveMaxContext = configCenter.get<number>('session.maxContext') ?? maxContext;

  return { configCenter, effectiveMaxTurns, effectiveMaxContext };
}
