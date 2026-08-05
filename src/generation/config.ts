/**
 * 生成供应商配置加载 — 读取 .agent/generation.json
 *
 * 配置文件格式：
 * {
 *   "providers": {
 *     "volcengine": { "type": "volcengine", "model": "doubao-seedance-2-0", "apiKeyEnv": "ARK_API_KEY", "baseUrl": "https://ark.cn-beijing.volces.com/api/v3" },
 *     "kling":      { "type": "kling", "model": "kling-v3", "apiKeyEnv": "KLING_API_KEY" }
 *   },
 *   "defaults": { "image": "volcengine", "video": "volcengine" }
 * }
 *
 * 字段风格与 model-channels.json 的 ChannelConfig 一致（apiKey/apiKeyEnv/baseUrl），
 * 但独立命名空间，不进对话 roles 映射。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { GenerationConfig, GenerationProviderConfig } from './interface.js';

/** 项目级配置路径：<cwd>/.agent/generation.json */
export function getGenerationConfigPath(cwd: string): string {
  return path.join(cwd, '.agent', 'generation.json');
}

/** 全局配置路径：~/.agent/generation.json */
export function getGlobalGenerationConfigPath(): string {
  return path.join(os.homedir(), '.agent', 'generation.json');
}

function readJsonFile(p: string): GenerationConfig | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as GenerationConfig;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    // 配置损坏时返回 null，由上层决定如何处理（不静默吞掉但也不崩溃）
    console.error(`[generation] failed to parse config ${p}:`, (err as Error).message);
    return null;
  }
}

/**
 * 加载生成配置：项目级优先，全局级兜底，字段级合并。
 * 返回 { config, source } — source 用于日志/诊断。
 */
export function loadGenerationConfig(cwd: string): { config: GenerationConfig; source: 'project' | 'global' | 'none' } {
  const projectPath = getGenerationConfigPath(cwd);
  const globalPath = getGlobalGenerationConfigPath();

  const project = readJsonFile(projectPath);
  if (project) return { config: project, source: 'project' };

  const global = readJsonFile(globalPath);
  if (global) return { config: global, source: 'global' };

  return { config: { providers: {}, defaults: {} }, source: 'none' };
}

/** 读取单个供应商配置（合并 defaults 字段） */
export function getProviderConfig(config: GenerationConfig, providerName: string): GenerationProviderConfig | null {
  return config.providers[providerName] ?? null;
}
