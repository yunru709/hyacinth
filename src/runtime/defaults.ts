import type { FullConfig } from './config-schema.js';
import { getLocalProviderConfigLoader } from '../provider/local-config.js';
import { DEFAULT_PROVIDERS, getProviderConfigLoader } from '../provider/config.js';
import { DEFAULT_USER_ID } from '../provider/user-id.js';

function providerDefault(providerId: string): string {
  try {
    const loader = getProviderConfigLoader();
    const meta = loader.getProvider(providerId);
    if (meta?.defaultModel) return meta.defaultModel;
  } catch {}
  return DEFAULT_PROVIDERS.providers[providerId]?.defaultModel ?? 'unknown';
}

export function getDefaultConfig(): FullConfig {
  const localCfg = getLocalProviderConfigLoader();
  return {
    provider: {
      active: 'anthropic',
      routeMode: 'auto',
      defaultMode: 'balanced',
      temperature: 0.7,
      topP: 0.95,
      frequencyPenalty: 0,
      presencePenalty: 0,
      streaming: true,
      userId: DEFAULT_USER_ID,
      anthropic: { model: providerDefault('anthropic'), apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { model: providerDefault('openai'), apiKeyEnv: 'OPENAI_API_KEY' },
      deepseek: { model: providerDefault('deepseek'), apiKeyEnv: 'DEEPSEEK_API_KEY' },
      gemini: { model: providerDefault('gemini'), apiKeyEnv: 'GEMINI_API_KEY' },
      volcengine: { model: providerDefault('volcengine'), apiKeyEnv: 'ARK_API_KEY' },
      local: {
        model: localCfg.defaultModel,
        baseUrl: localCfg.baseUrl,
        maxOutputTokens: localCfg.maxOutputTokens,
        healthCheck: {
          restartDelayMs: 3000,
          intervalMs: 5000,
          timeoutMs: 5000,
          maxRetries: 6,
          startupTimeoutMs: 120000,
        },
      },
    },
    session: {
      maxTurns: 100,
      maxContext: 200000,
      maxMessages: 10000,
      // 每渠道会话策略（SessionService 注入源）：
      //   - conversation：按对话身份派生（群=chat:<chatId>[:thread]，私聊=user:<userId>）
      //   - single：单会话渠道（微信 ClawBot），恒为 default 键
      //   - explicit：协议自带会话（TUI/WebUI/HTTP），不派生不持久化
      //   - sharedLoop：多对话共享一个 loop（旧飞书 sessionMode='shared'）
      channelPolicies: {
        feishu: { sessionKey: 'conversation' },
        clawbot: { sessionKey: 'single' },
        tui: { sessionKey: 'explicit' },
        webui: { sessionKey: 'explicit' },
      },
    },
    safety: {
      // 空数组 = 按 sideEffect 推导（write/exec 需审批）；显式名单 = 加性覆盖
      dangerousTools: [],
      allowedTools: [],
      allowedCommands: [],
      requireConfirmation: true,
      denyTools: [],
    },
    context: {
      compressThreshold: 0.75,
      emergencyThreshold: 0.92,
      compressDepth: 0.5,
      safetyThreshold: 0.95,
      targetRatio: 0.15,
      clusterBudgetRatio: 0.7,
      zone5TailBudgetRatio: 0.15,
      scratchpadMaxChars: 8000,
      zone4BudgetRatio: 0.5,
      maxCompressRounds: 3,
      trimWindow: 6,
      poolMinHistory: 200,
      // 全量存档召回（pool_context）总开关，默认关闭。
      // 它是检索段：内容按当轮关键词召回、每轮都变 ⇒ 放行会持续产生缓存 miss
      //（实测 1~3 万 token/轮，命中率掉约 10 个百分点）。切换用 TUI `/pool on|off`。
      poolEnabled: false,
    },
    schedule: {
      heartbeatMs: 5000,
      maxConcurrent: 10,
      taskTimeoutMs: 300000,
      maxRecords: 1000,
      channelFallback: ['feishu'],
    },
    generation: {
      pollIntervalMs: 3000,
      videoPollIntervalMs: 15000,
      maxPollAttempts: 600,
      minimaxDefaultVoiceId: 'moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85',
      minimaxAudioFormat: 'mp3',
    },
    resiliency: {
      retry: { enabled: true, maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 30000 },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 },
      fallbackChain: [],
      fallbackToPrimary: true,
      probe: { timeoutMs: 5000, cacheTtlMs: 60000, failureCooldownMs: 30000, uncertainCooldownMs: 15000 },
    },
    agents: { disabled: [] },
    tools: {
      disabled: [],
      sanitize: true,
      resultBuffer: {
        enabled: true,
        threshold: 16384,        // 16 KB
        includePreview: true,
        previewChars: 500,
      },
      read: { maxLines: 2000 },
      executor: { timeoutMs: 300000 },
      glob: { maxResults: 1000 },
      grep: { maxFileSizeBytes: 1048576, headLimit: 2000 },
      bash: { timeoutSec: 600, maxOutputBytes: 512000 },
      http: { timeoutMs: 30000, maxResponseBytes: 51200 },
      db: { maxRows: 200 },
    },
    skills: { disabled: [] },
    models: {
      /** 模型存储根目录（空 = ~/.agent/models；STT/TTS 共用，换盘用它） */
      root: '',
      /** 下载源偏好：'' = auto（hf-mirror 优先逐源尝试）；'hf-mirror' / 'huggingface' 锁定 */
      mirror: '',
      assessment: { source: 'main' },
      planning: { source: 'main' },
      compression: { source: 'main' },
    },
    stt: {
      /** 语音输入（麦克风按钮）：默认开（孑遗 2026-10-27 要求「默认启动」），用户可在设置/控制台关闭 */
      enabled: true,
    },
    voice: {
      say: {
        /** say 语音播报总开关（say-voice 插件）：默认开（孑遗 2026-10-27 要求「默认启动」） */
        broadcast: true,
        /** 默认音色 id（空 = 引擎默认） */
        voice: '',
      },
      /**
       * TTS 引擎选择：say 工具实际接到哪个实现（2026-10-26）。
       * 三选一，切换后下一回合 say 即生效（工厂按配置指纹重建实例，不重启进程）。
       * 由 TUI `/tts` 或 WebUI 设置页「语音合成」卡选择。
       */
      tts: {
        /** cosyvoice3（默认，本地 python 服务）/ breeze-tts-2（本地 GGUF）/ online（在线 API） */
        engine: 'cosyvoice3',
        /**
         * 本地 GGUF 引擎（audio.cpp 运行时）。
         * 路径留空 = 未安装 ⇒ 该引擎在 UI 里显示「未就绪」（不会影响其它引擎）。
         * 安装方式见 breeze-tts2.ts 文件头（需 audiocpp_cli.exe + GGUF + CUDA 的 cudart 归档）。
         */
        breeze: {
          cliPath: '',
          modelPath: '',
          /** cuda | cpu | vulkan */
          backend: 'cuda',
          device: 0,
          /** 不传 emotion 时的默认 instruct（空 = 用模型 spec 自带默认） */
          defaultInstruct: '',
          /** 参考音目录（<id>.wav 可作 voice-ref 做音色克隆） */
          voicesDir: '',
          /** 临时 WAV 目录（空 = 模型同级 tts-work/。**别指到 %TEMP%**：火绒拦新 exe 写） */
          workDir: '',
          /** 透传 audio.cpp 的 --request-option（如 max_tokens / guidance_scale） */
          requestOptions: {},
          /**
           * 常驻 server 地址（如 http://127.0.0.1:8189）。**空 = 走 CLI**。
           * 实测 CLI 单次 9.7s 中 8s 是进程启动+模型加载，纯合成仅 1.9s；
           * 同一模型常驻后单次 2.0s。要提速就配这项 + 起 audiocpp_server.exe。
           */
          serverUrl: '',
          /** server config 里给该模型起的 id（只在 serverUrl 非空时用） */
          serverModelId: 'breeze-tts-2',
          /**
           * 自动托管 server（默认 true）：适配器自己拉起 audiocpp_server.exe 并走 HTTP。
           * 为什么默认开：CLI 每句重付 8s 加载费（实测 9.7s vs 常驻 2.0s），
           * 这个提速不该要求用户手工起进程。起不来时退回 CLI（只降速，音频不变）。
           */
          serverAutoStart: true,
          /** 自动托管时监听端口（3178 归 cosyvoice，别抢） */
          serverPort: 8189,
          /** 单次合成超时（含模型加载，默认 180s） */
          timeoutMs: 180000,
        },
        /**
         * 在线引擎（breeze | openai-compatible）。
         * apiKey 支持环境变量兜底（BREEZE_API_KEY / TTS_API_KEY），避免明文落盘。
         */
        online: {
          provider: 'breeze',
          baseUrl: 'https://api.breeze.blue',
          apiKey: '',
          model: 'breeze-tts-2',
          voice: '',
          /** 语言码（breeze: zh | en；openai 兼容留空） */
          language: 'zh',
          /** 输出格式（breeze: wav_24000 | mp3_44100_128） */
          format: 'wav_24000',
          timeoutMs: 60000,
        },
      },
    },
    local: {
      baseUrl: localCfg.baseUrl,
      defaultModel: localCfg.defaultModel,
      port: localCfg.port,
      maxOutputTokens: localCfg.maxOutputTokens,
      backend: localCfg.backend,
    },
    logging: { level: 'info', logCacheHits: false },
    repair: {
      scavenge: {
        enabled: true,
      },
      storm: {
        enabled: true,
        windowSize: 6,
        threshold: 3,
        stormExemptTools: [],
      },
      textLoop: {
        enabled: true,
        windowSize: 6,
        threshold: 3,
        similarity: 0.90,
        minLength: 30,
      },
      verification: {
        mode: 'off',
      },
      evidenceGate: {
        mode: 'off',
      },
      truncation: {
        maxContinue: 3,
      },
    },
    multimodal: {
      videoInlineMaxBytes: 10 * 1024 * 1024,
      videoMaxFrames: 16,
      audioInlineMaxBytes: 15 * 1024 * 1024,
    },
    hotReload: {
      enabled: true,
      debounceMs: 500,
      pollIntervalMs: 5000,
      watchMcp: true,
      watchPlugins: true,
      watchPrompts: true,
      watchAgents: true,
      watchConfig: true,
      watchTools: true,
      watchSkills: true,
      watchProviders: true,
      watchModelCatalog: true,
      watchCommands: true,
      watchContextManifest: true,
      watchBundles: true,
      watchExtensionRegistry: true,
      watchToolLinks: true,
    },
    autoGit: {
      postTurnCommit: false, // 回合收尾提交默认关：待真实使用观察后再定默认值（方案红线 4）
      startupAction: 'ignore',
    },
    memory: {
      conversationFile: 'conversation.jsonl',
      eventsFile: 'events.jsonl',
      statsFile: 'stats.json',
      summaryFile: 'summaries/_full.md',
    },
    kb: {
      enabled: false,
      zone4: false,
      maxTotal: 5,
      maxMain: 3,
      maxRefs: 2,
    },
    startup: {
      defaultMode: 'normal',
    },
    // 内核管道装配清单（P1 内核化）：槽位顺序 = 执行顺序。
    // 每个槽位的 impl 指向内核模块注册表中的模块 id；
    // requires 是槽位契约（配置对模块的要求），装配期校验 requires ⊆ 模块声明的 reads/writes。
    // M3-M6 全部点亮：runTurn 六阶段（input/bypass/context/llm/tools/finalize）全链经管道执行。
    kernel: {
      pipeline: [
        { id: 'input', impl: 'builtin:input-normalize', enabled: true, requires: { reads: ['history', 'userInput'], writes: ['userInput'] } },
        { id: 'bypass', impl: 'builtin:bypass-preturn', enabled: true, requires: { reads: ['history', 'userInput'], writes: ['userInput', 'bypassInjections'] } },
        // reads 里不含 'tools'：TurnState 无该字段（C-09，见 create-kernel.ts 同处注释）
        { id: 'context', impl: 'builtin:layered-composer', enabled: true, requires: { reads: ['history', 'userInput'], writes: ['messages', 'zoneBreakdown'] } },
        { id: 'llm', impl: 'builtin:provider-stream', enabled: true, requires: { reads: ['messages'], writes: ['streamText', 'stopReason'] } },
        { id: 'tools', impl: 'builtin:tool-dispatch', enabled: true, requires: { reads: ['toolCalls'], writes: ['toolCalled'] } },
        { id: 'finalize', impl: 'builtin:turn-finalize', enabled: true, requires: { reads: ['stop'], writes: ['stop', 'stopReason'] } },
      ],
    },
    bypass: {
      orchestratorEnabled: false,
    },
    companion: {
      defaultCharacter: '',
      tts: {
        enabled: false,
        voice: '',
        provider: '',
        // 每角色保留最近 300 条生成语音（约 30~70MB）；0 = 不清理
        keepPerCharacter: 300,
      },
    },
    diagnostics: {
      enabled: true,
      timeout: 15000,
    },
    ui: {
      theme: 'hyacinth',
      showThinking: false,
      // 设计语言（布局范式+交互规范，与「主题」正交）。当前只有 classic 真实接入，
      // tui / editorial 待完善后再接。缺这行 ⇒ 全新环境 config.get('ui.designLanguage') 会 not found。
      designLanguage: 'classic',
    },
  };
}
