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
      enableThinking: false,
      userId: DEFAULT_USER_ID,
      anthropic: { model: providerDefault('anthropic'), apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { model: providerDefault('openai'), apiKeyEnv: 'OPENAI_API_KEY' },
      deepseek: { model: providerDefault('deepseek'), apiKeyEnv: 'DEEPSEEK_API_KEY' },
      gemini: { model: providerDefault('gemini'), apiKeyEnv: 'GEMINI_API_KEY' },
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
    },
    safety: {
      dangerousTools: ['write', 'bash'],
      allowedTools: [],
      allowedCommands: [],
      requireConfirmation: true,
    },
    context: {
      compressThreshold: 0.75,
      emergencyThreshold: 0.92,
      compressDepth: 0.5,

    },
    schedule: {
      heartbeatMs: 5000,
      maxConcurrent: 10,
      taskTimeoutMs: 300000,
      maxRecords: 1000,
    },
    resiliency: {
      retry: { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 30000 },
      circuitBreaker: { failureThreshold: 5, cooldownMs: 30000 },
      fallbackChain: [],
    },
    agents: { disabled: [] },
    tools: {
      disabled: [],
      resultBuffer: {
        enabled: true,
        threshold: 16384,        // 16 KB
        includePreview: true,
        previewChars: 500,
      },
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
      maxTokens: localCfg.maxTokens,
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
    },
    hotReload: {
      enabled: true,
      debounceMs: 500,
      watchMcp: true,
      watchPlugins: true,
      watchPrompts: true,
      watchAgents: true,
      watchConfig: true,
      watchTools: true,
      watchSkills: true,
      watchProviders: true,
      watchModelCatalog: true,
    },
    memory: {
      conversationFile: 'conversation.jsonl',
      eventsFile: 'events.jsonl',
      statsFile: 'stats.json',
      summaryFile: 'summary.md',
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
    bypass: {
      orchestratorEnabled: true,
    },
    diagnostics: {
      enabled: true,
      timeout: 15000,
    },
  };
}
