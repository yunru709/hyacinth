import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../lifecycle/manager.js';
import type { ManagedProcessConfig, ProcessState, ProcessEventCallbacks } from '../lifecycle/interface.js';
import { ModelRegistry } from './model-registry.js';
import type { ModelEntry, ModelRegisterOptions, RunningModelInfo } from './types.js';

export type { RunningModelInfo };

declare interface ModelBridgeEvents {
  'model-starting': [string];
  'model-running': [RunningModelInfo];
  'model-stopped': [string];
  'model-error': [string, string];
  'active-changed': [string | null];
  'all-stopped': [];
}

/**
 * 模型桥接层 — 连接 ModelRegistry 与 llama-server 进程
 */
export class ModelBridge extends EventEmitter<ModelBridgeEvents> {
  private managers = new Map<string, ProcessManager>();
  private lastStartedModel: string | null = null;
  private runningPorts = new Map<string, number>();
  private registry: ModelRegistry;
  private llamaServerPath: string;

  constructor(llamaServerPath?: string) {
    super();
    this.registry = ModelRegistry.getInstance();

    if (llamaServerPath && existsSync(llamaServerPath)) {
      this.llamaServerPath = llamaServerPath;
    } else {
      const candidates = [
        join(process.cwd(), 'libs', 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
        join(process.cwd(), 'libs', 'llama.cpp', 'build', 'bin', 'llama-server'),
        join(process.cwd(), 'libs', 'llama.cpp', 'llama-server.exe'),
        join(process.cwd(), 'libs', 'llama.cpp', 'llama-server'),
        'llama-server',
        'llama-server.exe',
      ];
      const found = candidates.find((c) => existsSync(c));
      this.llamaServerPath = found ?? 'llama-server';
    }
  }

  // ── 生命周期 ──

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

    const config = this.buildConfig(model);
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

  private buildConfig(model: ModelEntry): ManagedProcessConfig {
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
      command: this.llamaServerPath,
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

    const startPort = backend === 'ollama' ? 11434 : 8080;
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