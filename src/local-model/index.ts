import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ModelRegistry } from './model-registry.js';
import { ModelBridge } from './model-bridge.js';
import type { ModelEntry, ModelRegisterOptions, RunningModelInfo } from './types.js';
import type { ProcessState } from '../lifecycle/interface.js';

/**
 * LocalModelModule — 本地模型门面类。
 *
 * 对外暴露统一的本地模型管理 API，内部持有 ModelRegistry 和 ModelBridge 实例，
 * 所有方法 delegate 到内部类。
 */
export class LocalModelModule {
  private static instance: LocalModelModule | null = null;

  private registry: ModelRegistry;
  private bridge: ModelBridge;
  private initialized = false;

  static getInstance(): LocalModelModule {
    if (!LocalModelModule.instance) {
      LocalModelModule.instance = new LocalModelModule();
    }
    return LocalModelModule.instance;
  }

  private constructor() {
    this.registry = ModelRegistry.getInstance();
    this.bridge = new ModelBridge();
  }

  // ── 初始化 ──

  /**
   * 初始化注册表，检测 llama-server 路径。
   *
   * @param projectRoot - 项目根目录
   */
  initialize(projectRoot: string): void {
    // 确保单例指向正确的项目根目录
    this.registry = ModelRegistry.getInstance(projectRoot);
    this.registry.init();

    // 重新创建 bridge 以使用正确的 llama-server 路径
    this.bridge = new ModelBridge(this.resolveLlamaServerPath(projectRoot));
    this.initialized = true;
  }

  // ── 生命周期 ──

  /**
   * 启动指定模型。
   *
   * @param modelName - 模型名称
   * @returns 运行中的模型信息，若模型不存在或启动失败则返回 null
   */
  async start(modelName: string): Promise<RunningModelInfo | null> {
    return this.bridge.start(modelName);
  }

  /**
   * 启动所有 enabled 的已注册模型（D3：supervisor.loadAndStartModels 用）。
   *
   * @returns 成功启动的模型信息数组
   */
  async startAll(): Promise<RunningModelInfo[]> {
    return this.bridge.startAll();
  }

  /**
   * 停止指定模型。
   *
   * @param modelName - 模型名称
   */
  async stop(modelName: string): Promise<void> {
    await this.bridge.stop(modelName);
  }

  /**
   * 切换到指定模型（停止当前活跃模型，启动新模型）。
   *
   * @param modelName - 目标模型名称
   * @returns 运行中的模型信息，若目标模型不存在则返回 null
   */
  async switch(modelName: string): Promise<RunningModelInfo | null> {
    return this.bridge.switch(modelName);
  }

  // ── 查询 ──

  /**
   * 列出所有已注册的模型。
   *
   * @returns 模型条目数组
   */
  list(): ModelEntry[] {
    return this.registry.list();
  }

  /**
   * 获取当前活跃（最后启动/切换）的模型名称。
   *
   * @returns 活跃模型名称，若无则返回 null
   */
  getActive(): string | null {
    return this.bridge.getActiveModel();
  }

  /**
   * 派生传给 LocalProvider 的 model 名（D3：替代 LocalModelManager 的 preset.modelName）。
   *
   * llama.cpp 类：modelFile 去 .gguf 扩展名（如 Qwen3.5-0.8B-IQ4_XS.gguf → Qwen3.5-0.8B-IQ4_XS）；
   * ollama 类：modelFile 即模型名。未注册返回 null。
   */
  getModelName(modelName: string): string | null {
    const entry = this.registry.find(modelName);
    if (!entry) return null;
    if (entry.backend === 'ollama') return entry.modelFile;
    return entry.modelFile.replace(/\.(gguf|gguf\.safetensors|bin)$/i, '');
  }

  // ── 配置 ──

  /**
   * 调整模型参数（更新注册表中的配置）。
   *
   * @param modelName - 模型名称
   * @param options - 要更新的选项（port, ctxSize, nGpuLayers 等）
   * @returns 更新后的模型条目，若模型不存在则返回 undefined
   */
  configure(modelName: string, options: Partial<ModelRegisterOptions>): ModelEntry | undefined {
    const existing = this.registry.find(modelName);
    if (!existing) return undefined;

    return this.registry.register({
      name: modelName,
      modelFile: options.modelFile ?? existing.modelFile,
      backend: options.backend ?? existing.backend,
      port: options.port ?? existing.port,
      host: options.host ?? existing.host,
      ctxSize: options.ctxSize ?? existing.ctxSize,
      nGpuLayers: options.nGpuLayers ?? existing.nGpuLayers,
    });
  }

  // ── llama.cpp 检测 ──

  /**
   * 检测 llama.cpp 是否已安装（llama-server 二进制是否可用）。
   *
   * @returns 若找到则返回 llama-server 的路径，否则返回 null
   */
  checkLlamacpp(): string | null {
    return this.resolveLlamaServerPath(process.cwd());
  }

  /** 检测 Ollama 是否已安装 */
  checkOllama(): string | null {
    const candidates = [
      join(process.cwd(), 'libs', 'ollama', 'ollama.exe'),
      join(process.cwd(), 'libs', 'ollama', 'ollama'),
      'ollama',
      'ollama.exe',
    ];
    for (const c of candidates) {
      try {
        const result = execSync(`"${c}" --version`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (result.trim()) return c;
      } catch { /* continue */ }
    }
    return null;
  }

  /** 查询 Ollama 已安装的模型列表，返回可注册的模型名 */
  async listOllamaModels(): Promise<{ name: string; modelFile: string }[]> {
    const ollamaPath = this.checkOllama();
    if (!ollamaPath) return [];
    try {
      const output = execSync(`"${ollamaPath}" list`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = output.trim().split('\n').slice(1); // skip header
      return lines.map(line => {
        const name = line.split(/\s+/)[0] ?? line.trim();
        return { name, modelFile: name };
      }).filter(m => m.name);
    } catch { return []; }
  }

  // ── 便捷方法 ──

  /** 获取底层 ModelRegistry 实例 */
  getRegistry(): ModelRegistry {
    return this.registry;
  }

  /** 获取底层 ModelBridge 实例 */
  getBridge(): ModelBridge {
    return this.bridge;
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** 注册新模型 */
  registerModel(options: ModelRegisterOptions): ModelEntry {
    return this.registry.register(options);
  }

  /** 注销模型 */
  unregisterModel(name: string): boolean {
    return this.registry.unregister(name);
  }

  /**
   * 扫描 models/ 目录中尚未注册的 GGUF 文件。
   *
   * @returns 未注册的模型名称和文件名列表
   */
  async scanUnregistered(): Promise<{ name: string; modelFile: string; backend?: string }[]> {
    // llama.cpp: 扫描 models/ 目录中的 .gguf 文件
    const allFiles = this.registry.scanDirectory();
    const registered = new Set(this.registry.list().map((e) => e.modelFile));
    const ggufResults = allFiles
      .filter((f) => !registered.has(f))
      .map((f) => {
        const lastDot = f.lastIndexOf('.');
        const name = lastDot >= 0 ? f.slice(0, lastDot) : f;
        return { name, modelFile: f, backend: 'llama.cpp' as const };
      });

    // Ollama: 查询 ollama list 获取已安装模型
    const ollamaModels = await this.listOllamaModels();
    const ollamaResults = ollamaModels
      .filter((m) => !registered.has(m.modelFile))
      .map((m) => ({ ...m, backend: 'ollama' as const }));

    return [...ggufResults, ...ollamaResults];
  }

  /**
   * 返回所有本地模型的可读状态摘要。
   */
  status(): string {
    const all: Array<{ name: string; state: ProcessState; pid: number | null }> =
      this.bridge.getAllStatus();
    if (all.length === 0) {
      return 'No local models registered.';
    }
    const lines = all.map((s) => {
      const pidStr = s.pid !== null ? ` (PID ${s.pid})` : '';
      return `  ${s.name}: ${s.state}${pidStr}`;
    });
    return `Local Models:\n${lines.join('\n')}`;
  }

  /**
   * 注销指定模型并返回操作结果描述。
   */
  unregister(name: string): string {
    const ok = this.bridge.unregisterModel(name);
    return ok ? `Model ${name} unregistered.` : `Model ${name} not found.`;
  }

  // ── 内部 ──

  /**
   * 按优先级查找 llama-server 二进制路径。
   */
  private resolveLlamaServerPath(projectRoot: string): string {
    const candidates = [
      join(projectRoot, 'libs', 'llama.cpp', 'build', 'bin', 'Release', 'llama-server.exe'),
      join(projectRoot, 'libs', 'llama.cpp', 'build', 'bin', 'llama-server'),
      join(projectRoot, 'libs', 'llama.cpp', 'llama-server.exe'),
      join(projectRoot, 'libs', 'llama.cpp', 'llama-server'),
      'llama-server',
      'llama-server.exe',
    ];
    const found = candidates.find((c) => existsSync(c));
    return found ?? 'llama-server';
  }
}