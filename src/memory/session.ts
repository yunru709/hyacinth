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
 * 生成 Session ID：YYYYMMDD-HHMMSS-XXXX（时间戳 + 4位随机hex）
 */
function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const randomPart = crypto.randomBytes(2).toString('hex');
  return `${datePart}-${timePart}-${randomPart}`;
}

/**
 * 获取项目存储根目录：~/.agent/projects/<projectKey>/
 */
function getProjectDir(projectKey: string): string {
  return path.join(os.homedir(), '.agent', 'projects', projectKey);
}

/**
 * 获取 session 目录
 */
function getSessionDir(projectKey: string, sessionId: string): string {
  return path.join(getProjectDir(projectKey), sessionId);
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
  private projectDir: string;

  constructor(cwd: string) {
    this.projectKey = toProjectKey(cwd);
    this.projectDir = getProjectDir(this.projectKey);
  }

  /**
   * 创建新 session
   */
  async create(type: 'normal' | 'precise' = 'normal'): Promise<Session> {
    // 清理过期 session
    await this.cleanup();

    const id = generateSessionId();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      projectKey: this.projectKey,
      createdAt: now,
      updatedAt: now,
      type,
    };

    const sessionDir = getSessionDir(this.projectKey, id);
    await ensureDir(sessionDir);

    // 创建 session 必需的文件
    await ensureFile(path.join(sessionDir, 'conversation.jsonl'));
    await ensureFile(path.join(sessionDir, 'events.jsonl'));
    await ensureFile(path.join(sessionDir, 'stats.json'));

    // 持久化 session 元信息（type 等）
    await fs.writeFile(
      path.join(sessionDir, 'meta.json'),
      JSON.stringify({ type, createdAt: now }),
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
      const sessionDir = getSessionDir(this.projectKey, sessionId);

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
        const channel = sessionId.startsWith('feishu_') ? 'feishu' : undefined;
        await fs.writeFile(
          path.join(sessionDir, 'meta.json'),
          JSON.stringify({ type: 'normal', createdAt: now, channel }),
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
      try {
        const metaPath = path.join(sessionDir, 'meta.json');
        if (existsSync(metaPath)) {
          const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
          createdAt = meta.createdAt ?? '';
          if (meta.type === 'precise' || meta.type === 'normal') type = meta.type;
        }
      } catch { /* meta.json 缺失或损坏，使用默认值 */ }

      const session: Session = {
        id: sessionId,
        projectKey: this.projectKey,
        createdAt,
        updatedAt: new Date().toISOString(),
        type,
      };
      return session;
    }

    // 恢复最近的 session
    const latest = await this.getLatest();
    if (!latest) {
      throw new Error(`No sessions found for project: ${this.projectKey}`);
    }
    return latest;
  }

  /**
   * 列出当前项目的所有 session
   */
  async list(): Promise<Session[]> {
    await ensureDir(this.projectDir);

    const entries = await fs.readdir(this.projectDir, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const sessionDir = path.join(this.projectDir, entry.name);
      try {
        const stat = await fs.stat(sessionDir);
        // 读取 session 元信息（type 等）
        let sessionType: 'normal' | 'precise' | undefined;
        try {
          const metaRaw = await fs.readFile(path.join(sessionDir, 'meta.json'), 'utf-8');
          const meta = JSON.parse(metaRaw);
          if (meta.type === 'precise' || meta.type === 'normal') sessionType = meta.type;
        } catch { /* 旧 session 没有 meta.json，默认为 normal */ }
        sessions.push({
          id: entry.name,
          projectKey: this.projectKey,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          type: sessionType ?? 'normal',
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
   * 获取 session 目录路径
   */
  getSessionDir(sessionId: string): string {
    return getSessionDir(this.projectKey, sessionId);
  }

  /**
   * 获取 projectKey
   */
  getProjectKey(): string {
    return this.projectKey;
  }

  /**
   * 获取项目存储根目录
   */
  getProjectDir(): string {
    return this.projectDir;
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
        const sessionDir = getSessionDir(this.projectKey, session.id);
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info('Cleaned up expired session', { sessionId: session.id });
        deletedCount++;
      }
    }

    return deletedCount;
  }
}
