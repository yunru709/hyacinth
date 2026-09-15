import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelEntry, ModelBackend, ModelRegisterOptions } from './types.js';

export type { ModelEntry, ModelBackend, ModelRegisterOptions };

declare interface ModelRegistryEvents {
  changed: [];
  added: [ModelEntry];
  removed: [ModelEntry];
}

/**
 * 模型注册中心 — 管理 models.json 与 models/ 目录
 *
 * P-Config 收敛：本地模型是 agent 自身的资源（GGUF 文件大，与项目无关），
 * 统一放全局 ~/.agent/：
 * - 读写 ~/.agent/models.json 作为模型注册表
 * - 扫描 ~/.agent/models/ 目录发现未注册的 GGUF 文件
 * - 热插拔：监听 models/ 目录变更
 * - 增删改查模型注册项
 */
export class ModelRegistry extends EventEmitter<ModelRegistryEvents> {
  private entries: ModelEntry[] = [];
  private registryPath: string;
  private modelsDir: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private static instance: ModelRegistry | null = null;

  static getInstance(projectRoot?: string): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry(projectRoot ?? process.cwd());
    }
    return ModelRegistry.instance;
  }

  private constructor(projectRoot: string) {
    super();
    // P-Config 收敛：projectRoot 保留仅为调用方兼容，实际统一走全局 ~/.agent/
    this.registryPath = join(homedir(), '.agent', 'models.json');
    this.modelsDir = join(homedir(), '.agent', 'models');
  }

  // ── 初始化 ──

  init(): ModelEntry[] {
    this.load();
    this.scanAndMerge();
    this.startWatcher();
    return this.entries;
  }

  destroy(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.removeAllListeners();
    ModelRegistry.instance = null;
  }

  // ── 持久化 ──

  private load(): void {
    if (!existsSync(this.registryPath)) {
      this.entries = [];
      return;
    }
    try {
      const raw = readFileSync(this.registryPath, 'utf-8');
      this.entries = JSON.parse(raw);
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    writeFileSync(this.registryPath, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  // ── 目录扫描 ──

  scanDirectory(): string[] {
    if (!existsSync(this.modelsDir)) {
      return [];
    }
    return readdirSync(this.modelsDir).filter(
      (f) => f.endsWith('.gguf') || f.endsWith('.GGUF'),
    );
  }

  /**
   * 扫描 models/ 目录，自动发现未注册的 GGUF 文件并添加到注册表。
   * 返回新发现并注册的条目。
   */
  scanAndMerge(): ModelEntry[] {
    const ggufFiles = this.scanDirectory();
    const registeredFiles = new Set(this.entries.map((e) => e.modelFile));
    const newlyAdded: ModelEntry[] = [];

    for (const file of ggufFiles) {
      if (registeredFiles.has(file)) continue;

      const entry: ModelEntry = {
        name: basename(file, this.getExtension(file)),
        modelFile: file,
        modelPath: join(this.modelsDir, file),
        backend: 'llama.cpp',
        addedAt: new Date().toISOString(),
        enabled: true,
      };
      this.entries.push(entry);
      newlyAdded.push(entry);
    }

    if (newlyAdded.length > 0) {
      this.save();
      for (const e of newlyAdded) {
        this.emit('added', e);
      }
      this.emit('changed');
    }

    return newlyAdded;
  }

  // ── 热插拔 ──

  private startWatcher(): void {
    if (this.watcher) return;
    if (!existsSync(this.modelsDir)) {
      return;
    }
    try {
      this.watcher = watch(this.modelsDir, (_eventType, filename) => {
        if (filename && (filename.endsWith('.gguf') || filename.endsWith('.GGUF'))) {
          // 延迟一下等文件写完
          setTimeout(() => this.scanAndMerge(), 500);
        }
      });
    } catch {
      // watch 可能在部分环境下不可用，静默忽略
    }
  }

  // ── CRUD ──

  register(options: ModelRegisterOptions): ModelEntry {
    const existing = this.find(options.name);
    const backend = options.backend ?? 'llama.cpp';
    const modelPath = join(this.modelsDir, options.modelFile);

    // 仅 llama.cpp 需要验证 GGUF 文件存在；Ollama 模型由 ollama 管理
    if (backend === 'llama.cpp' && !existsSync(modelPath)) {
      throw new Error(
        `模型文件不存在: ${modelPath}\n` +
        `请将 ${options.modelFile} 放到 ${this.modelsDir} 目录下。`,
      );
    }

    const entry: ModelEntry = {
      name: options.name,
      modelFile: options.modelFile,
      modelPath: backend === 'ollama' ? options.modelFile : modelPath,
      backend,
      port: options.port,
      host: options.host,
      ctxSize: options.ctxSize,
      nGpuLayers: options.nGpuLayers,
      addedAt: new Date().toISOString(),
      enabled: true,
    };

    if (existing) {
      Object.assign(existing, entry);
    } else {
      this.entries.push(entry);
    }

    this.save();
    this.emit('changed');
    this.emit('added', entry);
    return entry;
  }

  unregister(name: string): boolean {
    const idx = this.entries.findIndex((e) => e.name === name);
    if (idx === -1) return false;
    const removed = this.entries.splice(idx, 1)[0];
    this.save();
    this.emit('changed');
    this.emit('removed', removed);
    return true;
  }

  // ── 查询 ──

  list(): ModelEntry[] {
    return [...this.entries];
  }

  find(name: string): ModelEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  findByPort(port: number): ModelEntry | undefined {
    return this.entries.find((e) => e.port === port);
  }

  count(): number {
    return this.entries.length;
  }

  // ── 常用路径 ──

  getModelsDir(): string {
    return this.modelsDir;
  }

  getRegistryPath(): string {
    return this.registryPath;
  }

  // ── 私有 ──

  private getExtension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(dot) : '';
  }
}