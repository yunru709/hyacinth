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
      autoModel: false,
      defaultMode: 'balanced',
      temperature: 0.7,
      topP: 0.95,
      frequencyPenalty: 0,
      presencePenalty: 0,
      streaming: true,
      jsonMode: false,
      fallbackModel: 'claude-3-haiku',
      enableThinking: false,
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
      responseTimeoutSec: 60,
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
      zone4BudgetRatio: 0.5,
      intentBlock: false,
      longTermMemory: true,
      continuity: 'strict',
      maxCompressRounds: 3,
      trimWindow: 6,
      poolMinHistory: 200,
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
      collapseTools: true,
      sanitize: true,
      toolUse: true,
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
      assessment: { source: 'main' },
      planning: { source: 'main' },
      compression: { source: 'main' },
    },
    local: {
      baseUrl: localCfg.baseUrl,
      defaultModel: localCfg.defaultModel,
      port: localCfg.port,
      maxOutputTokens: localCfg.maxOutputTokens,
      backend: localCfg.backend,
    },
    logging: { level: 'info', logCacheHits: false, repairLog: true },
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
        { id: 'context', impl: 'builtin:layered-composer', enabled: true, requires: { reads: ['history', 'userInput', 'tools'], writes: ['messages', 'zoneBreakdown'] } },
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
    },
  };
}
