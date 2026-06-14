import { type ProcessStatus, type ProcessEventCallbacks } from './interface.js';
import { ProcessManager } from './manager.js';
import { LocalModelManager, type LoadedModelInfo } from './local-model.js';
import type { BackgroundProcessRegistry } from '../tools/background-registry.js';

export type ManagedEntityType = 'local-model' | 'mcp-server' | 'custom';

interface ManagedEntity {
  type: ManagedEntityType;
  manager: ProcessManager;
  name: string;
}

/**
 * LifecycleSupervisor — 统一管理所有受管进程的生命周期。
 *
 * 职责：
 *   1. 作为中心注册表，管理 LocalModel 和 MCP Server 的 ProcessManager
 *   2. 提供统一的启动/停止/状态查询接口
 *   3. 协调应用退出时的优雅关闭（按依赖顺序停止）
 *   4. 暴露全局事件回调
 */
export class LifecycleSupervisor {
  private entities: ManagedEntity[] = [];
  private localModelManager = new LocalModelManager();
  private _shuttingDown = false;
  private backgroundRegistry?: BackgroundProcessRegistry;

  /** 是否正在关闭中 */
  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  /** 获取所有实体的状态 */
  getAllStatus(): (ProcessStatus & { type: ManagedEntityType })[] {
    return this.entities.map((e) => ({
      ...e.manager.getStatus(),
      type: e.type,
    }));
  }

  /** 获取特定实体的状态 */
  getStatus(name: string): (ProcessStatus & { type: ManagedEntityType }) | null {
    const entity = this.entities.find((e) => e.name === name);
    if (!entity) return null;
    return { ...entity.manager.getStatus(), type: entity.type };
  }

  /** 获取指定类型的所有实体 */
  getByType(type: ManagedEntityType): ManagedEntity[] {
    return this.entities.filter((e) => e.type === type);
  }

  // ===== Local Model 管理 =====

  /**
   * 从项目目录加载并启动本地模型
   * @returns 加载到的模型信息列表
   */
  async loadAndStartModels(projectDir: string): Promise<LoadedModelInfo[]> {
    const callbacks = this.createCallbacks('local-model');
    const models = await this.localModelManager.loadAndStart(projectDir, callbacks);

    // 将每个模型的 ProcessManager 注册到监督器，确保优雅关闭时能停止模型进程
    for (const m of models) {
      const pm = this.localModelManager.getProcessManager(m.name);
      if (pm) {
        this.entities.push({
          type: 'local-model',
          manager: pm,
          name: `model-${m.name}`,
        });
      }
    }

    return models;
  }

  /** 启动指定模型 */
  async startModel(name: string): Promise<void> {
    await this.localModelManager.startModel(name);
  }

  /**
   * 运行时按需启动模型。
   * 用于 CLI 中用户切换 provider 到 local 时。
   */
  async startModelOnDemand(projectDir: string, modelKey: string): Promise<LoadedModelInfo | null> {
    const callbacks = this.createCallbacks('local-model');
    const info = await this.localModelManager.startModelOnDemand(projectDir, modelKey, callbacks);

    if (info) {
      const pm = this.localModelManager.getProcessManager(info.name);
      if (pm) {
        const existing = this.entities.find((e) => e.name === `model-${info.name}`);
        if (!existing) {
          this.entities.push({
            type: 'local-model',
            manager: pm,
            name: `model-${info.name}`,
          });
        }
      }
    }

    return info;
  }

  /** 停止指定模型（同时检查 localModelManager 和 entities） */
  async stopModel(name: string): Promise<void> {
    await this.localModelManager.stopModel(name);
    // 同时停止 supervisor 自己注册的 entity（如 Ollama）
    const entityName = `model-${name}`;
    const entity = this.entities.find((e) => e.name === entityName);
    if (entity) {
      await entity.manager.stop().catch(() => {});
      this.entities = this.entities.filter((e) => e.name !== entityName);
    }
  }

  /**
   * 自动检测并启动 Ollama（无需预先配置模型注册表）。
   * 用于 switchProvider("local") 时自动拉起。
   */
  async startOllamaOnDemand(projectDir: string): Promise<LoadedModelInfo | null> {
    const { detectBackendBinary, detectLocalBackend } = await import('../provider/local-config.js');
    const ollamaBin = detectBackendBinary('ollama');
    if (!ollamaBin) return null;

    // 再次确认：可能第一次检测是假阴性（网络波动），实际已运行
    const recheck = await detectLocalBackend();
    if (recheck?.backend === 'ollama') {
      // 已在运行，注册为受管 entity 以便 shutdown 时能尝试停止
      const pm = new ProcessManager(
        { name: 'model-ollama', command: ollamaBin, args: ['serve'], autoRestart: false, healthCheck: { url: 'http://127.0.0.1:11434/api/tags', intervalMs: 5000, timeoutMs: 3000, maxRetries: 3 } },
        this.createCallbacks('local-model'),
      );
      this.entities.push({ type: 'local-model', manager: pm, name: 'model-ollama' });
      return { name: 'ollama', backend: 'ollama', modelName: 'ollama', port: 11434, baseUrl: 'http://127.0.0.1:11434/v1' };
    }

    // 未运行 → 拉起
    const pm = new ProcessManager(
      {
        name: 'model-ollama',
        command: ollamaBin,
        args: ['serve'],
        autoRestart: true,
        maxRestarts: 3,
        healthCheck: { url: 'http://127.0.0.1:11434/api/tags', intervalMs: 5000, timeoutMs: 3000, maxRetries: 6 },
        startupTimeoutMs: 120000,
      },
      this.createCallbacks('local-model'),
    );

    await pm.start();
    // 等待健康检查通过（最多 20 秒）
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (pm.getState() === 'running') break;
      // 即使进程状态不对，也检查端点是否可达（端口冲突时 ollama 可能外部已运行）
      const alive = await detectLocalBackend();
      if (alive?.backend === 'ollama') break;
    }

    const isRunning = pm.getState() === 'running';
    const isEndpointAlive = (await detectLocalBackend())?.backend === 'ollama';

    if (!isRunning && !isEndpointAlive) {
      await pm.stop().catch(() => {});
      return null;
    }

    this.entities.push({ type: 'local-model', manager: pm, name: 'model-ollama' });

    const info: LoadedModelInfo = {
      name: 'ollama',
      backend: 'ollama',
      modelName: 'ollama',
      port: 11434,
      baseUrl: 'http://127.0.0.1:11434/v1',
    };
    return info;
  }

  /** 获取 LocalModelManager 实例（供 CLI 获取模型信息以配置 Provider） */
  getModelManager(): LocalModelManager {
    return this.localModelManager;
  }

  // ===== MCP Server 管理 =====

  /** 注册一个 MCP Server 的 ProcessManager */
  registerMCPServer(manager: ProcessManager): void {
    this.entities.push({
      type: 'mcp-server',
      manager,
      name: manager.config.name,
    });
  }

  // ===== 通用进程注册 =====

  /** 注册任意受管进程 */
  register(name: string, type: ManagedEntityType, manager: ProcessManager): void {
    this.entities.push({ name, type, manager });
  }

  /** 注册后台进程注册表（用于异步工具如 bash async:true），关闭时自动清理 */
  registerBackgroundRegistry(registry: BackgroundProcessRegistry): void {
    this.backgroundRegistry = registry;
  }

  // ===== 全局优雅关闭 =====

  /**
   * 关闭所有受管进程。
   * 关闭顺序：local-model → mcp-server → custom
   * （模型和 MCP Server 无严格依赖，并行关闭即可）
   */
  async shutdownAll(): Promise<void> {
    if (this._shuttingDown) return;
    this._shuttingDown = true;

    // 先停止后台进程（bash async:true 启动的进程）
    if (this.backgroundRegistry) {
      await this.backgroundRegistry.shutdownAll().catch(() => {});
    }

    const results = this.entities.map((e) =>
      e.manager.stop().catch(() => {
        // 单个关闭失败不影响其他
      }),
    );

    await Promise.all(results);
    this.entities = [];
  }

  // ===== 安装全局信号处理器 =====

  /**
   * 安装 SIGINT / SIGTERM / 进程退出处理器，实现优雅关闭。
   *
   * 三层防护：
   *   1. SIGINT / SIGTERM → 异步优雅关闭
   *   2. beforeExit      → 异步关闭（覆盖正常退出路径）
   *   3. exit            → 同步 forceKill（最后防线，确保子进程不留孤儿）
   *
   * 返回一个函数，调用后可移除这些处理器。
   */
  installSignalHandlers(): () => void {
    const onSigInt = async () => {
      if (this._shuttingDown) {
        process.exit(0);
      }
      process.stderr.write('\nShutting down managed processes...\n');
      await this.shutdownAll();
      process.exit(0);
    };

    const onSigTerm = async () => {
      process.stderr.write('\nReceived SIGTERM, shutting down...\n');
      await this.shutdownAll();
      process.exit(0);
    };

    const onBeforeExit = async () => {
      if (!this._shuttingDown) {
        await this.shutdownAll();
      }
    };

    const onExit = () => {
      this.forceKillAll();
    };

    process.on('SIGINT', onSigInt);
    process.on('SIGTERM', onSigTerm);
    process.on('beforeExit', onBeforeExit);
    process.on('exit', onExit);

    return () => {
      process.removeListener('SIGINT', onSigInt);
      process.removeListener('SIGTERM', onSigTerm);
      process.removeListener('beforeExit', onBeforeExit);
      process.removeListener('exit', onExit);
    };
  }

  /**
   * 同步强制杀死所有受管子进程。
   * 用于 exit handler 中，不依赖异步操作。
   */
  private forceKillAll(): void {
    // 后台进程（bash async:true）
    this.backgroundRegistry?.forceKillAll();
    // 受管实体（local-model, mcp-server）
    for (const entity of this.entities) {
      entity.manager.forceKillAll();
    }
  }

  // ===== 内部方法 =====

  private createCallbacks(type: ManagedEntityType): ProcessEventCallbacks {
    return {
      onCrash: (name, exitCode) => {
        process.stderr.write(
          `[lifecycle] ${name} crashed with exit code ${exitCode}, auto-restarting...\n`,
        );
      },
      onHealthFail: (name, error) => {
        process.stderr.write(`[lifecycle] ${name} health check failed: ${error}\n`);
      },
      onHealthRecover: (name) => {
        process.stderr.write(`[lifecycle] ${name} health recovered\n`);
      },
    };
  }
}