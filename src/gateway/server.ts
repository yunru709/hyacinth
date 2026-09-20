import { ConfigManager } from '../setup/config.js';
import { ProviderManager } from '../provider/manager.js';
import { getProviderConfigLoader } from '../provider/config.js';
import { SessionManager } from '../memory/session.js';
import { SessionService } from '../session-service.js';
import { ChannelManager } from '../channels/manager.js';
import { HttpWebhookChannel } from '../channels/builtin/http-webhook.js';
import { registerConfigChannels, getChannelPlugins } from '../channels/auto-detect.js';
import { createAgent } from './factory.js';
import os from 'node:os';
import { createLogger } from '../logging/logger.js';
import { getDefaultConfig } from '../runtime/defaults.js';
import type { ProviderType } from '../types.js';
import { getModelContextWindow } from '../setup/model-defaults.js';
import type { OutputHandler } from '../orchestrator/loop.js';
import type { ChannelsInfo } from '../env/env-collector.js';
import type { AgentFactory } from '../channels/interface.js';
import { watchFile } from 'node:fs';
import path from 'node:path';
import { RESTART_SESSION_MARKER, removeMarker } from '../supervisor/protocol.js';

const logger = createLogger('server');

export interface ServerOptions {
  port: number;
  cwd: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  maxContext?: number;
  apiKey?: string;
  /** 监听地址（缺省 127.0.0.1；对外开放见 http-webhook 的 fail-closed 守卫） */
  host?: string;
  /** 早期测试：不校验钥匙（用户 2026-09-20 要求；对外开放时会大声警告） */
  noAuth?: boolean;
  corsOrigin?: string;
  /** WebUI 静态资源目录（serve --webui 时启用；http-webhook 用 @fastify/static 托管） */
  webuiRoot?: string;
}

export interface ServerInstance {
  manager: ChannelManager;
  port: number;
}

export async function startServer(options: ServerOptions): Promise<ServerInstance> {
  const { port, cwd, provider: providerType, model: modelOverride, maxTurns = getDefaultConfig().session.maxTurns } = options;

  // ── 清理重启残留标记 ──
  // .restart-session 只被 TUI 入口（cli.ts）消费；serve 模式不消费它。
  // 若 serve 进程内触发过 restart（如飞书渠道），文件会残留，下次单独启动 TUI 时
  // 可能把 serve 期间记录的 session（如 http 会话）误当成 TUI 会话恢复。
  // 故 serve 启动即删除，防止跨启动模式的数据残留。
  try {
    if (removeMarker(RESTART_SESSION_MARKER)) {
      logger.info('cleaned stale .restart-session (serve mode does not consume it)');
    }
  } catch { /* 清理失败不影响启动 */ }

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

  // HTTP API 渠道
  manager.register(new HttpWebhookChannel(), {
    port,
    cwd,
    provider,
    sessionManager,
    maxTurns,
    maxContext,
    apiKey: options.apiKey,
    host: options.host,
    noAuth: options.noAuth,
    corsOrigin: options.corsOrigin,
    webuiRoot: options.webuiRoot,
  });

  // ── 配置热监听（fs.watchFile） ────────────────────────────────────

  const configPath = path.join(os.homedir(), '.agent', 'config.json');

  function watchChannelConfigs(): void {
    watchFile(configPath, { interval: 1000 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;

      try {
        const agentConfig = await configManager.load();
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

  // ── 调用所有插件的 onGatewayInit 钩子（如飞书 SDK 日志拦截）──
  // 与 tui.ts 对齐：serve 模式下插件全局初始化同样需要生效
  for (const plugin of getChannelPlugins()) {
    try {
      plugin.onGatewayInit?.();
    } catch (err) {
      logger.warn('channel plugin onGatewayInit failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

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
        sessionManager,
        lazySession: options.lazySession,
      });
    },
  };

  // ── 内核会话服务（会话主控权单点：渠道身份解析 / loop 注册表 / 恢复） ──
  // 策略来源外部配置（session.channelPolicies，defaults.ts 注入）
  const sessionService = new SessionService({
    sessionManager,
    agentFactory,
    policies: getDefaultConfig().session.channelPolicies,
  });

  // 旧飞书会话映射迁移（幂等：仅 session-identity.json 不存在时导入 feishu_chat.json 的 sessions）
  await sessionService.migrateFeishuLegacy();

  await manager.startAll(agentFactory, sessionService);

  console.log(`HTTP API: http://localhost:${port}`);
  // 对外开放时，localhost 这个地址对其它设备没用 ✗ ⇒ 一并列出可达网址 ✓
  try {
    const { listLanUrls } = await import('../channels/builtin/http-webhook.js');
    if ((options.host ?? '127.0.0.1').startsWith('127.') === false && (options.host ?? '127.0.0.1') !== 'localhost') {
      for (const u of listLanUrls(port)) console.log(`         可从局域网访问: ${u}`);
    }
  } catch { /* 提示失败不影响启动 */ }

  return { manager, port };
}
