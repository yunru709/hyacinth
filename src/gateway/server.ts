import { ConfigManager } from '../setup/config.js';
import { ProviderManager } from '../provider/manager.js';
import { getProviderConfigLoader } from '../provider/config.js';
import { SessionManager } from '../memory/session.js';
import { ChannelManager } from '../channels/manager.js';
import { HttpWebhookChannel } from '../channels/builtin/http-webhook.js';
import { WebUIChannel } from '../channels/builtin/webui-channel.js';
import { TuiWsSession } from '../channels/builtin/tui-ws-session.js';
import { registerConfigChannels } from '../channels/auto-detect.js';
import { createAgent } from './factory.js';
import { createLogger } from '../logging/logger.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import type { ProviderType } from '../types.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { OutputHandler } from '../orchestrator/loop.js';
import type { ChannelsInfo } from '../env/env-collector.js';
import type { AgentFactory } from '../channels/interface.js';
import { watchFile } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const logger = createLogger('server');

export interface ServerOptions {
  port: number;
  cwd: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  maxContext?: number;
  apiKey?: string;
  corsOrigin?: string;
  /** 启用 WebUI 渠道 */
  enableWebui?: boolean;
  /** WebUI 端口 */
  webuiPort?: number;
  /** 仅启动 WebUI（不启动 HTTP API） */
  webuiOnly?: boolean;
}

export interface ServerInstance {
  manager: ChannelManager;
  port: number;
}

export async function startServer(options: ServerOptions): Promise<ServerInstance> {
  const { port, cwd, provider: providerType, model: modelOverride, maxTurns = getDefaultConfig().session.maxTurns } = options;

  // 加载配置
  const configManager = new ConfigManager(cwd);
  await configManager.loadEnvKeys();

  // 初始化 ProviderConfigLoader（必须在使用 ProviderManager 之前）
  getProviderConfigLoader(cwd);

  // 创建 Provider
  const providerManager = await ProviderManager.createFromConfigFile(
    {
      type: providerType as ProviderType | undefined,
      model: modelOverride,
    },
    cwd,
  );
  const provider = providerManager.getProvider();
  const maxContext = options.maxContext ?? getModelContextWindow(provider.getProviderType(), provider.getModel());

  // Session manager
  const sessionManager = new SessionManager(cwd);

  // 创建渠道管理器并注册渠道
  const manager = new ChannelManager();
  const enableWebui = options.enableWebui ?? false;
  const webuiOnly = options.webuiOnly ?? false;
  const webuiPort = options.webuiPort ?? (port + 100);

  // HTTP API 渠道（webui-only 模式下不启动）
  if (!webuiOnly) {
    manager.register(new HttpWebhookChannel(), {
      port,
      cwd,
      provider,
      sessionManager,
      maxTurns,
      maxContext,
      apiKey: options.apiKey,
      corsOrigin: options.corsOrigin,
    });
  }

  // WebUI 渠道
  if (enableWebui || webuiOnly) {
    manager.register(new WebUIChannel(), {
      port: webuiPort,
      cwd,
      provider,
      sessionManager,
      maxTurns,
      maxContext,
    });
  }

  // ── 配置热监听（fs.watchFile） ────────────────────────────────────

  const configPath = path.join(cwd, '.agent', 'config.json');

  /**
   * 监听 .agent/config.json 文件变更。
   * 遍历所有活跃渠道，调用 updateConfig 实现热更新。
   */
  function watchChannelConfigs(): void {
    watchFile(configPath, { interval: 1000 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;

      try {
        const agentConfig = await configManager.load();
        // 遍历所有活跃渠道，调用 updateConfig
        for (const state of manager.getAll()) {
          if (state.status === 'active' && state.handler.updateConfig) {
            const channelConfig = (agentConfig.channels as Record<string, unknown>)?.[state.handler.id];
            if (channelConfig && typeof channelConfig === 'object') {
              await state.handler.updateConfig(channelConfig as Record<string, unknown>);
            }
          }
        }
      } catch (err) {
        logger.error('config reload error', err instanceof Error ? err : new Error(String(err)));
      }
    }).unref();
  }

  // ── 首次检测：根据 config.json 注册配置驱动渠道（飞书等） ──────────

  await registerConfigChannels(manager, cwd);

  // ── 启动配置热监听 ──────────────────────────────────────────────

  try {
    watchChannelConfigs();
  } catch {
    logger.warn('config watcher failed, hot-reload disabled');
  }

  // ── 启动所有渠道 ────────────────────────────────────────────────

  const agentFactory: AgentFactory = {
    createAgent: async (options) => {
      return createAgent({
        cwd,
        provider,
        maxTurns,
        maxContext,
        outputHandler: options.outputHandler as OutputHandler,
        sessionId: options.sessionId,
        channelsInfo: options.channelsInfo as ChannelsInfo[] | undefined,
        channel: options.channel,
      });
    },
  };

  await manager.startAll(agentFactory);

  if (!webuiOnly) {
    console.log(`HTTP API: http://localhost:${port}`);
  }
  if (enableWebui || webuiOnly) {
    console.log(`WebUI:    http://localhost:${webuiPort}`);
  }

  return { manager, port };
}
