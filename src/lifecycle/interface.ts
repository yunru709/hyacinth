/** 进程状态 */
export type ProcessState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed'
  | 'crashed';

/** 健康检查配置 */
export interface HealthCheckConfig {
  /** HTTP 健康检查 URL（如 http://localhost:8080/v1/models） */
  url?: string;
  /** TCP 健康检查主机 */
  host?: string;
  /** TCP 健康检查端口 */
  port?: number;
  /** 检查间隔（毫秒），默认 5000 */
  intervalMs?: number;
  /** 每次检查超时（毫秒），默认 3000 */
  timeoutMs?: number;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
}

/** 受管进程配置 */
export interface ManagedProcessConfig {
  /** 唯一名称 */
  name: string;
  /** 可执行文件路径或命令 */
  command: string;
  /** 命令行参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
  /** 健康检查配置 */
  healthCheck?: HealthCheckConfig;
  /** 崩溃后自动重启，默认 false */
  autoRestart?: boolean;
  /** 最大重启次数（达到后不再重启），默认 5 */
  maxRestarts?: number;
  /** 重启延迟（毫秒），默认 2000 */
  restartDelayMs?: number;
  /** 停止信号，默认 SIGTERM */
  stopSignal?: 'SIGTERM' | 'SIGINT' | 'SIGKILL';
  /** 等待进程退出的超时（毫秒），默认 10000 */
  stopTimeoutMs?: number;
  /** 启动后等待首次健康检查通过的超时（毫秒），默认 60000 */
  startupTimeoutMs?: number;
}

/** 进程实时状态 */
export interface ProcessStatus {
  name: string;
  state: ProcessState;
  pid: number | null;
  uptime: number | null;        // 秒
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  startedAt: string | null;     // ISO 时间
}

/** 本地模型后端类型 */
export type LocalModelBackend = 'llama.cpp' | 'ollama' | 'vllm' | 'lm-studio' | 'custom';

/** 本地模型配置（用于 .agent/models.json） */
export interface LocalModelConfig {
  /** 后端类型 */
  backend: LocalModelBackend;
  /** 模型路径（llama.cpp: .gguf 路径; vLLM: 模型名） */
  modelPath?: string;
  /** 服务端口，默认 8080 */
  port?: number;
  /** GPU 层数（llama.cpp -ngl），默认 0=CPU */
  nGpuLayers?: number;
  /** 上下文大小，默认 4096 */
  ctxSize?: number;
  /** 额外 CLI 参数 */
  extraArgs?: string[];
  /** 运行时可覆盖的模型名称（传给 LLM 的名称） */
  modelName?: string;
  /** ollama 专用：模型标签 */
  ollamaModel?: string;

  // ── 进程管理 / 健康检查参数（覆盖默认值）──

  /** 崩溃后重启延迟（毫秒），默认 3000 */
  restartDelayMs?: number;
  /** 健康检查间隔（毫秒），默认 5000 */
  healthIntervalMs?: number;
  /** 单次健康检查超时（毫秒），默认 5000 */
  healthTimeoutMs?: number;
  /** 健康检查最大重试次数，默认 6 */
  healthMaxRetries?: number;
  /** 启动超时（毫秒），默认 120_000 */
  startupTimeoutMs?: number;
}

/** 进程事件回调 */
export interface ProcessEventCallbacks {
  onStateChange?: (name: string, from: ProcessState, to: ProcessState) => void;
  onCrash?: (name: string, exitCode: number | null) => void;
  onHealthFail?: (name: string, error: string) => void;
  onHealthRecover?: (name: string) => void;
}