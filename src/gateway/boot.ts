/**
 * boot.ts —— 启动引导接线（行数收尾第十一批）。
 *
 * 迁移 ConfigManager/SessionManager 的创建 + 会话恢复逻辑（factory 头部
 * ~40 行三分支）。createAgent 只留一次调用 + 结果解构 —— 白名单因此只剩
 * AgentLoop（内核本体，方案明确不迁）。
 *
 * 会话恢复三分支（resume/shouldContinue/new）整体搬运，行为零变更：
 * - 渠道隔离恢复（TUI 与飞书共享进程时恢复各自渠道 session）
 * - 新 session 按 startup.defaultMode 决定初始 Router 模式
 */

import { ConfigManager } from '../setup/config.js';
import type { AgentConfig } from '../setup/config.js';
import { SessionManager } from '../memory/session.js';
import { ProviderManager } from '../provider/manager.js';
import type { Provider } from '../provider/interface.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('factory');

export interface BootOptions {
  cwd: string;
  sessionId: string | undefined;
  shouldContinue: boolean | undefined;
  channel: string | undefined;
  /** 外部注入的 SessionManager（测试/嵌入式用） */
  sessionManager?: SessionManager;
}

export interface BootResult {
  configManager: ConfigManager;
  config: AgentConfig;
  /** startup.defaultMode 决定的初始模式 */
  defaultMode: 'normal' | 'companion';
  sessionManager: SessionManager;
  sessionDir: string;
  currentSessionId: string;
  sessionType: 'normal' | 'precise' | 'companion';
}

/**
 * 启动引导：配置加载 + 会话恢复（三分支）。
 * 原 factory 内联逻辑整体搬运，行为零变更。
 */
export async function boot(options: BootOptions): Promise<BootResult> {
  const { cwd, sessionId, shouldContinue, channel } = options;

  // ── 配置预加载（需在 session 创建前读取 startup.defaultMode）──────
  const configManager = new ConfigManager(cwd);
  const config = await configManager.load();
  const startupMode = (config as unknown as Record<string, unknown>).startup as Record<string, unknown> | undefined;
  const defaultMode: 'normal' | 'companion' =
    startupMode?.defaultMode === 'companion' ? 'companion' : 'normal';

  // ── Session ──────────────────────────────────────────────────────
  const sessionManager = options.sessionManager ?? new SessionManager(cwd);
  let sessionDir: string;
  let currentSessionId: string;
  let sessionType: 'normal' | 'precise' | 'companion' = 'normal';

  if (sessionId) {
    const session = await sessionManager.resume(sessionId);
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = session.type ?? 'normal';
    logger.info('Resumed session', { sessionId: session.id, type: sessionType });
  } else if (shouldContinue) {
    // 渠道隔离恢复：TUI 与飞书共享进程时，重启应恢复各自渠道的 session，
    // 而非全局最近（否则会把飞书 session 恢复给 TUI）。跨渠道加载由 switch_session 显式完成。
    const channelSession = channel
      ? await sessionManager.getLatestByChannel(channel)
      : null;
    const session = channelSession ?? (await sessionManager.resume());
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = session.type ?? 'normal';
    logger.info('Continued session', { sessionId: session.id, type: sessionType, channel: channel ?? '(global)' });
  } else {
    // 惰性新建：只生成 session id + 目录路径，不创建目录不写文件。
    // 首条用户消息到达时由 loop.run() 物化（写 meta/事件/stats）。
    // 用户启动后直接 switch_session 切旧会话时不产生空 session 残留。
    // 注意：陪伴模式也生成 normal session，实际 session 切换由 CompanionRouter.onActivate 负责。
    const session = sessionManager.createLazy(channel);
    await sessionManager.cleanup(); // 保留过期 session 清理（原 create() 内建）
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = defaultMode;
    logger.info('New lazy session', { sessionId: session.id, channel, defaultMode: sessionType });
  }

  return { configManager, config, defaultMode, sessionManager, sessionDir, currentSessionId, sessionType };
}

