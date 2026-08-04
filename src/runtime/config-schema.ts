export interface FullConfig {
  provider: {
    active: string; // 'anthropic' | 'openai' | 'deepseek' | ...
    routeMode: 'auto' | 'manual';
    enableThinking: boolean; // 启用 thinking/reasoning 模式（启动时自动从 providers.json 读取模型 reasoningEffort）
    /** DeepSeek 缓存隔离 ID，区分同一 key 下不同产品的缓存池。默认 "hyacinth"。 */
    userId?: string;
    anthropic: { model: string; apiKeyEnv: string };
    openai: { model: string; apiKeyEnv: string };
    deepseek: { model: string; apiKeyEnv: string };
    gemini: { model: string; apiKeyEnv: string };
    local: {
      model: string;
      baseUrl: string;
      /** 单次请求最大输出 token 数（推荐）。兼容旧键名 maxTokens。 */
      maxOutputTokens?: number;
      /** @deprecated 使用 maxOutputTokens */
      maxTokens?: number;
      modelKey?: string;
      healthCheck: {
        restartDelayMs: number; // 3000
        intervalMs: number; // 5000
        timeoutMs: number; // 5000
        maxRetries: number; // 6
        startupTimeoutMs: number; // 120000
      };
    };
  };

  session: {
    maxTurns: number; // 100
    maxContext: number; // 200000
    maxMessages: number; // 10000
  };

  safety: {
    dangerousTools: string[]; // ['write', 'bash']
    allowedTools: string[];   // []
    allowedCommands: string[]; // []
    requireConfirmation: boolean; // true
  };

  context: {
    compressThreshold: number;    // 0.75 — 触发异步压缩的阈值
    emergencyThreshold: number;   // 0.92 — 触发同步紧急压缩的阈值
    compressDepth: number;        // 0.5  — 压缩激进程度 0.0~1.0
  };

  schedule: {
    heartbeatMs: number; // 5000
    maxConcurrent: number; // 10
    taskTimeoutMs: number; // 300000
    maxRecords: number; // 1000
  };

  resiliency: {
    retry: {
      maxRetries: number; // 4
      baseDelayMs: number; // 1000
      maxDelayMs: number; // 30000
    };
    circuitBreaker: {
      failureThreshold: number; // 5
      cooldownMs: number; // 30000
    };
    fallbackChain: string[]; // []
  };

  agents: {
    disabled: string[];
    [agentName: string]: {
      maxTurns?: number;
      allowedTools?: string[];
      collaborationMode?: 'delegate' | 'adversarial' | 'parallel';
    } | string[] | undefined;
  };

  tools: {
    disabled: string[];
    resultBuffer: {
      /** Whether to buffer large tool results to disk instead of injecting them directly. Default true. */
      enabled: boolean;
      /** Size threshold in bytes. Results larger than this are buffered. Default 16384 (16 KB). */
      threshold: number;
      /** Include a preview of the first N characters in the pointer message. Default true. */
      includePreview: boolean;
      /** Number of characters to include in preview. Default 500. */
      previewChars: number;
    };
  };

  skills: {
    disabled: string[];
  };

  models: {
    assessment: { source: 'main' | 'local'; model?: string };
    planning: { source: 'main' | 'local'; model?: string };
    compression: { source: 'main' | 'local'; model?: string };
  };

  local: {
    baseUrl: string;
    defaultModel: string;
    /** 本地服务端口（默认 ollama=11434, llamacpp=8080） */
    port: number;
    /** 单次请求最大输出 token 数（推荐）。兼容旧键名 maxTokens。 */
    maxOutputTokens?: number;
    /** @deprecated 使用 maxOutputTokens */
    maxTokens?: number;
    /** 后端类型：ollama | llamacpp。未配置时从 baseUrl 端口自动推断 */
    backend?: 'ollama' | 'llamacpp';
  };

  logging: {
    level: 'debug' | 'info' | 'warn' | 'error' | 'off';
    /** 是否在 stats.json 中记录每轮上下文缓存的命中详情。默认 false（调试用途）。 */
    logCacheHits: boolean;
  };

  repair: {
    scavenge: {
      enabled: boolean;
    };
    storm: {
      enabled: boolean;
      windowSize: number;
      threshold: number;
      stormExemptTools: string[];
    };
    textLoop: {
      enabled: boolean;
      windowSize: number;
      threshold: number;
      similarity: number;
      minLength: number;
    };
  };

  hotReload: {
    enabled: boolean;
    debounceMs: number;
    watchMcp: boolean;
    watchPlugins: boolean;
    watchPrompts: boolean;
    watchAgents: boolean;
    watchConfig: boolean;
    watchTools: boolean;
    watchSkills: boolean;
    watchProviders: boolean;
    watchModelCatalog: boolean;
  };

  memory?: {
    conversationFile?: string;
    eventsFile?: string;
    statsFile?: string;
    summaryFile?: string;
    sessionDir?: string;
  };

  kb?: {
    enabled: boolean;
    zone4: boolean;
    /** 检索最大返回条数（默认 5） */
    maxTotal?: number;
    /** 主要结果最大条数，展示完整内容（默认 3） */
    maxMain?: number;
    /** 补充引用最大条数，仅展示摘要（默认 2） */
    maxRefs?: number;
  };

  /** 启动行为 */
  startup?: {
    /** 启动时默认进入的模式。'normal' = 普通模式（默认），'companion' = 陪伴模式 */
    defaultMode: 'normal' | 'companion';
  };

  bypass?: {
    /** 普通模式下是否启用上下文编排旁路Agent（默认 true） */
    orchestratorEnabled: boolean;
  };

  diagnostics?: {
    /** 代码修改后是否自动运行类型检查/编译检查。默认 true */
    enabled: boolean;
    /** 诊断命令超时时间（毫秒）。默认 15000 */
    timeout: number;
  };
}

export interface ConfigSchemaEntry {
  path: string;
  type: string;
  description: string;
  defaultValue: unknown;
  currentValue: unknown;
}
