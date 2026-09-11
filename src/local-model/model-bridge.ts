import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../lifecycle/manager.js';
import { createLogger } from '../logging/logger.js';
import { DownloadManager } from './download-manager.js';
import type { ManagedProcessConfig, ProcessState, ProcessEventCallbacks } from '../lifecycle/interface.js';
import { getOllamaEndpoints } from '../provider/local-config.js';
import { ModelRegistry } from './model-registry.js';
import type { ModelEntry, ModelRegisterOptions, RunningModelInfo } from './types.js';

export type { RunningModelInfo };

const logger = createLogger('model-bridge');

declare interface ModelBridgeEvents {
  'model-starting': [string];
  'model-running': [RunningModelInfo];
  'model-stopped': [string];
  'model-error': [string, string];
  'active-changed': [string | null];
  'all-stopped': [];
  'binary-downloading': [];
  'binary-progress': [number, string];
  'binary-ready': [string];
  'binary-error': [string];
}

/**
 * 模型桥接层 — 连接 ModelRegistry 与 llama-server 进程
 */
export class ModelBridge extends EventEmitter<ModelBridgeEvents> {
  private managers = new Map<string, ProcessManager>();
  private lastStartedModel: string | null = null;
  private runningPorts = new Map<string, number>();
  private registry: ModelRegistry;
  private projectRoot: string;
  /** llama-server 二进制路径；null = 缺失（start 时自动下载自愈） */
  private llamaServerPath: string | null;
  /** 进行中的二进制下载 Promise（幂等：并发触发只下载一次） */
  private ensureBinaryPromise: Promise<string | null> | null = null;
  /** 下载器（可注入替身以便测试；默认 DownloadManager 从 GitHub release 拉取） */
  private downloader: {
    download(projectRoot: string, onProgress?: (percent: number, speed: string) => void): Promise<string>;
  };

  constructor(projectRoot: string, llamaServerPath?: string | null, downloader?: ModelBridge['downloader']) {
    super();
    this.projectRoot = projectRoot;
    this.registry = ModelRegistry.getInstance();
    this.downloader = downloader ?? new DownloadManager();

    if (llamaServerPath && existsSync(llamaServerPath)) {
      this.llamaServerPath = llamaServerPath;
    } else {
      this.llamaServerPath = this.resolveServerPath();
    }
  }

  /** 按优先级查找 libs/llama.cpp 下的 llama-server 二进制；找不到返回 null */
  private resolveServerPath(): string | null {
    const candidates = [
      join(this.projectRoot, 'libs', 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
      join(this.projectRoot, 'libs', 'llama.cpp', 'build', 'bin', 'llama-server'),
      join(this.projectRoot, 'libs', 'llama.cpp', 'llama-server.exe'),
      join(this.projectRoot, 'libs', 'llama.cpp', 'llama-server'),
      'llama-server',
      'llama-server.exe',
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  // ── 生命周期 ──

  /**
   * 确保 llama-server 二进制可用（自愈）。
   * 已存在 → 直接返回路径；缺失 → 先查 PATH，仍无 → 自动下载（幂等：并发只下载一次）。
   * @returns 可用的 llama-server 路径；下载失败返回 null
   */
  async ensureBinary(): Promise<string | null> {
    if (this.llamaServerPath && existsSync(this.llamaServerPath)) {
      return this.llamaServerPath;
    }
    this.llamaServerPath = null; // 原路径已失效

    if (this.ensureBinaryPromise) return this.ensureBinaryPromise;

    // PATH 中已有 llama-server 则直接使用（无需下载）
    if (this.hasLlamaServerInPath()) {
      this.llamaServerPath = 'llama-server';
      return this.llamaServerPath;
    }

    // 触发下载（同一 Promise 去重，不阻塞其它模型启动）
    this.emit('binary-downloading');
    let lastReported = -1;
    const p = this.downloader
      .download(this.projectRoot, (percent, speed) => {
        if (percent >= lastReported + 5 || percent === 100) {
          lastReported = percent;
          this.emit('binary-progress', percent, speed);
          logger.info('llama.cpp downloading', { percent, speed });
        }
      })
      .then((version) => {
        this.llamaServerPath = this.resolveServerPath();
        this.ensureBinaryPromise = null;
        this.emit('binary-ready', version);
        logger.info('llama.cpp ready', { version, path: this.llamaServerPath });
        return this.llamaServerPath;
      })
      .catch((error: unknown) => {
        this.ensureBinaryPromise = null;
        const msg = error instanceof Error ? error.message : String(error);
        this.emit('binary-error', msg);
        logger.warn('llama.cpp download failed', { error: msg });
        return null;
      });
    this.ensureBinaryPromise = p;
    return p;
  }

  /** 检查 PATH 中是否存在 llama-server 命令 */
  private hasLlamaServerInPath(): boolean {
    try {
      execSync(process.platform === 'win32' ? 'where llama-server' : 'which llama-server', {
        stdio: 'ignore',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async startAll(): Promise<RunningModelInfo[]> {
    const models = this.registry.list().filter((m) => m.enabled);
    const results: RunningModelInfo[] = [];

    for (const model of models) {
      const info = await this.start(model.name);
      if (info) results.push(info);
    }

    return results;
  }

  async start(name: string): Promise<RunningModelInfo | null> {
    const model = this.registry.find(name);
    if (!model) return null;

    const existing = this.managers.get(name);
    if (existing) {
      if (existing.getState() === 'running') {
        return this.toRunningInfo(model);
      }
      await existing.start();
      return this.toRunningInfo(model);
    }

    // llama.cpp 后端：确保二进制可用（缺失时自动下载自愈）
    if (model.backend !== 'ollama' && model.backend !== 'vllm' && model.backend !== 'custom' && model.backend !== 'lm-studio') {
      const serverPath = await this.ensureBinary();
      if (!serverPath) {
        this.emit('model-error', name, 'llama.cpp binary unavailable (auto-download failed)');
        return null;
      }
    }

    const config = this.buildConfig(model);
    if (!config) {
      // LM Studio 等需手动启动的后端：注册条目存在但无进程可拉起
      return null;
    }
    const actualPort = this.extractPortFromConfig(config);
    this.runningPorts.set(name, actualPort);

    const callbacks: ProcessEventCallbacks = {
      onStateChange: (_name: string, _from: ProcessState, to: ProcessState) => {
        if (to === 'running') {
          this.lastStartedModel = name;
          this.emit('active-changed', name);
          this.emit('model-running', this.toRunningInfo(model));
        } else if (to === 'stopped' || to === 'failed' || to === 'crashed') {
          if (this.lastStartedModel === name) {
            this.lastStartedModel = null;
            this.emit('active-changed', null);
          }
          if (to === 'failed' || to === 'crashed') {
            this.emit('model-error', name, `Process ${to}`);
          }
        }
      },
      onCrash: (_name: string, exitCode: number | null) => {
        this.emit('model-error', name, `Crashed exit=${exitCode}`);
      },
    };

    const pm = new ProcessManager(config, callbacks);
    this.managers.set(name, pm);

    this.emit('model-starting', name);
    await pm.start();

    if (pm.getState() !== 'running') {
      this.emit('model-error', name, 'Failed to start');
      return null;
    }

    return this.toRunningInfo(model);
  }

  async stop(name: string): Promise<void> {
    const pm = this.managers.get(name);
    if (!pm) return;

    await pm.stop();
    this.managers.delete(name);
    this.runningPorts.delete(name);
    this.emit('model-stopped', name);

    if (this.lastStartedModel === name) {
      this.lastStartedModel = null;
      this.emit('active-changed', null);
    }
  }

  async switch(toName: string, options?: { stopOthers?: boolean }): Promise<RunningModelInfo | null> {
    const target = this.registry.find(toName);
    if (!target) return null;

    if (options?.stopOthers) {
      const others = Array.from(this.managers.keys()).filter((n) => n !== toName);
      await Promise.all(others.map((n) => this.stop(n)));
    } else if (this.lastStartedModel && this.lastStartedModel !== toName) {
      await this.stop(this.lastStartedModel);
    }

    return this.start(toName);
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.managers.keys()).map((name) => this.stop(name));
    await Promise.all(stops);
    this.lastStartedModel = null;
    this.emit('active-changed', null);
    this.emit('all-stopped');
  }

  // ── 状态查询 ──

  getAllStatus(): Array<{ name: string; state: ProcessState; pid: number | null }> {
    return Array.from(this.managers.entries()).map(([name, pm]) => ({
      name,
      state: pm.getState(),
      pid: pm.getStatus().pid,
    }));
  }

  getActiveModel(): string | null {
    return this.lastStartedModel;
  }

  getProcessManager(name: string): ProcessManager | undefined {
    return this.managers.get(name);
  }

  getAllProcessManagers(): ProcessManager[] {
    return Array.from(this.managers.values());
  }

  isRunning(name: string): boolean {
    const pm = this.managers.get(name);
    return pm ? pm.getState() === 'running' : false;
  }

  // ── 注册/注销 ──

  registerModel(options: ModelRegisterOptions): ModelEntry {
    return this.registry.register(options);
  }

  unregisterModel(name: string): boolean {
    if (this.isRunning(name)) {
      this.stop(name);
    }
    return this.registry.unregister(name);
  }

  // ── 内部 ──

  private buildConfig(model: ModelEntry): ManagedProcessConfig | null {
    const port = model.port ?? this.findAvailablePort(model.backend);
    const host = model.host ?? '127.0.0.1';

    // Ollama backend
    if (model.backend === 'ollama') {
      return {
        name: model.name,
        command: this.resolveOllamaPath(),
        args: ['serve'],
        autoRestart: false,
        healthCheck: {
          url: `http://${host}:${port}/api/tags`,
          intervalMs: 5000,
          timeoutMs: 3000,
          maxRetries: 5,
        },
      };
    }

    // vLLM backend（D3 并入 BACKEND_PRESETS 的 vllm 预设）
    if (model.backend === 'vllm') {
      const args = [
        'serve',
        '--model', model.modelPath,
        '--host', host,
        '--port', String(port),
      ];
      if (model.ctxSize) args.push('--max-model-len', String(model.ctxSize));
      if (model.nGpuLayers && model.nGpuLayers > 0) args.push('-ngl', String(model.nGpuLayers));
      args.push(...(model.extraArgs ?? []));
      return {
        name: model.name,
        command: 'vllm',
        args,
        autoRestart: false,
        healthCheck: {
          url: `http://${host}:${port}/v1/models`,
          intervalMs: 5000,
          timeoutMs: 3000,
          maxRetries: 5,
        },
      };
    }

    // custom backend（D3 并入 BACKEND_PRESETS 的 custom 预设：modelPath 即可执行文件）
    if (model.backend === 'custom') {
      return {
        name: model.name,
        command: model.modelPath,
        args: model.extraArgs ?? [],
        autoRestart: false,
        healthCheck: {
          url: `http://${host}:${port}/v1/models`,
          intervalMs: 5000,
          timeoutMs: 3000,
          maxRetries: 5,
        },
      };
    }

    // LM Studio：需用户手动启动，无进程可拉起——返回 null（start 跳过）
    if (model.backend === 'lm-studio') {
      return null;
    }

    // llama.cpp backend (default)
    const args = [
      '-m', model.modelPath,
      '--host', host,
      '--port', String(port),
    ];

    if (model.ctxSize) {
      args.push('-c', String(model.ctxSize));
    }

    if (model.nGpuLayers && model.nGpuLayers > 0) {
      args.push('-ngl', String(model.nGpuLayers));
    }

    return {
      name: model.name,
      command: this.llamaServerPath ?? 'llama-server',
      args,
      autoRestart: false,
      healthCheck: {
        url: `http://${host}:${port}/health`,
        intervalMs: 5000,
        timeoutMs: 3000,
        maxRetries: 5,
      },
    };
  }

  private resolveOllamaPath(): string {
    const candidates = [
      join(process.cwd(), 'libs', 'ollama', 'ollama.exe'),
      join(process.cwd(), 'libs', 'ollama', 'ollama'),
      'ollama',
      'ollama.exe',
    ];
    const found = candidates.find((c) => existsSync(c));
    return found ?? 'ollama';
  }

  private findAvailablePort(backend?: string): number {
    const used = new Set<number>();

    for (const [, pm] of this.managers) {
      const hc = pm.config.healthCheck;
      if (hc?.url) {
        const m = hc.url.match(/:(\d+)/);
        if (m) used.add(parseInt(m[1], 10));
      }
    }

    for (const e of this.registry.list()) {
      if (e.port) used.add(e.port);
    }

    const startPort = backend === 'ollama' ? getOllamaEndpoints().port : 8080;
    const maxPort = startPort + 20;
    for (let p = startPort; p < maxPort; p++) {
      if (!used.has(p)) return p;
    }
    return startPort;
  }

  private extractPortFromConfig(config: ManagedProcessConfig): number {
    if (!config.args) return 8080;
    const portIdx = config.args.indexOf('--port');
    if (portIdx !== -1 && portIdx + 1 < config.args.length) {
      return parseInt(config.args[portIdx + 1], 10);
    }
    return 8080;
  }

  private toRunningInfo(model: ModelEntry): RunningModelInfo {
    const pm = this.managers.get(model.name);
    const port = this.runningPorts.get(model.name) ?? model.port ?? 8080;
    const host = model.host ?? '127.0.0.1';

    return {
      name: model.name,
      modelFile: model.modelFile,
      backend: model.backend,
      port,
      host,
      state: pm ? pm.getState() : 'stopped',
      pid: pm ? pm.getStatus().pid : null,
      baseUrl: `http://${host}:${port}/v1`,
    };
  }
}