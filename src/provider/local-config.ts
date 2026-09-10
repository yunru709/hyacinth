import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export type LocalBackend = 'ollama' | 'llamacpp';

export interface LocalProviderConfig {
  baseUrl: string;
  port: number;
  defaultModel: string;
  /** 单次请求最大输出 token 数（从 config 读取，未配置时用默认值 4096）。兼容旧键名 maxTokens。 */
  maxOutputTokens: number;
  /** @deprecated 使用 maxOutputTokens */
  maxTokens?: number;
  /** 后端类型：ollama | llamacpp。未配置时自动检测 */
  backend?: LocalBackend;
}

const DEFAULT_CONFIG: LocalProviderConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  port: 11434,
  defaultModel: 'llama3.2',
  maxOutputTokens: 4096,
};

// ── 自动检测 ────────────────────────────────────────────────────────

/** llama.cpp 默认端口（schema 无独立键，defaults 会把 local.port 烙成 11434，无法区分显式配置，故暂不配置化） */
export const LLAMACPP_DEFAULT_PORT = 8080;

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
  const apiUrl = `${baseUrl ?? getOllamaEndpoints().apiBase}/api/tags`;
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
  // 先检查 Ollama（端口走配置 local.port）
  const ep = getOllamaEndpoints();
  const ollamaAlive = await httpGet(`${ep.apiBase}/api/tags`);
  if (ollamaAlive) {
    return { backend: 'ollama', baseUrl: ep.v1Base, port: ep.port };
  }
  // 再检查 llama.cpp
  const llamaAlive = await httpGet(`http://127.0.0.1:${LLAMACPP_DEFAULT_PORT}/health`);
  if (llamaAlive) {
    return { backend: 'llamacpp', baseUrl: `http://127.0.0.1:${LLAMACPP_DEFAULT_PORT}/v1`, port: LLAMACPP_DEFAULT_PORT };
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

/** 单键读取（provider.local.* 是运行时覆盖，local.* 是默认值，前者优先） */
function readConfigValue<T>(key: string): T | undefined {
  if (!_configCenter) return undefined;
  try {
    return _configCenter.get<T>(`provider.local.${key}`) ?? _configCenter.get<T>(`local.${key}`);
  } catch {
    return undefined;
  }
}

/** 旧键名向后兼容链：provider.local 优先于 local，新键名优先于旧键名 */
function readMaxOutputTokens(): number | undefined {
  if (!_configCenter) return undefined;
  try {
    return (
      _configCenter.get<number>('provider.local.maxOutputTokens') ??
      _configCenter.get<number>('provider.local.maxTokens') ??
      _configCenter.get<number>('local.maxOutputTokens') ??
      _configCenter.get<number>('local.maxTokens')
    );
  } catch {
    return undefined;
  }
}

/** 读取 local 相关的全部配置覆盖（可能为空对象 = 无任何配置） */
function readLocalOverrides(): Partial<LocalProviderConfig> {
  const overrides: Partial<LocalProviderConfig> = {};
  const baseUrl = readConfigValue<string>('baseUrl');
  if (baseUrl) overrides.baseUrl = baseUrl; // 空串视为未设置（对齐旧 || 语义）
  const port = readConfigValue<number>('port');
  if (port !== undefined) overrides.port = port;
  const model = readConfigValue<string>('model') ?? readConfigValue<string>('defaultModel');
  if (model !== undefined) overrides.defaultModel = model;
  const maxOutputTokens = readMaxOutputTokens();
  if (maxOutputTokens !== undefined) overrides.maxOutputTokens = maxOutputTokens;
  const backend = readConfigValue<LocalBackend>('backend');
  if (backend !== undefined) overrides.backend = backend;
  return overrides;
}

function readFromConfigCenter(): LocalProviderConfig | null {
  if (!_configCenter) return null;
  const overrides = readLocalOverrides();
  // 无任何 local 配置 → 回退硬编码默认值
  if (Object.keys(overrides).length === 0) return null;
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Ollama 各端点（全部由 local.port / local.baseUrl 派生）。
 *   apiBase   — 原生 API 根（/api/tags 等）
 *   v1Base    — OpenAI 兼容端点根
 *   healthUrl — 进程健康检查地址
 */
export function getOllamaEndpoints(): {
  port: number;
  apiBase: string;
  v1Base: string;
  healthUrl: string;
} {
  const port = readConfigValue<number>('port') ?? DEFAULT_CONFIG.port;
  // host 允许通过 baseUrl 覆盖（如局域网部署），默认本机
  const baseUrl = readConfigValue<string>('baseUrl');
  let host = '127.0.0.1';
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.hostname) host = u.hostname;
    } catch { /* 非法 baseUrl，忽略用默认 host */ }
  }
  const apiBase = `http://${host}:${port}`;
  return {
    port,
    apiBase,
    v1Base: `${apiBase}/v1`,
    healthUrl: `${apiBase}/api/tags`,
  };
}

/**
 * 本地后端进程管理参数（provider.local.healthCheck.* / local.healthCheck.*）。
 * 默认值与 runtime/defaults.ts 的 provider.local.healthCheck 一致（单一真源原则）。
 */
export function getLocalProcessConfig(): {
  restartDelayMs: number;
  intervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  startupTimeoutMs: number;
} {
  return {
    restartDelayMs: readConfigValue<number>('healthCheck.restartDelayMs') ?? 3000,
    intervalMs: readConfigValue<number>('healthCheck.intervalMs') ?? 5000,
    timeoutMs: readConfigValue<number>('healthCheck.timeoutMs') ?? 5000,
    maxRetries: readConfigValue<number>('healthCheck.maxRetries') ?? 6,
    startupTimeoutMs: readConfigValue<number>('healthCheck.startupTimeoutMs') ?? 120000,
  };
}

export function getLocalProviderConfigLoader(_cwd?: string): LocalProviderConfig {
  return readFromConfigCenter() ?? { ...DEFAULT_CONFIG };
}
