import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export type LocalBackend = 'ollama' | 'llamacpp';

export interface LocalProviderConfig {
  baseUrl: string;
  port: number;
  defaultModel: string;
  maxTokens: number;
  /** 后端类型：ollama | llamacpp。未配置时自动检测 */
  backend?: LocalBackend;
}

const DEFAULT_CONFIG: LocalProviderConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  port: 11434,
  defaultModel: 'llama3.2',
  maxTokens: 4096,
};

// ── 自动检测 ────────────────────────────────────────────────────────

function httpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function httpGetJson<T>(url: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data) as T); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Ollama /api/tags 返回格式 */
interface OllamaTagsResponse {
  models: Array<{ name: string; modified_at?: string; size?: number }>;
}

/**
 * 从 Ollama 获取实际已安装的模型列表。
 * 返回模型名列表（如 ["llama3.2:latest", "mistral:latest"]）。
 */
export async function fetchOllamaModels(baseUrl?: string): Promise<string[]> {
  const apiUrl = `${baseUrl ?? 'http://127.0.0.1:11434'}/api/tags`;
  const data = await httpGetJson<OllamaTagsResponse>(apiUrl);
  if (!data?.models?.length) return [];
  return data.models.map((m) => m.name).filter(Boolean);
}

/**
 * 从给定的模型名列表中挑选最佳匹配。
 * 1. 精确匹配 preferredName
 * 2. 前缀匹配（去掉 :latest 等 tag 后的名字）
 * 3. 回退到列表第一个
 */
export function pickBestOllamaModel(
  available: string[],
  preferred?: string | null,
): string | null {
  if (available.length === 0) return null;

  if (preferred) {
    // 精确匹配
    const exact = available.find((m) => m === preferred);
    if (exact) return exact;

    // 前缀匹配：用户配了 "qwen3" → 匹配 "qwen3:latest"
    const prefixMatch = available.find((m) => m.startsWith(preferred));
    if (prefixMatch) return prefixMatch;

    // 反过来：available 里有 "qwen3:0.8b"，用户配了 "qwen3:0.8b-q4_k_m" → 匹配 available 中以 preferred 开头的
    const reverseMatch = available.find((m) => preferred.startsWith(m));
    if (reverseMatch) return reverseMatch;
  }

  return available[0];
}

/** 检测哪个本地后端正在运行。返回 null 表示都没在跑 */
export async function detectLocalBackend(): Promise<{ backend: LocalBackend; baseUrl: string; port: number } | null> {
  // 先检查 Ollama
  const ollamaAlive = await httpGet('http://127.0.0.1:11434/api/tags');
  if (ollamaAlive) {
    return { backend: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', port: 11434 };
  }
  // 再检查 llama.cpp
  const llamaAlive = await httpGet('http://127.0.0.1:8080/health');
  if (llamaAlive) {
    return { backend: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1', port: 8080 };
  }
  return null;
}

/** 检测指定 backend 的二进制是否安装（在 PATH 或项目 libs/ 下） */
export function detectBackendBinary(backend: LocalBackend): string | null {
  const candidates = backend === 'ollama'
    ? [
        path.join(process.cwd(), 'libs', 'ollama', 'ollama.exe'),
        path.join(process.cwd(), 'libs', 'ollama', 'ollama'),
        'ollama',
        'ollama.exe',
      ]
    : [];
  // llama.cpp binary detection is handled by LocalModelModule.resolveLlamaServerPath
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ── 配置加载 ────────────────────────────────────────────────────────
//
// 优先级：
//   1. RuntimeConfigCenter（~/.agent/config.json 的 local.* / provider.local.*）
//      — 通过 injectConfigCenter() 注入后生效
//   2. 硬编码默认值（bootstrap 阶段 configCenter 未注入时）

import type { RuntimeConfigCenter } from '../runtime/config-center.js';

let _configCenter: RuntimeConfigCenter | null = null;

/** 注入 RuntimeConfigCenter 引用（factory.ts 初始化后调用）。注入后所有读取走统一配置。 */
export function injectConfigCenter(cc: RuntimeConfigCenter): void {
  _configCenter = cc;
}

function readFromConfigCenter(): LocalProviderConfig | null {
  if (!_configCenter) return null;
  try {
    // provider.local.* 是运行时覆盖（TUI/切换写入），local.* 是默认值
    const baseUrl =
      _configCenter.get<string>('provider.local.baseUrl') ||
      _configCenter.get<string>('local.baseUrl');
    if (!baseUrl && _configCenter.get<string>('local.baseUrl') === undefined) return null;
    return {
      baseUrl: baseUrl || DEFAULT_CONFIG.baseUrl,
      port: (_configCenter.get<number>('local.port')) ?? DEFAULT_CONFIG.port,
      defaultModel:
        _configCenter.get<string>('provider.local.model') ||
        _configCenter.get<string>('local.defaultModel') ||
        DEFAULT_CONFIG.defaultModel,
      maxTokens:
        (_configCenter.get<number>('provider.local.maxTokens')) ??
        (_configCenter.get<number>('local.maxTokens')) ??
        DEFAULT_CONFIG.maxTokens,
      backend: (_configCenter.get<string>('local.backend') as LocalBackend | undefined),
    };
  } catch {
    return null;
  }
}

export function getLocalProviderConfigLoader(_cwd?: string): LocalProviderConfig {
  return readFromConfigCenter() ?? { ...DEFAULT_CONFIG };
}
