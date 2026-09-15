/**
 * vendor 引用机制 — 生成侧厂商从 LLM 侧继承凭证/端点 + 能力声明即用。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决的问题
 * ──────────
 * 有些厂商（如火山/海螺 minimax）用同一个 API Key + baseUrl 同时提供
 * LLM 和生成能力；中转站/聚合平台（one-api、OpenRouter、硅基流动）更是
 * 一个 key 背后同时提供 LLM、TTS、图片、视频、embedding。LLM 侧配置在
 * providers.json，生成侧配置在 generation.json——若两边各写一遍凭证，
 * 改一处漏一处，是重复配置的反模式。
 *
 * 本模块实现两级联动：
 *
 * ① 继承（vendor 引用）：生成侧 provider 配置可声明 vendor 字段，指向
 *    LLM 侧同名厂商，baseUrl/apiKeyEnv 自动继承，只需补 models。
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
 * ② auto-materialize（声明即用）：LLM 侧厂商在 providers.json 声明
 *    capabilities（tts/image/video）后，生成侧**无需写任何条目**——
 *    本模块自动生成 GenerationProviderConfig，并在某任务类型只有一家
 *    能力供应商时自动写入 defaults 默认路由。
 *
 *   示例（~/.agent/providers.json）：
 *   {
 *     "providers": {
 *       "my_gateway": {
 *         "id": "my_gateway", "name": "我的中转站",
 *         "baseUrl": "https://gateway.example.com/v1",
 *         "defaultModel": "gpt-4o", "envKey": "GATEWAY_API_KEY",
 *         "capabilities": {
 *           "tts":   { "model": "tts-1", "voice": "alloy" },
 *           "image": { "model": "dall-e-3" }
 *         }
 *       }
 *     }
 *   }
 *   → 自动生成条目 my_gateway（type: openai-compatible，models:
 *     { audio_tts: "tts-1", text_to_image: "dall-e-3" }），且 audio_tts /
 *     text_to_image 无竞争厂商时自动设为默认路由。
 *
 * 独立生成厂商（无 LLM，如 Runway）不填 vendor，自带 baseUrl/apiKeyEnv。
 * ══════════════════════════════════════════════════════════════════
 *
 * 设计要点：
 * - 纯函数：输入 GenerationConfig，输出已继承/已物化的 GenerationConfig
 * - 同步读取 providers.json（配置小，无需异步）
 * - 显式配置优先：generation.json 写了条目 → 不覆盖（凭证继承照旧）；
 *   defaults 写了 → 不自动路由
 * - 能力→任务类型映射：tts→audio_tts、image→text_to_image、
 *   video→text_to_video（image_to_image / image_to_video / reference_to_video
 *   需显式配置，不自动）
 * - video 无 OpenAI 标准端点 → 必须显式声明 spec.adapter，否则跳过并 warning
 * - embedding/rerank 走独立接口（provider/embedding.ts），不进 generation
 * - 默认路由仅在"该任务类型只有一家能力供应商"时自动写 defaults——
 *   多厂商竞争同一能力不自动，避免隐式路由意外
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';
import type { GenerationConfig, GenerationProviderConfig, GenerationTaskType } from './interface.js';
import type { VendorCapability, VendorCapabilitySpec } from '../provider/provider-meta.js';
import { BUILTIN_ADAPTERS } from './adapters/index.js';

const logger = createLogger('generation-vendor');

/** 能力 → 生成侧任务类型（image_to_image / image_to_video / reference_to_video 需显式配置，不自动） */
const CAPABILITY_TASK_TYPES: Partial<Record<VendorCapability, GenerationTaskType[]>> = {
  tts: ['audio_tts'],
  image: ['text_to_image'],
  video: ['text_to_video'],
};

/** 能力 → 缺省适配器（video 无 OpenAI 标准端点，必须显式 spec.adapter） */
const CAPABILITY_DEFAULT_ADAPTER: Partial<Record<VendorCapability, string>> = {
  tts: 'openai-compatible',
  image: 'openai-compatible',
};

/** 参与默认路由判定的任务类型（embedding/rerank 独立接口，不在此列） */
const AUTO_TASK_TYPES: GenerationTaskType[] = ['audio_tts', 'text_to_image', 'text_to_video'];

/** LLM 侧厂商元数据（含能力声明） */
interface LlmVendorMeta {
  baseUrl?: string;
  envKey?: string;
  capabilities?: Partial<Record<VendorCapability, VendorCapabilitySpec>>;
}

/** LLM 侧 providers.json 路径：~/.agent/providers.json */
export function getLlmProvidersPath(): string {
  return path.join(os.homedir(), '.agent', 'providers.json');
}

/** 从 LLM 侧读取厂商元数据（baseUrl/envKey/capabilities）。文件缺失返回空对象。 */
function readLlmVendorMeta(providersPath?: string): Record<string, LlmVendorMeta> {
  try {
    const p = providersPath ?? getLlmProvidersPath();
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      providers?: Record<string, LlmVendorMeta>;
    };
    return raw.providers ?? {};
  } catch (err) {
    logger.warn(`failed to read ${providersPath ?? getLlmProvidersPath()}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * 继承 vendor 指向的 LLM 厂商的 baseUrl/apiKeyEnv + 能力声明即用。
 * - 显式配置优先：只补缺失字段（凭证继承）；能力不覆盖
 * - vendor 对应的厂商不存在时保留原样（后续适配器会报缺 key）
 * - LLM 侧声明 capabilities 且生成侧无显式条目的厂商 → 自动物化条目
 * - 某任务类型无显式 defaults 且只有一家能力供应商 → 自动写入 defaults
 * - providersPath 可选（测试注入用），默认读 ~/.agent/providers.json
 */
export function resolveVendorInheritance(
  config: GenerationConfig,
  providersPath?: string,
): GenerationConfig {
  const llmMeta = readLlmVendorMeta(providersPath);

  // ① 显式配置照旧：继承 vendor 指向的 LLM 厂商的 baseUrl/apiKeyEnv
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

  // ② auto-materialize：LLM 侧声明了 capabilities 的厂商 → 生成侧自动生成条目
  const taskTypeSuppliers = new Map<GenerationTaskType, string[]>();
  // 显式配置的能力来源：models 键（一厂商多能力 → 多模型）
  for (const [name, cfg] of Object.entries(config.providers)) {
    for (const tt of Object.keys(cfg.models ?? {}) as GenerationTaskType[]) {
      pushSupplier(taskTypeSuppliers, tt, name);
    }
  }

  for (const [vendorId, meta] of Object.entries(llmMeta)) {
    if (!meta.capabilities) continue;
    if (providers[vendorId]) continue; // 显式配置优先，不物化覆盖
    const entries = materializeVendor(vendorId, meta);
    for (const { name, entry, taskTypes } of entries) {
      providers[name] = entry;
      for (const tt of taskTypes) pushSupplier(taskTypeSuppliers, tt, name);
    }
  }

  // ③ 声明即用默认路由：无显式 defaults 且只有一家能力供应商 → 自动
  const defaults = { ...config.defaults };
  for (const tt of AUTO_TASK_TYPES) {
    if (defaults[tt]) continue;
    const suppliers = taskTypeSuppliers.get(tt);
    if (suppliers && suppliers.length === 1) {
      defaults[tt] = suppliers[0];
      logger.info(`[auto-materialize] default route for ${tt} → "${suppliers[0]}"（唯一能力供应商）`);
    }
  }

  return { ...config, providers, defaults };
}

/** 单个物化条目（name 可能带能力后缀——同一厂商多能力走不同适配器时拆条目） */
interface MaterializedEntry {
  name: string;
  entry: GenerationProviderConfig;
  taskTypes: GenerationTaskType[];
}

/**
 * 把 LLM 侧厂商的能力声明物化成生成侧条目。
 * - 按有效适配器分组：同一厂商多能力若走不同适配器（如 tts/image 走
 *   openai-compatible、video 走 minimax），则拆成多个条目——第一组保留
 *   厂商原名，其余组加能力后缀（${vendorId}-${capability}）
 * - 凭证（baseUrl/apiKeyEnv）直接带上（物化条目不再经过①的继承循环）
 * - embedding/rerank 不进 generation（独立接口）
 * - video 无显式 adapter → 跳过该能力并 warning
 * - 有效适配器未注册（不在 BUILTIN_ADAPTERS）→ 跳过该能力并 warning（避免物化
 *   出"adapter not registered"的坏条目，在首次使用时才炸）
 */
function materializeVendor(vendorId: string, meta: LlmVendorMeta): MaterializedEntry[] {
  interface Group {
    adapter: string;
    capability: VendorCapability; // 组内第一个能力（命名后缀用）
    models: Partial<Record<GenerationTaskType, string>>;
    voice?: string;
    taskTypes: GenerationTaskType[];
  }
  const groups = new Map<string, Group>();

  for (const [capability, spec] of Object.entries(meta.capabilities ?? {})) {
    const cap = capability as VendorCapability;
    if (!spec) continue;
    const taskTypes = CAPABILITY_TASK_TYPES[cap];
    if (!taskTypes) continue; // embedding/rerank 走独立接口

    const adapter = spec.adapter ?? CAPABILITY_DEFAULT_ADAPTER[cap];
    if (!adapter) {
      logger.warn(
        `[auto-materialize] "${vendorId}" declares capability "${cap}" without adapter; ` +
          'skipping（video 无 OpenAI 标准端点，需显式 spec.adapter）',
      );
      continue;
    }
    if (!BUILTIN_ADAPTERS.some(a => a.type === adapter)) {
      logger.warn(
        `[auto-materialize] "${vendorId}" capability "${cap}" resolves to adapter "${adapter}" ` +
          `which is not registered (available: ${BUILTIN_ADAPTERS.map(a => a.type).join(', ') || 'none'}); skipping`,
      );
      continue;
    }

    let group = groups.get(adapter);
    if (!group) {
      group = { adapter, capability: cap, models: {}, taskTypes: [] };
      groups.set(adapter, group);
    }
    for (const tt of taskTypes) {
      if (spec.model) group.models[tt] = spec.model;
      group.taskTypes.push(tt);
    }
    if (cap === 'tts' && spec.voice) group.voice = spec.voice;
  }

  const results: MaterializedEntry[] = [];
  for (const group of groups.values()) {
    // 直接带上凭证：物化条目不再经过①的继承循环（那条只处理显式条目）
    const entry: GenerationProviderConfig = {
      type: group.adapter,
      vendor: vendorId,
      baseUrl: meta.baseUrl,
      apiKeyEnv: meta.envKey,
    };
    if (Object.keys(group.models).length > 0) entry.models = group.models;
    if (group.voice) entry.voice = group.voice;

    // 第一组（按声明顺序）保留厂商原名，其余组加能力后缀——主能力走原名，专项能力走后缀
    const name = results.length === 0 ? vendorId : `${vendorId}-${group.capability}`;
    logger.info(
      `[auto-materialize] "${name}" ← LLM provider "${vendorId}" capability "${group.capability}" (adapter ${group.adapter})`,
    );
    results.push({ name, entry, taskTypes: group.taskTypes });
  }
  return results;
}

/** 记录某任务类型的一个供应者（去重） */
function pushSupplier(
  map: Map<GenerationTaskType, string[]>,
  tt: GenerationTaskType,
  name: string,
): void {
  const list = map.get(tt);
  if (list) {
    if (!list.includes(name)) list.push(name);
  } else {
    map.set(tt, [name]);
  }
}
