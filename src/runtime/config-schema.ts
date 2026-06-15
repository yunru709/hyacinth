export interface FullConfig {
  provider: {
    active: string; // 'anthropic' | 'openai' | 'deepseek' | ...
    routeMode: 'auto' | 'manual';
    enableThinking: boolean; // 启用 thinking/reasoning 模式
    /** DeepSeek 缓存隔离 ID，区分同一 key 下不同产品的缓存池。默认 "deepthink"。 */
    userId?: string;
    anthropic: { model: string; apiKeyEnv: string };
    openai: { model: string; apiKeyEnv: string };
    deepseek: { model: string; apiKeyEnv: string };
    gemini: { model: string; apiKeyEnv: string };
    local: {
      model: string;
      baseUrl: string;
      maxTokens: number;
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
    compressionStrategy: 'A' | 'C'; // 'A' — 独立压缩提示词（默认），'C' — 克隆对话缓存友好
  };

  training: {
    enabled: boolean; // false
    scheduleTime: string; // '03:00'
    checkIntervalMs: number; // 600000
    minSamples: number; // 10
    baseModel: string;
    adapter: {
      maxAdapters: number; // 5
      minSamplesPerAdapter: number; // 10
    };
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
}

export interface ConfigSchemaEntry {
  path: string;
  type: string;
  description: string;
  defaultValue: unknown;
  currentValue: unknown;
}
