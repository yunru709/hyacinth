/**
 * generation-wizard — 生成能力配置向导（独立模块，不塞进主 setup wizard）
 *
 * 流程：
 *   1. 选生成厂商（BUILTIN_ADAPTERS 动态列表）
 *   2. 配 API key（写全局 ~/.agent/.env，envKey 可自定义，默认按厂商建议）
 *   3. 模态多选（图片/视频/音频）→ 从厂商 getCapabilities().taskTypes 动态展开
 *   4. 每个选中的 taskType 配模型名
 *   5. 写全局 ~/.agent/generation.json（providers + defaults）
 *
 * 设计要点：
 *   - 能力清单不硬编码：taskTypes 全部来自厂商 getCapabilities()
 *   - 模态→taskType 展开用命名约定辅助函数（非能力声明，纯 UI 映射）
 *   - 凭证统一走 .env（与 LLM 侧同规范），envKey 默认建议 + 可改
 *   - 独立模块，主 wizard.ts 零改动
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BUILTIN_ADAPTERS } from '../generation/adapters/index.js';
import type {
  GenerationConfig,
  GenerationTaskType,
  GenerationProviderConfig,
} from '../generation/interface.js';
import { getGlobalGenerationConfigPath } from '../generation/config.js';
import { ConfigManager } from './config.js';

// ── 纯函数（可测试）────────────────────────────────────────────────

/** 建议的 envKey（按厂商类型；未收录则 fallback TYPE_API_KEY） */
export function suggestEnvKey(adapterType: string): string {
  const hints: Record<string, string> = {
    volcengine: 'ARK_API_KEY',
    kling: 'KLING_API_KEY',
    minimax: 'MINIMAX_API_KEY',
  };
  if (hints[adapterType]) return hints[adapterType];
  return `${adapterType.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/** 模态 → taskType 归属（固定枚举映射；能力子集仍由厂商 capabilities 决定） */
const MODALITY_TASKS: Record<string, GenerationTaskType[]> = {
  image: ['text_to_image', 'image_to_image'],
  video: ['text_to_video', 'image_to_video', 'reference_to_video'],
  audio: ['audio_tts'],
};

/**
 * 从选中的模态展开出该厂商支持的 taskType 集合。
 * @param selectedModalities 用户勾选的模态（image/video/audio）
 * @param supportedTaskTypes 厂商 capabilities.taskTypes（权威清单）
 */
export function expandModalities(
  selectedModalities: string[],
  supportedTaskTypes: GenerationTaskType[],
): GenerationTaskType[] {
  const result = new Set<GenerationTaskType>();
  for (const mod of selectedModalities) {
    const tasks = MODALITY_TASKS[mod];
    if (!tasks) continue;
    for (const t of tasks) {
      if (supportedTaskTypes.includes(t)) result.add(t);
    }
  }
  return [...result];
}

/** 构建 generation.json 配置对象（providers + defaults） */
export function buildGenerationConfig(
  providerName: string,
  adapterType: string,
  models: Partial<Record<GenerationTaskType, string>>,
  apiKeyEnv?: string,
): GenerationConfig {
  const provider: GenerationProviderConfig = {
    type: adapterType,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    models,
  };
  const defaults: Partial<Record<GenerationTaskType, string>> = {};
  for (const t of Object.keys(models) as GenerationTaskType[]) {
    defaults[t] = providerName;
  }
  return { providers: { [providerName]: provider }, defaults };
}

// ── 向导 ────────────────────────────────────────────────────────────

export interface GenerationWizardResult {
  skipped: boolean;
  /** 写入的配置（skipped 时为 null） */
  config: GenerationConfig | null;
  /** 写入的 envKey（skipped 时为 null） */
  envKey: string | null;
}

/**
 * 运行生成能力配置向导。
 * @param configManager 复用 LLM 侧凭证管理（写 .env / 读已有 key）
 */
export async function runGenerationWizard(
  configManager: ConfigManager,
): Promise<GenerationWizardResult> {
  p.intro(pc.bold(pc.cyan('生成能力配置 (Generation)')));

  // ── 1. 选厂商 ─────────────────────────────────────────────────
  if (BUILTIN_ADAPTERS.length === 0) {
    p.outro(pc.yellow('暂无可用生成厂商（BUILTIN_ADAPTERS 为空）。跳过。'));
    return { skipped: true, config: null, envKey: null };
  }

  const adapterChoices = BUILTIN_ADAPTERS.map((a) => ({
    value: a.type,
    label: a.type,
  }));
  const selectedType = (await p.select({
    message: '选择生成厂商：',
    options: adapterChoices,
  })) as string | symbol;
  if (p.isCancel(selectedType)) return cancel();

  const adapter = BUILTIN_ADAPTERS.find((a) => a.type === selectedType)!;

  // ── 2. API key ────────────────────────────────────────────────
  const envKey = suggestEnvKey(adapter.type);
  const existing = process.env[envKey] ?? '';
  const apiKey = (await p.text({
    message: `输入 API Key（将写入 ~/.agent/.env 的 ${envKey}）：`,
    placeholder: existing ? '已配置（留空沿用）' : undefined,
    initialValue: existing,
    validate: (v) => ((v ?? '').trim() ? undefined : 'API Key 不能为空'),
  })) as string | symbol;
  if (p.isCancel(apiKey)) return cancel();
  await configManager.saveApiKeyToEnv(envKey, apiKey.trim());
  p.note(`已保存 ${envKey} 到 ~/.agent/.env`);

  // ── 3. 模态多选（从 capabilities 动态展开）────────────────────
  let provider;
  try {
    // 传入 apiKeyEnv：key 已写入 .env 且 saveApiKeyToEnv 同步设置了 process.env[envKey]
    provider = adapter.create(adapter.type, { type: adapter.type, apiKeyEnv: envKey });
  } catch {
    p.outro(pc.red('厂商初始化失败，跳过。'));
    return { skipped: true, config: null, envKey };
  }
  const caps = provider.getCapabilities();
  const modalityOptions = caps.modalities.map((m) => ({
    value: m,
    label: m === 'image' ? '图片' : m === 'video' ? '视频' : '音频',
    hint: expandModalities([m], caps.taskTypes).join(', ') || undefined,
  }));

  const selectedModalities = (await p.multiselect({
    message: '选择要启用的模态（能力来自厂商声明）：',
    options: modalityOptions,
    required: true,
  })) as string[] | symbol;
  if (p.isCancel(selectedModalities)) return cancel();

  const taskTypes = expandModalities(selectedModalities as string[], caps.taskTypes);
  if (taskTypes.length === 0) {
    p.outro(pc.yellow('所选模态没有可用的任务类型。跳过。'));
    return { skipped: true, config: null, envKey };
  }

  // ── 4. 每个 taskType 配模型名 ─────────────────────────────────
  const models: Partial<Record<GenerationTaskType, string>> = {};
  for (const t of taskTypes) {
    const model = (await p.text({
      message: `模型名（${t}）：`,
      placeholder: '留空用厂商默认模型',
    })) as string | symbol;
    if (p.isCancel(model)) return cancel();
    if (model.trim()) models[t] = model.trim();
  }

  // ── 5. 写 generation.json ─────────────────────────────────────
  const providerName = adapter.type;
  const config = buildGenerationConfig(providerName, adapter.type, models, envKey);
  const configPath = getGlobalGenerationConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // 合并已有配置（保留其他厂商）
  let merged: GenerationConfig = config;
  try {
    if (fs.existsSync(configPath)) {
      const existingCfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as GenerationConfig;
      merged = {
        providers: { ...existingCfg.providers, ...config.providers },
        defaults: { ...(existingCfg.defaults ?? {}), ...config.defaults },
      };
    }
  } catch {
    /* 配置损坏则覆盖 */
  }
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');

  p.note(`已写入 ${configPath}`);
  p.outro(pc.green('生成能力配置完成！'));
  return { skipped: false, config: merged, envKey };
}

function cancel(): GenerationWizardResult {
  p.cancel('已取消');
  return { skipped: true, config: null, envKey: null };
}
