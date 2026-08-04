import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Session } from '../types.js';
import { createLogger } from '../logging/logger.js';
import { toProjectKey } from '../utils/misc.js';

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
   * 创建新 session
   */
  async create(type: 'normal' | 'precise' = 'normal', channel?: string): Promise<Session> {
    // 清理过期 session
    await this.cleanup();

    const id = generateSessionId(channel);
    const now = new Date().toISOString();
    const session: Session = {
      id,
      projectKey: this.projectKey,
      createdAt: now,
      updatedAt: now,
      type,
      channel,
    };

    const sessionDir = path.join(this.sessionsRoot, id);
    await ensureDir(sessionDir);

    // 创建 session 必需的文件
    await ensureFile(path.join(sessionDir, 'conversation.jsonl'));
    await ensureFile(path.join(sessionDir, 'events.jsonl'));
    await ensureFile(path.join(sessionDir, 'stats.json'));

    // 持久化 session 元信息（type、projectKey、channel 等）
    await fs.writeFile(
      path.join(sessionDir, 'meta.json'),
      JSON.stringify({ type, createdAt: now, projectKey: this.projectKey, channel }),
      'utf-8',
    );

    // 写入 session_start 事件
    const { EventStore } = await import('./events.js');
    const eventStore = new EventStore();
    await eventStore.append(sessionDir, {
      type: 'session_start',
      session_id: id,
      timestamp: now,
    });

    // 初始化 stats
    const { StatsManager } = await import('./stats.js');
    const statsManager = new StatsManager();
    await statsManager.init(sessionDir);

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

      // 目录不存在 → 自动创建（首次调用或重启后重建）
      try {
        await fs.access(sessionDir);
      } catch {
        await ensureDir(sessionDir);
        await ensureFile(path.join(sessionDir, 'conversation.jsonl'));
        await ensureFile(path.join(sessionDir, 'events.jsonl'));
        await ensureFile(path.join(sessionDir, 'stats.json'));

        const now = new Date().toISOString();
        // 检测 sessionId 前缀判断渠道来源
        let channel: string | undefined;
        if (sessionId.startsWith('feishu_')) channel = 'feishu';
        else if (sessionId.startsWith('webui_')) channel = 'webui';
        else if (sessionId.startsWith('tui_')) channel = 'tui';
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

        const session: Session = {
          id: sessionId,
          projectKey: this.projectKey,
          createdAt: now,
          updatedAt: now,
          type: 'normal',
        };
        logger.info('Auto-created session', { sessionId, channel });
        return session;
      }

      // 目录已存在 → 读取 meta.json
      let type: 'normal' | 'precise' | undefined;
      let createdAt = '';
      let projectKey = this.projectKey;
      let channel: string | undefined;
      try {
        const metaPath = path.join(sessionDir, 'meta.json');
        if (existsSync(metaPath)) {
          const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
          createdAt = meta.createdAt ?? '';
          if (meta.type === 'precise' || meta.type === 'normal') type = meta.type;
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
        let sessionType: 'normal' | 'precise' | undefined;
        let projectKey = '';
        let channel: string | undefined;
        try {
          const metaRaw = await fs.readFile(path.join(sessionDir, 'meta.json'), 'utf-8');
          const meta = JSON.parse(metaRaw);
          if (meta.type === 'precise' || meta.type === 'normal') sessionType = meta.type;
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
