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
import type { SessionType } from '../types.js';
import { ProviderManager } from '../provider/manager.js';
import type { Provider } from '../provider/interface.js';
import { createLogger } from '../logging/logger.js';
import { resolveChannelSession } from '../session-channel.js';

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
  sessionType: SessionType;
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

  // ── 渠道前缀登记（注册式：核心不预置任何渠道前缀）────────────────
  // 必须在会话恢复/物化**之前**，因为有两条下游依赖：
  //   ① `getLatestByChannel()` 的前缀兜底（见 memory/session.ts）
  //   ② loop 物化 meta.json 时靠 `resolveChannelFromSessionId()` 反解渠道
  // 不登记 ⇒ 会话 ID 虽有 `<channel>_` 前缀却反解不出渠道 ⇒ meta.json 缺 channel
  // 字段 ⇒ 该会话对「按渠道恢复」永远不可见 ⇒ 每次重启都走 fail-closed 开新会话。
  // 实测事故（2026-09-17）：UI 入口（ui-protocol-session / http-webhook）传
  // channel:'webui' 却从不登记前缀 —— cli.ts 只在 CLI 启动路径补过这一句、UI 路径漏了，
  // 于是 webui_*/ui_* 会话的 meta 全无 channel；TUI 重启后恢复不到自己的会话，
  // 而重启续工指令（来自微信那条线）落进了新建的会话 —— 表现为「跨渠道串台」。
  if (channel) {
    const { registerChannelPrefixes } = await import('../session-channel.js');
    registerChannelPrefixes(`${channel}_`, channel);
  }

  // ── Session ──────────────────────────────────────────────────────
  const sessionManager = options.sessionManager ?? new SessionManager(cwd);
  let sessionDir: string;
  let currentSessionId: string;
  let sessionType: SessionType = 'normal';

  if (sessionId) {
    const session = await sessionManager.resume(sessionId);
    sessionDir = sessionManager.getSessionDir(session.id);
    currentSessionId = session.id;
    sessionType = session.type ?? 'normal';
    logger.info('Resumed session', { sessionId: session.id, type: sessionType });
  } else if (shouldContinue) {
    // 渠道隔离恢复：TUI 与飞书共享进程时，重启应恢复各自渠道的 session，
    // 而非全局最近（否则会把飞书 session 恢复给 TUI）。跨渠道加载由 switch_session 显式完成。
    //
    // 恢复策略**唯一实现**在 session-channel.resolveChannelSession（快照 → 最近 → 新建），
    // 与 SessionService 共用，避免两侧各写一份而产生行为分歧。
    const resolved = channel ? await resolveChannelSession(sessionManager, channel) : null;
    if (resolved) {
      sessionDir = sessionManager.getSessionDir(resolved.id);
      currentSessionId = resolved.id;
      sessionType = (resolved.type as SessionType | undefined) ?? 'normal';
      if (resolved.source === 'new') {
        // ── fail-closed：渠道已声明，但本渠道没有存量会话 ──
        // **绝不**回退到「全局最近」（旧写法 `channelSession ?? resume()`）。那条兜底
        // 会把任何**无渠道归属**的会话 —— 测试泄漏目录、temp 项目会话、别渠道的会话 ——
        // 认领给本渠道。实测事故：TUI / WebUI / 微信三方共用同一份对话历史。
        // 宁可开新会话（最多丢一次续接），也不让两个渠道串上下文。
        logger.warn('no session found for channel — starting a new one (fail-closed, no global fallback)', { channel });
        await sessionManager.cleanup();
      } else {
        logger.info('Continued session', { sessionId: currentSessionId, type: sessionType, channel, source: resolved.source });
      }
    } else {
      // 未声明渠道（纯 CLI 交互模式）→ 才允许恢复全局最近
      const session = await sessionManager.resume();
      sessionDir = sessionManager.getSessionDir(session.id);
      currentSessionId = session.id;
      sessionType = session.type ?? 'normal';
      logger.info('Continued session', { sessionId: session.id, type: sessionType, channel: '(global)' });
    }
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

