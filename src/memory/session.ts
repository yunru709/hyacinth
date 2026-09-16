import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Session, SessionType } from '../types.js';
import { createLogger } from '../logging/logger.js';
import { toProjectKey } from '../utils/misc.js';
import { withSessionDirLock } from './session-lock.js';
import { resolveChannelFromSessionId } from '../session-channel.js';

const logger = createLogger('session');

const MAX_SESSION_AGE_DAYS = parseInt(process.env.AGENT_MAX_SESSION_AGE ?? '30', 10);

/**
 * 生成 Session ID：{channel}_YYYYMMDD-HHMMSS-XXXX
 */
export function generateSessionId(channel?: string): string {
  const now = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = crypto.randomBytes(2).toString('hex');
  const baseId = `${datePart}-${timePart}-${randomPart}`;

  if (channel && channel.length > 0) return `${channel}_${baseId}`;
  return baseId;
}

/**
 * 幂等物化惰性会话：meta.json 已存在 → 直接返回（不重复写）。
 * 否则补写 meta.json + session_start 事件 + stats.json。
 * conversation.jsonl 由 ConversationStore 首写时自动创建（惰性）。
 */
export async function materializeLazySession(sessionDir: string, session: Session): Promise<void> {
  // 跨进程互斥（TUI 与 WebUI 共享 sessions 目录）：锁内二次检查防双进程同时物化
  await withSessionDirLock(sessionDir, async () => {
    const metaPath = path.join(sessionDir, 'meta.json');
    try {
      await fs.access(metaPath);
      return; // 已物化
    } catch {
      // 未物化，继续补齐
    }

    await ensureDir(sessionDir);
    const now = session.createdAt ?? new Date().toISOString();
    await fs.writeFile(
      metaPath,
      JSON.stringify({
        type: session.type ?? 'normal',
        createdAt: now,
        projectKey: session.projectKey,
        channel: session.channel,
      }),
      'utf-8',
    );

    // 写入 session_start 事件
    const { EventStore } = await import('./events.js');
    const eventStore = new EventStore();
    await eventStore.append(sessionDir, {
      type: 'session_start',
      session_id: session.id,
      timestamp: now,
    });

    // 初始化 stats
    const { StatsManager } = await import('./stats.js');
    const statsManager = new StatsManager();
    await statsManager.init(sessionDir);
  });
}

/**
 * 获取 sessions 根目录：~/.agent/sessions/
 */
function getSessionsRoot(): string {
  return path.join(os.homedir(), '.agent', 'sessions');
}

/**
 * 获取 session 目录：~/.agent/sessions/<sessionId>/
 */
function getSessionDir(sessionId: string): string {
  return path.join(getSessionsRoot(), sessionId);
}

/**
 * 确保目录存在，不存在则递归创建
 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * 确保文件存在，不存在则创建空文件
 */
async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '', 'utf-8');
  }
}

export class SessionManager {
  private projectKey: string;
  private sessionsRoot: string;

  constructor(cwd: string, sessionsRoot?: string) {
    this.projectKey = toProjectKey(cwd);
    // 可注入自定义 sessions 根目录（测试隔离用）；默认全局 ~/.agent/sessions/
    this.sessionsRoot = sessionsRoot ?? getSessionsRoot();
  }

  /**
   * 惰性新建（零副作用）：只生成 session id（含渠道前缀）与 Session 对象，
   * **不创建目录、不写任何文件、不触发 cleanup**。
   * 目录与文件由首条消息到达时的 materializeLazySession 物化——
   * 用户启动后直接 switch_session 切旧会话时，不产生任何空 session 残留。
   */
  createLazy(channel?: string): Session {
    const now = new Date().toISOString();
    return {
      id: generateSessionId(channel),
      projectKey: this.projectKey,
      createdAt: now,
      updatedAt: now,
      type: 'normal',
      channel,
    };
  }

  /**
   * 创建新 session（含物化写入）
   * type 为开放 SessionType（内置 normal/precise/companion，插件可扩展）
   */
  async create(type: SessionType = 'normal', channel?: string): Promise<Session> {
    // 清理过期 session
    await this.cleanup();

    const session = this.createLazy(channel);
    session.type = type;
    await materializeLazySession(path.join(this.sessionsRoot, session.id), session);
    return session;
  }

  /**
   * 恢复指定 session，不指定则恢复最近的。
   *
   * 如果指定了 sessionId 但目录不存在，自动创建（以便渠道传 feishu_group_xxx 等
   * 可识别 ID 时，首次调用能自动建立 session 存储）。
   */
  async resume(sessionId?: string): Promise<Session> {
    if (sessionId) {
      const sessionDir = path.join(this.sessionsRoot, sessionId);

      // 目录不存在 → 自动创建（首次调用或重启后重建）。
      // 跨进程互斥：TUI 与 WebUI 共享 sessions 目录，双进程同时建同一 session
      // 会并发写 meta/events/stats。锁内二次检查 + 递归读回（meta 分支在下方）。
      try {
        await fs.access(sessionDir);
      } catch {
        return withSessionDirLock(sessionDir, async () => {
          try {
            await fs.access(sessionDir);
          } catch {
            await ensureDir(sessionDir);
            await ensureFile(path.join(sessionDir, 'conversation.jsonl'));
            await ensureFile(path.join(sessionDir, 'events.jsonl'));
            await ensureFile(path.join(sessionDir, 'stats.json'));

            const now = new Date().toISOString();
            // 检测 sessionId 前缀判断渠道来源（注册表：内置 feishu_/webui_/ui_/tui_ + 插件扩展）
            const channel = resolveChannelFromSessionId(sessionId);
            await fs.writeFile(
              path.join(sessionDir, 'meta.json'),
              JSON.stringify({ type: 'normal', createdAt: now, channel, projectKey: this.projectKey }),
              'utf-8',
            );

            // 写入 session_start 事件
            const { EventStore } = await import('./events.js');
            const eventStore = new EventStore();
            await eventStore.append(sessionDir, {
              type: 'session_start',
              session_id: sessionId,
              timestamp: now,
            });

            // 初始化 stats
            const { StatsManager } = await import('./stats.js');
            const statsManager = new StatsManager();
            await statsManager.init(sessionDir);

            logger.info('Auto-created session', { sessionId, channel });
          }
          // 读回已创建/已存在的 session（走下方 meta 分支）
          return this.resume(sessionId);
        });
      }

      // 目录已存在 → 读取 meta.json
      let type: SessionType | undefined;
      let createdAt = '';
      let projectKey = this.projectKey;
      let channel: string | undefined;
      try {
        const metaPath = path.join(sessionDir, 'meta.json');
        if (existsSync(metaPath)) {
          const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
          createdAt = meta.createdAt ?? '';
          // 开放类型：接受任意合法字符串（含插件扩展的 session 类型）
          if (typeof meta.type === 'string' && meta.type.length > 0) type = meta.type as SessionType;
          if (meta.projectKey) projectKey = meta.projectKey;
          if (typeof meta.channel === 'string') channel = meta.channel;
        }
      } catch { /* meta.json 缺失或损坏，使用默认值 */ }

      const session: Session = {
        id: sessionId,
        projectKey,
        createdAt,
        updatedAt: new Date().toISOString(),
        type,
        channel,
      };
      return session;
    }

    // 恢复最近的 session
    const latest = await this.getLatest();
    if (!latest) {
      throw new Error(`No sessions found`);
    }
    return latest;
  }

  /**
   * 列出所有 session
   */
  async list(): Promise<Session[]> {
    await ensureDir(this.sessionsRoot);

    const entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.sessionsRoot, entry.name);
      try {
        const stat = await fs.stat(sessionDir);
        // 读取 session 元信息
        let sessionType: SessionType | undefined;
        let projectKey = '';
        let channel: string | undefined;
        try {
          const metaRaw = await fs.readFile(path.join(sessionDir, 'meta.json'), 'utf-8');
          const meta = JSON.parse(metaRaw);
          // 开放类型：接受任意合法字符串（含插件扩展的 session 类型）
          if (typeof meta.type === 'string' && meta.type.length > 0) sessionType = meta.type as SessionType;
          projectKey = meta.projectKey ?? '';
          channel = meta.channel;
        } catch { /* 旧 session 没有 meta.json，默认为 normal */ }
        sessions.push({
          id: entry.name,
          projectKey,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          type: sessionType ?? 'normal',
          channel,
        });
      } catch {
        // 跳过无法访问的目录
      }
    }

    // 按 createdAt 降序排列
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sessions;
  }

  /**
   * 获取最近的 session
   */
  async getLatest(): Promise<Session | null> {
    const sessions = await this.list();
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * 获取指定渠道最近一次会话（按渠道过滤，防止重启后跨渠道串用 session）。
   *
   * 场景：TUI 与飞书共享同一进程，重启恢复时若不按渠道过滤，
   * resume() 会取全局最近 session —— 可能把飞书渠道的 session 恢复给 TUI。
   * 跨渠道加载应通过工具（switch_session）显式完成，重启自动恢复必须按渠道隔离。
   */
  async getLatestByChannel(channel: string): Promise<Session | null> {
    const sessions = await this.list();
    // list() 已按 createdAt 降序，取第一个匹配渠道的即为该渠道最近 session
    return sessions.find((s) => s.channel === channel) ?? null;
  }

  /**
   * 获取 session 目录路径
   */
  getSessionDir(sessionId: string): string {
    return path.join(this.sessionsRoot, sessionId);
  }

  /**
   * 获取 projectKey
   */
  getProjectKey(): string {
    return this.projectKey;
  }

  /**
   * 获取 sessions 根目录
   */
  getSessionsRoot(): string {
    return this.sessionsRoot;
  }

  /**
   * 清理过期 session，删除 updatedAt 超过 maxAgeDays 的 session 目录
   * @param maxAgeDays 最大保留天数，默认从环境变量 AGENT_MAX_SESSION_AGE 读取，否则 30 天
   * @returns 被清理的 session 数量
   */
  async cleanup(maxAgeDays?: number): Promise<number> {
    const maxAge = maxAgeDays ?? MAX_SESSION_AGE_DAYS;
    const sessions = await this.list();
    const now = Date.now();
    const maxAgeMs = maxAge * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const session of sessions) {
      const updatedAtTime = new Date(session.updatedAt).getTime();
      if (now - updatedAtTime > maxAgeMs) {
        const sessionDir = path.join(this.sessionsRoot, session.id);
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info('Cleaned up expired session', { sessionId: session.id });
        deletedCount++;
      }
    }

    return deletedCount;
  }
}
