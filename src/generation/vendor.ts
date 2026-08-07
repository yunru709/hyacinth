/**
 * vendor 引用机制 — 生成侧厂商从 LLM 侧继承凭证/端点。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决的问题
 * ──────────
 * 有些厂商（如火山/海螺 minimax）用同一个 API Key + baseUrl 同时提供
 * LLM 和生成能力。LLM 侧配置在 providers.json / DEFAULT_PROVIDERS，
 * 生成侧配置在 generation.json。若两边各写一遍 baseUrl/envKey，
 * 改一处漏一处，是重复配置的反模式。
 *
 * 本模块实现"继承"：生成侧 provider 配置可声明 vendor 字段，
 * 指向 LLM 侧同名厂商，baseUrl/apiKeyEnv 自动继承，只需补 models。
 *
 *   示例（generation.json）：
 *   {
 *     "providers": {
 *       "minimax": {
 *         "type": "minimax",
 *         "vendor": "minimax",          // ← 继承 LLM 侧的 minimax
 *         "models": { "text_to_video": "..." }
 *       }
 *     },
 *     "defaults": { "text_to_video": "minimax" }
 *   }
 *
 * 独立生成厂商（无 LLM，如 Runway）不填 vendor，自带 baseUrl/apiKeyEnv。
 * ══════════════════════════════════════════════════════════════════
 *
 * 设计要点：
 * - 纯函数：输入 GenerationConfig，输出已继承的 GenerationConfig
 * - 同步读取 providers.json（配置小，无需异步）
 * - 只继承缺失字段：显式填了 baseUrl/apiKeyEnv 则优先用显式的
 * - vendor 指向的厂商在 LLM 侧不存在 → 保留原样并记 warning（由适配器报错）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';
import type { GenerationConfig, GenerationProviderConfig } from './interface.js';

const logger = createLogger('generation-vendor');

/** LLM 侧 providers.json 路径：~/.agent/providers.json */
export function getLlmProvidersPath(): string {
  return path.join(os.homedir(), '.agent', 'providers.json');
}

/** 从 LLM 侧读取厂商元数据（baseUrl/envKey）。文件缺失返回空对象。 */
function readLlmVendorMeta(providersPath?: string): Record<string, { baseUrl?: string; envKey?: string }> {
  try {
    const p = providersPath ?? getLlmProvidersPath();
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      providers?: Record<string, { baseUrl?: string; envKey?: string }>;
    };
    return raw.providers ?? {};
  } catch (err) {
    logger.warn(`failed to read ${providersPath ?? getLlmProvidersPath()}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * 继承 vendor 指向的 LLM 厂商的 baseUrl/apiKeyEnv。
 * - 只补缺失字段（显式配置优先）
 * - vendor 对应的厂商不存在时保留原样（后续适配器会报缺 key）
 * - providersPath 可选（测试注入用），默认读 ~/.agent/providers.json
 */
export function resolveVendorInheritance(
  config: GenerationConfig,
  providersPath?: string,
): GenerationConfig {
  const llmMeta = readLlmVendorMeta(providersPath);

  const providers: Record<string, GenerationProviderConfig> = {};
  for (const [name, cfg] of Object.entries(config.providers)) {
    let resolved = cfg;
    if (cfg.vendor) {
      const vendor = llmMeta[cfg.vendor];
      if (vendor) {
        resolved = {
          ...cfg,
          baseUrl: cfg.baseUrl ?? vendor.baseUrl,
          apiKeyEnv: cfg.apiKeyEnv ?? vendor.envKey,
        };
        logger.info(
          `[vendor] "${name}" inherits baseUrl/apiKeyEnv from LLM provider "${cfg.vendor}"`,
        );
      } else {
        logger.warn(
          `[vendor] "${name}" declares vendor "${cfg.vendor}" but it's not in LLM providers.json; ` +
            'falling back to its own baseUrl/apiKeyEnv (or adapter error if missing)',
        );
      }
    }
    providers[name] = resolved;
  }

  return { ...config, providers };
}
