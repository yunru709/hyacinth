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

let cached: LocalProviderConfig | null = null;
let cachedCwd: string | null = null;

function getConfigPath(cwd: string): string {
  return path.join(cwd, '.agent', 'local-provider.json');
}

function load(cwd: string): LocalProviderConfig {
  const configPath = getConfigPath(cwd);
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || DEFAULT_CONFIG.baseUrl,
      port: parsed.port ?? DEFAULT_CONFIG.port,
      defaultModel: parsed.defaultModel || DEFAULT_CONFIG.defaultModel,
      maxTokens: parsed.maxTokens ?? DEFAULT_CONFIG.maxTokens,
      backend: parsed.backend,
    };
  } catch {
    // 文件不存在 — 不自动创建，留给用户配置或自动检测
    return { ...DEFAULT_CONFIG };
  }
}

export function getLocalProviderConfigLoader(cwd?: string): LocalProviderConfig {
  const dir = cwd ?? process.cwd();
  if (cached && cachedCwd === dir) return cached;
  cached = load(dir);
  cachedCwd = dir;
  return cached;
}
