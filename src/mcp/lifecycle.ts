import { ProcessManager } from '../lifecycle/manager.js';
import { MCPClient } from './client.js';
import { ProcessTransport } from './process-transport.js';
import { createLogger } from '../logging/logger.js';
import type { MCPConfig } from '../types.js';

/**
 * MCPServerManager — MCP Server 生命周期管理器。
 *
 * 职责：
 *   1. 用 ProcessManager 管理 MCP Server 的 OS 进程（启动、监控、自动重启）
 *   2. 用 MCPClient 管理 MCP 协议连接
 *   3. 崩溃时自动重连 + 重新注册工具
 *   4. 统一向 LifecycleSupervisor 报告状态
 */
export class MCPServerManager {
  private processManager: ProcessManager;
  private client: MCPClient;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private reconnectAttempt = 0;
  private maxReconnectBackoff = 30000;
  private logger: ReturnType<typeof createLogger>;

  constructor(private config: MCPConfig) {
    this.logger = createLogger(`mcp:lifecycle:${config.name}`);
    // ProcessManager 负责实际 spawn 和监控 MCP Server 子进程。
    // 挂起检测策略：stdio MCP Server 无 HTTP 端点，无法配置 healthCheck；
    // 依赖 onCrash 回调检测进程崩溃 + 工具调用超时（60s）检测进程挂起。
    this.processManager = new ProcessManager(
      {
        name: `mcp-${config.name}`,
        command: config.command ?? '',
        args: config.args,
        env: config.env,
        autoRestart: false,
        maxRestarts: 5,
        restartDelayMs: 3000,
        stopTimeoutMs: 8000,
      },
      {
        onCrash: () => this.handleCrash(),
      },
    );
    this.client = new MCPClient(config);
  }

  /** 连接到 MCP Server */
  async connect(): Promise<boolean> {
    try {
      if (this.config.url && !this.config.command) {
        // SSE 远程传输：直接让 MCPClient 使用内部 SSE 传输逻辑
        await this.client.connect();
      } else {
        // stdio 传输：先启动子进程，再用 ProcessTransport 连接
        await this.processManager.start();
        const proc = this.processManager.getProcess();
        if (!proc) {
          this._connected = false;
          return false;
        }
        const transport = new ProcessTransport(proc);
        await this.client.connect(transport);
      }
      // 二次验证：确保 client 真正连接成功（防止 client.connect() 内部静默失败）
      if (!this.client.isConnected()) {
        this._connected = false;
        this.logger.warn(`connect failed for ${this.config.name}: client reported not connected after connect()`);
        return false;
      }
      this._connected = true;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`connect failed for ${this.config.name}: ${msg}`);
      this._connected = false;
      return false;
    }
  }

  /** 获取 MCPClient 实例 */
  getClient(): MCPClient {
    return this.client;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this._connected;
  }

  /** 获取服务名称 */
  getName(): string {
    return this.config.name;
  }

  /** 获取 ProcessManager（供 LifecycleSupervisor 注册） */
  getProcessManager(): ProcessManager {
    return this.processManager;
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    this.stopReconnectTimer();
    await this.client.disconnect();
    if (this.config.command) {
      await this.processManager.stop();
    }
    this._connected = false;
  }

  /** 重新连接 */
  async reconnect(): Promise<void> {
    await this.disconnect();
    if (this.config.url && !this.config.command) {
      // SSE 远程传输：直接重连，无需管理子进程
      try {
        await this.client.connect();
        if (!this.client.isConnected()) {
          this._connected = false;
          return;
        }
        this._connected = true;
        this.reconnectAttempt = 0;
        // 工具注册由 MCPSystem 统一管理，crash 恢复后 MCPSystem 会通过 syncBridge 重建
      } catch {
        this._connected = false;
      }
    } else {
      // stdio 传输：重启子进程再连接
      if (this.processManager.getState() !== 'running') {
        await this.processManager.start();
      }
      const proc = this.processManager.getProcess();
      if (!proc) {
        this._connected = false;
        return;
      }
      const transport = new ProcessTransport(proc);
      try {
        await this.client.connect(transport);
        if (!this.client.isConnected()) {
          this._connected = false;
          return;
        }
        this._connected = true;
        this.reconnectAttempt = 0;
        // 工具注册由 MCPSystem 统一管理
      } catch {
        this._connected = false;
      }
    }
  }

  /** 处理崩溃 — 自动重连 + 重新注册工具 */
  private async handleCrash(): Promise<void> {
    this._connected = false;

    // 根据传输类型计算重连延迟
    let delay: number;
    if (this.config.url) {
      // SSE 传输：指数退避
      delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt), this.maxReconnectBackoff);
      this.reconnectAttempt++;
    } else {
      // stdio 传输：固定延迟
      delay = 2000;
    }

    // 延时后尝试重连
    this.reconnectTimer = setTimeout(() => {
      if (this._connected) return;
      void this.reconnect();
    }, delay);
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
