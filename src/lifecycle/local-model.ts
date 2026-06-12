import { execSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LocalModelBackend, LocalModelConfig, ProcessEventCallbacks } from './interface.js';
import { ProcessManager } from './manager.js';
import { getLocalProviderConfigLoader } from '../provider/local-config.js';

/** 按优先级查找 llama-server 二进制路径 */
function resolveLlamaServerPath(): string | null {
  const candidates: (string | null)[] = [
    // 1. 项目内置（编译后）
    path.resolve(process.cwd(), 'libs/llama.cpp/build/bin/Release/llama-server.exe'),
    // 2. 环境变量
    process.env.LLAMA_SERVER_PATH ?? null,
    // 3. 系统 PATH
    'llama-server',
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // 对于 PATH 中的，用 where 检查
    if (candidate === 'llama-server') {
      try {
        execSync('where llama-server', { stdio: 'ignore' });
        return candidate;
      } catch {
        continue;
      }
    }
    // 对于文件路径，检查是否存在且可执行
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 文件不存在
    }
  }

  return null;
}

/**
 * 本地模型后端预设 — 根据 backend 类型生成 ManagedProcessConfig。
 */
const BACKEND_PRESETS: Record<LocalModelBackend, (cfg: LocalModelConfig) => { command: string; args: string[]; healthUrl: string; modelName: string } | null> = {
  'llama.cpp': (cfg) => {
    const modelPath = cfg.modelPath;
    if (!modelPath) return null;

    const serverPath = resolveLlamaServerPath();
    if (!serverPath) {
      throw new Error(
        'llama-server not found. Please run: npm run setup-llamacpp\n' +
        'Or install llama.cpp manually and set LLAMA_SERVER_PATH environment variable.'
      );
    }

    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(cfg.port ?? getLocalProviderConfigLoader().port),
      '-c', String(cfg.ctxSize ?? 4096),
      '-ngl', String(cfg.nGpuLayers ?? 0),
      ...(cfg.extraArgs ?? []),
    ];
    return {
      command: serverPath,
      args,
      healthUrl: `http://127.0.0.1:${cfg.port ?? getLocalProviderConfigLoader().port}/v1/models`,
      modelName: cfg.modelName ?? path.basename(modelPath, '.gguf'),
    };
  },

  ollama: (cfg) => {
    const model = cfg.ollamaModel;
    if (!model) return null;
    const port = cfg.port ?? 11434;
    return {
      command: 'ollama',
      args: ['serve'],
      healthUrl: `http://127.0.0.1:${port}/api/tags`,
      modelName: cfg.modelName ?? model,
    };
  },

  vllm: (cfg) => {
    const model = cfg.modelPath;
    if (!model) return null;
    const port = cfg.port ?? 8000;
    const args = [
      '--model', model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--max-model-len', String(cfg.ctxSize ?? 4096),
      ...(cfg.extraArgs ?? []),
    ];
    return {
      command: 'vllm',
      args: ['serve', ...args],
      healthUrl: `http://127.0.0.1:${port}/v1/models`,
      modelName: cfg.modelName ?? model,
    };
  },

  'lm-studio': (_cfg) => {
    // LM Studio 需用户手动启动，此处只做健康检查
    return null;
  },

  custom: (cfg) => {
    if (!cfg.modelPath) return null;
    const port = cfg.port ?? getLocalProviderConfigLoader().port;
    return {
      command: cfg.modelPath,
      args: cfg.extraArgs ?? [],
      healthUrl: `http://127.0.0.1:${port}/v1/models`,
      modelName: cfg.modelName ?? 'custom',
    };
  },
};

// ── 进程管理 / 健康检查默认值 ──
// 这些值在 models.json 中没有配置对应字段时使用。
// 可通过 LocalModelConfig 的对应字段逐模型覆盖。

/** 崩溃后自动重启的延迟（毫秒） */
const DEFAULT_RESTART_DELAY_MS = 3000;
/** 健康检查轮询间隔（毫秒） */
const DEFAULT_HEALTH_INTERVAL_MS = 5000;
/** 单次健康检查 HTTP 请求超时（毫秒） */
const DEFAULT_HEALTH_TIMEOUT_MS = 5000;
/** 启动阶段健康检查失败最大重试次数 */
const DEFAULT_HEALTH_MAX_RETRIES = 6;
/** 进程启动后等待首次健康检查通过的总超时（毫秒） */
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

/** 本地模型配置加载路径 */
const MODEL_CONFIG_PATHS = ['.agent/models.json', '.agent/local-models.json'];

export interface LoadedModelInfo {
  name: string;
  backend: LocalModelBackend;
  port: number;
  modelName: string;   // 传给 LocalProvider 的 model 名称
  baseUrl: string;     // 传给 LocalProvider 的 baseUrl
}

/**
 * LocalModelManager — 管理本地推理服务进程的生命周期。
 *
 * 职责：
 *   1. 从配置文件加载模型配置
 *   2. 根据 backend 类型自动生成启动命令和健康检查
 *   3. 委托 ProcessManager 管理进程
 *   4. 提供启动/停止/状态查询
 */
export class LocalModelManager {
  private managers: Map<string, ProcessManager> = new Map();
  private models: LoadedModelInfo[] = [];

  /** 从项目目录加载模型配置并启动 */
  async loadAndStart(projectDir: string, callbacks?: ProcessEventCallbacks): Promise<LoadedModelInfo[]> {
    const configs = this.loadConfig(projectDir);
    this.models = [];

    for (const [name, cfg] of Object.entries(configs)) {
      const preset = BACKEND_PRESETS[cfg.backend]?.(cfg);
      if (!preset) {
        // lm-studio 或无效配置 — 跳过自动启动，只做健康检查等待
        if (cfg.backend === 'lm-studio') {
          const port = cfg.port ?? 1234;
          this.models.push({
            name,
            backend: 'lm-studio',
            port,
            modelName: cfg.modelName ?? 'lm-studio-model',
            baseUrl: `http://127.0.0.1:${port}/v1`,
          });
        }
        continue;
      }

      const healthUrl = preset.healthUrl;
      const pm = new ProcessManager(
        {
          name: `model-${name}`,
          command: preset.command,
          args: preset.args,
          autoRestart: true,
          maxRestarts: 3,
          restartDelayMs: cfg.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
          healthCheck: {
            url: healthUrl,
            intervalMs: cfg.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
            timeoutMs: cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
            maxRetries: cfg.healthMaxRetries ?? DEFAULT_HEALTH_MAX_RETRIES,
          },
          startupTimeoutMs: cfg.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        },
        callbacks,
      );

      this.managers.set(name, pm);

      try {
        await pm.start();
      } catch {
        // 启动失败不阻断后续模型
      }

      const port = cfg.port ?? getLocalProviderConfigLoader().port;
      this.models.push({
        name,
        backend: cfg.backend,
        port,
        modelName: preset.modelName,
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
    }

    return this.models;
  }

  /** 启动单个已注册的模型 */
  async startModel(name: string): Promise<void> {
    const pm = this.managers.get(name);
    if (!pm) throw new Error(`Unknown model: ${name}`);
    await pm.start();
  }

  /**
   * 运行时按需启动单个模型。
   * 如果模型尚未注册，则从配置加载并启动。
   * 用于用户在运行时切换 provider 到 local 的场景。
   */
  async startModelOnDemand(
    projectDir: string,
    modelKey: string,
    callbacks?: ProcessEventCallbacks,
  ): Promise<LoadedModelInfo | null> {
    const existingPM = this.managers.get(modelKey);
    if (existingPM) {
      if (existingPM.getState() === 'running') {
        const existingModel = this.models.find((m) => m.name === modelKey);
        if (existingModel) return existingModel;
      }
      await existingPM.start();
      const existingModel = this.models.find((m) => m.name === modelKey);
      if (existingModel) return existingModel;
    }

    const configs = this.loadConfig(projectDir);
    const cfg = configs[modelKey];
    if (!cfg) return null;

    const preset = BACKEND_PRESETS[cfg.backend]?.(cfg);
    if (!preset) return null;

    const pm = new ProcessManager(
      {
        name: `model-${modelKey}`,
        command: preset.command,
        args: preset.args,
        autoRestart: true,
        maxRestarts: 3,
        restartDelayMs: cfg.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
        healthCheck: {
          url: preset.healthUrl,
          intervalMs: cfg.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
          timeoutMs: cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
          maxRetries: cfg.healthMaxRetries ?? DEFAULT_HEALTH_MAX_RETRIES,
        },
        startupTimeoutMs: cfg.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      },
      callbacks,
    );

    this.managers.set(modelKey, pm);

    await pm.start();

    const port = cfg.port ?? getLocalProviderConfigLoader().port;
    const info: LoadedModelInfo = {
      name: modelKey,
      backend: cfg.backend,
      port,
      modelName: preset.modelName,
      baseUrl: `http://127.0.0.1:${port}/v1`,
    };

    this.models.push(info);
    return info;
  }

  /** 停止单个模型 */
  async stopModel(name: string): Promise<void> {
    const pm = this.managers.get(name);
    if (!pm) throw new Error(`Unknown model: ${name}`);
    await pm.stop();
  }

  /** 停止所有模型 */
  async stopAll(): Promise<void> {
    const results = Array.from(this.managers.values()).map((pm) => pm.stop());
    await Promise.all(results);
    this.managers.clear();
  }

  /** 获取所有已加载的模型信息 */
  getModels(): LoadedModelInfo[] {
    return this.models;
  }

  /** 获取特定模型的状态 */
  getModelStatus(name: string) {
    const pm = this.managers.get(name);
    if (!pm) return null;
    return pm.getStatus();
  }

  /** 获取所有模型的状态 */
  getAllStatus() {
    return Array.from(this.managers.entries()).map(([, pm]) => ({
      ...pm.getStatus(),
    }));
  }

  /** 获取指定模型的 ProcessManager 实例 */
  getProcessManager(name: string): ProcessManager | undefined {
    return this.managers.get(name);
  }

  /** 检查是否有任何模型正在运行 */
  hasRunningModel(): boolean {
    for (const pm of this.managers.values()) {
      if (pm.getState() === 'running') return true;
    }
    return false;
  }

  // ===== 配置加载 =====

  private loadConfig(projectDir: string): Record<string, LocalModelConfig> {
    for (const configPath of MODEL_CONFIG_PATHS) {
      try {
        const fullPath = path.join(projectDir, configPath);
        accessSync(fullPath, constants.R_OK);
        const content = readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.models && typeof parsed.models === 'object') {
          return parsed.models as Record<string, LocalModelConfig>;
        }
      } catch {
        continue;
      }
    }
    return {};
  }
}

/**
 * 从已加载的模型列表中为 LocalProvider 选择可用配置。
 * 优先选择第一个 running 的模型，否则返回第一个。
 */
export function pickModelForProvider(models: LoadedModelInfo[], modelName?: string): LoadedModelInfo | null {
  if (models.length === 0) return null;

  if (modelName) {
    const found = models.find((m) => m.name === modelName || m.modelName === modelName);
    if (found) return found;
  }

  return models[0];
}