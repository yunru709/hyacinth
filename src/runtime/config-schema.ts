import type { ProviderFields, ProviderSampling } from '../provider/fields.js';

/** 单个厂商的激活配置（provider.<type> 内的可选项） */
export interface ProviderVendorConfig {
  model: string;
  apiKeyEnv: string;
  /** 单次请求最大输出 token 数（激活配置级覆盖模型目录默认） */
  maxOutputTokens?: number;
  /** 通用字段（userId 等；按协议翻译成各厂商 wire 字段，见 provider/fields.ts） */
  fields?: ProviderFields;
  /** 采样参数（temperature/topP/penalties；激活配置级覆盖厂商/模型默认） */
  sampling?: ProviderSampling;
}

export interface FullConfig {
  provider: {
    active: string; // 'anthropic' | 'openai' | 'deepseek' | ...
    routeMode: 'auto' | 'manual';
    /** 自动选择模型（等价于 routeMode='auto'） */
    autoModel: boolean;
    /** 默认生成模式 */
    defaultMode: 'balanced' | 'creative' | 'precise';
    /** 温度 0.0~2.0 */
    temperature: number;
    /** Top-P 0.0~1.0 */
    topP: number;
    /** 频率惩罚 -2.0~2.0 */
    frequencyPenalty: number;
    /** 存在惩罚 -2.0~2.0 */
    presencePenalty: number;
    /** 流式输出 */
    streaming: boolean;
    /** JSON 模式 */
    jsonMode: boolean;
    /** 降级模型 */
    fallbackModel: string;
    enableThinking: boolean; // 启用 thinking/reasoning 模式（启动时自动从 providers.json 读取模型 reasoningEffort）
    /** DeepSeek 缓存隔离 ID，区分同一 key 下不同产品的缓存池。默认 "hyacinth"。 */
    userId?: string;
    /** 通用字段（provider 顶层兜底；provider.<type>.fields 优先） */
    fields?: ProviderFields;
    /** 采样参数（provider 顶层兜底；provider.<type>.sampling 优先） */
    sampling?: ProviderSampling;
    /** 单次请求最大输出 token 数（provider 顶层兜底；provider.<type>.maxOutputTokens 优先） */
    maxOutputTokens?: number;
    anthropic: ProviderVendorConfig;
    openai: ProviderVendorConfig;
    deepseek: ProviderVendorConfig;
    gemini: ProviderVendorConfig;
    /** 可选：火山方舟（defaults 补段后 config.set 才可在其下写 model，否则抛 unknown path） */
    volcengine?: ProviderVendorConfig;
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
    /** 响应超时（秒） */
    responseTimeoutSec: number;
    /** 每渠道会话策略（SessionService 注入源）：sessionKey: conversation|single|explicit；sharedLoop?: boolean */
    channelPolicies: Record<string, { sessionKey: 'conversation' | 'single' | 'explicit'; sharedLoop?: boolean }>;
  };

  safety: {
    dangerousTools: string[]; // 空数组=按 sideEffect 推导（write/exec 需审批）；显式名单=加性覆盖
    allowedTools: string[];   // []
    allowedCommands: string[]; // []
    requireConfirmation: boolean; // true
    /** 绝对禁止执行的工具名（插件层强制，独立于 executeTools 内置权限；permission-chain 插件消费） */
    denyTools: string[];
  };

  context: {
    compressThreshold: number;    // 0.75 — 触发异步压缩的阈值
    emergencyThreshold: number;   // 0.92 — 触发同步紧急压缩的阈值
    compressDepth: number;        // 0.5  — 压缩激进程度 0.0~1.0
    safetyThreshold: number;      // 0.95 — 压缩安全阈值（上下文占比红线）
    targetRatio: number;          // 0.15 — 理想压缩目标比率，达到即停
    clusterBudgetRatio: number;   // 0.7  — 分簇预算占 historyBudget 比例（决策 H）
    zone5TailBudgetRatio: number; // 0.15 — Zone5 尾部保护预算占 maxContextTokens 比例
    /** 临时记事本（Zone 5）注入上限（字符）；超出截断并标注。见 utils/scratchpad.ts */
    scratchpadMaxChars: number;
    zone4BudgetRatio: number;     // 0.5  — Zone4 检索预算占 maxContextTokens 比例
    /** 意图块模式（intent_block conditional section） */
    intentBlock: boolean;
    /** 跨会话长期记忆 */
    longTermMemory: boolean;
    /** 对话连续性：strict | relaxed | user-only */
    continuity: 'strict' | 'relaxed' | 'user-only';
    /** 最大压缩轮数 */
    maxCompressRounds: number;
    /** 工具结果保护窗口（条） */
    trimWindow: number;
    /** 全量存档召回（pool_context）启用阈值：工作历史达到该条数才读存档做关键词召回 */
    poolMinHistory: number;
  };

  schedule: {
    heartbeatMs: number; // 5000
    maxConcurrent: number; // 10
    taskTimeoutMs: number; // 300000
    maxRecords: number; // 1000
    /** 全局默认渠道降级链（任务 channel 离线时按序尝试）。默认 ["feishu"] */
    channelFallback: string[];
  };

  generation: {
    pollIntervalMs: number;       // 3000 — 图片等同步态任务轮询间隔
    videoPollIntervalMs: number;  // 15000 — 视频任务轮询间隔
    maxPollAttempts: number;      // 600 — 最大轮询次数（15s * 600 ≈ 2.5h 上限）
    minimaxDefaultVoiceId: string; // MiniMax T2A 默认音色 UUID
    minimaxAudioFormat: string;    // MiniMax T2A 音频格式（mp3/wav…）
  };

  resiliency: {
    retry: {
      /** 是否启用自动重试 */
      enabled: boolean;
      maxRetries: number; // 4
      baseDelayMs: number; // 1000
      maxDelayMs: number; // 30000
    };
    circuitBreaker: {
      failureThreshold: number; // 5
      cooldownMs: number; // 30000
    };
    fallbackChain: string[]; // []
    /**
     * 全部降级不可用时回到主 provider 再试一轮（默认 true）。
     * 保护长任务：宁可等待重试也不中断。
     */
    fallbackToPrimary?: boolean; // true
    /** 降级候选探测（入链前验证 API 真实可用） */
    probe: {
      /** 单次探测请求超时（ms） */
      timeoutMs: number; // 5000
      /** ok 结果缓存有效期（ms） */
      cacheTtlMs: number; // 60000
      /** unavailable 结果冷却期（ms），期间不重探 */
      failureCooldownMs: number; // 30000
      /** uncertain 结果冷却期（ms），期间不重探 */
      uncertainCooldownMs: number; // 15000
    };
  };

  agents: {
    disabled: string[];
    [agentName: string]: {
      maxTurns?: number;
      allowedTools?: string[];
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
    /** 默认折叠工具调用与结果卡片 */
    collapseTools: boolean;
    /** 自动去除 markdown fence 与多余换行 */
    sanitize: boolean;
    /** 是否启用工具调用 */
    toolUse: boolean;

    /** 内置工具参数默认值（调用参数可覆盖；详见 tools/tool-config.ts） */
    read: {
      /** 单次最大读取行数。默认 2000 */
      maxLines: number;
    };
    executor: {
      /** 工具执行默认超时毫秒。默认 300000 */
      timeoutMs: number;
    };
    glob: {
      /** 最大返回条数。默认 1000 */
      maxResults: number;
    };
    grep: {
      /** 单文件扫描大小上限字节。默认 1048576 (1MB) */
      maxFileSizeBytes: number;
      /** 默认输出行数上限。默认 2000 */
      headLimit: number;
    };
    bash: {
      /** 默认超时秒。默认 600 */
      timeoutSec: number;
      /** 输出截断字节。默认 512000 (500KB) */
      maxOutputBytes: number;
      /** 危险命令黑名单（子串匹配）。设置后整体替换内置默认黑名单 */
      blockedCommands?: string[];
    };
    http: {
      /** 默认超时毫秒（硬上限 120000）。默认 30000 */
      timeoutMs: number;
      /** 响应体截断字节。默认 51200 (50KB) */
      maxResponseBytes: number;
    };
    db: {
      /** 最大返回行数。默认 200 */
      maxRows: number;
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
    /** 在控制台输出重试与修复事件 */
    repairLog: boolean;
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
    /** plan_execute 预测落空后的循环级验证门：off=不干预；soft=注入失败消息；hard=注入并强制继续 */
    verification: {
      mode: 'off' | 'soft' | 'hard';
    };
    /** 验证证据门：修改了文件但本轮无验证证据（测试/编译/lint）时禁止直接结束 */
    evidenceGate: {
      mode: 'off' | 'soft' | 'hard';
    };
  };

  /** 多模态输入（视频/音频）管线阈值 */
  multimodal: {
    /** 原生视频内联上限（字节，默认 10MB） */
    videoInlineMaxBytes: number;
    /** 视频抽帧上限（帧数，硬约束防 token 激增，默认 16） */
    videoMaxFrames: number;
    /** 音频内联上限（字节，默认 15MB） */
    audioInlineMaxBytes: number;
  };

  hotReload: {
    enabled: boolean;
    debounceMs: number;
    pollIntervalMs: number; // 5000 — poll 模式 watcher 轮询间隔
    watchMcp: boolean;
    watchPlugins: boolean;
    watchPrompts: boolean;
    watchAgents: boolean;
    watchConfig: boolean;
    watchTools: boolean;
    watchSkills: boolean;
    watchProviders: boolean;
    watchModelCatalog: boolean;
    watchCommands: boolean;
    watchContextManifest: boolean;
    watchBundles: boolean;
    watchExtensionRegistry: boolean;
    /** 联动清单（第三圈）热更开关——**必须在此声明**：manager 判据是
     *  "flag 存在且 get() 为 falsy ⇒ 跳过注册"，未声明则 get() 为 undefined ⇒ 永不注册 */
    watchToolLinks: boolean;
  };

  /** git 自管理策略（Supervisor 方案 S4；evolution/auto-git.ts 消费） */
  autoGit: {
    /** 回合收尾提交：onTurnEnd 时工作区脏则 commit `auto: post-turn-N`（默认关） */
    postTurnCommit: boolean;
    /** 启动处置：boot 时对遗留脏工作区的收编策略 */
    startupAction: 'ignore' | 'commit' | 'stash';
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

  /**
   * 内核管道（P1 内核化新增）。
   *
   * 模块化的核心主张：**管道由槽位（slot）串成，槽位与模块的绑定关系在这里维护**。
   * - 换掉整个「上下文组装器」= 把 `context` 槽位的 `impl` 改成另一个模块 id；
   * - 调序 / 禁用 / 插拔都只改配置，不动内核代码。
   *
   * 槽位契约（`requires`）是配置对模块的**要求**；模块自己声明 `reads/writes` 作为真相源，
   * 装配时校验 `requires ⊆ 模块声明`，不通过则启动即报错（防静默错配）。
   */
  kernel?: {
    /** 管道装配清单：数组顺序 = 执行顺序 */
    pipeline?: Array<{
      /** 槽位 id（管道内的固定位置名，如 'context'）。同名只能出现一次 */
      id: string;
      /** 填充该槽位的模块 id（如 'builtin:layered-composer'）。改这一行即整体替换模块 */
      impl: string;
      /** 关闭后该槽位被跳过，state 原样穿过。默认 true */
      enabled?: boolean;
      /** 槽位要求的契约：填充该槽位的模块必须声明覆盖这些读写字段 */
      requires?: {
        reads?: string[];
        writes?: string[];
      };
      /** 传给模块的参数，模块通过 ctx.config() 读取 */
      config?: Record<string, unknown>;
    }>;
  };

  bypass?: {
    /** 普通模式下是否启用上下文编排旁路Agent（默认 false） */
    orchestratorEnabled: boolean;
  };

  diagnostics?: {
    /** 代码修改后是否自动运行类型检查/编译检查。默认 true */
    enabled: boolean;
    /** 诊断命令超时时间（毫秒）。默认 15000 */
    timeout: number;
  };

  /**
   * UI 用户偏好（跨项目、跨会话共享，始终持久化到全局配置 ~/.agent/config.json）。
   * P-Config 收敛后所有配置统一走全局，不再区分业务/偏好来源。
   */
  /** 陪伴模式 */
  companion?: {
    /** 默认陪伴角色（对应 ~/.agent/companion/<角色>/ 人格目录）。
     *  空 = 自动（跟随 .last-character）；多角色且未指定时 activate 会报错提示。 */
    defaultCharacter?: string;
    /** 台词语音合成（TTS）。供应商走 generation.json 的 defaults.audio_tts，
     *  云端（minimax / openai-compatible 指向 OpenAI、硅基流动）与本地
     *  （openai-compatible 指向本地 TTS 服务器）均可。 */
    tts?: {
      /** 回合结束后自动把 assistant 台词合成语音并推给 UI 播放。默认 false */
      enabled: boolean;
      /** 音色（透传给 TTS 供应商；空则用供应商默认） */
      voice?: string;
      /** 覆盖供应商（空则用 defaults.audio_tts） */
      provider?: string;
      /**
       * 生成语音库容量治理：每个角色保留最近多少条。
       * 超出的条目与音频文件会在落库后被清理（这些语音是缓存，台词文本仍在，
       * 再说一次会重新合成）。0 = 不清理（库会一直增长）。
       */
      keepPerCharacter?: number;
    };
  };

  ui?: {
    /** WebUI 主题。hyacinth=夜园(默认·深色) / light=昼园 / dark=深夜 /
     *  glass=琉璃 / ink=墨韵 / rainy=雨夜 */
    theme: 'hyacinth' | 'light' | 'dark' | 'glass' | 'ink' | 'rainy' | 'sunset' | 'mono' | 'cyber' | 'paper' | 'terminal' | 'glacier' | 'celadon';
  };
}

export interface ConfigSchemaEntry {
  path: string;
  type: string;
  description: string;
  defaultValue: unknown;
  currentValue: unknown;
}
