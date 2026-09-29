import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
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
  // 测试隔离（HYACINTH_SESSIONS_ROOT）：把 sessions 根目录重定向到临时目录。
  // 背景：本函数原先硬编码 ~/.agent/sessions，导致测试（http-webhook / 装配类用例）
  // 在**用户真实目录**里建会话目录 —— 每次全量跑都会新增若干裸日期目录，长期成垃圾。
  // 生产行为不变：只有显式设置该环境变量时才改路径。
  const override = process.env.HYACINTH_SESSIONS_ROOT;
  if (override && override.trim().length > 0) return override;
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
   * type 为开放 SessionType（内置 normal/companion，插件可扩展）
   *
   * 2026-09-30：会话按**模式分桶** —— 目录＝ `sessions/<模式名>/<sessionId>/`。
   * 分桶即约束：会话与模式一一归属，跨模式切换在结构上就说不通
   * （设施层再补"列表过滤 + 明确拒绝"，两层合力，见 listByMode / loop.switchSession）。
   */
  async create(type: SessionType = 'normal', channel?: string): Promise<Session> {
    // 清理过期 session
    await this.cleanup();

    const session = this.createLazy(channel);
    session.type = type;
    await materializeLazySession(this.dirForNew(type, session.id), session);
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
      // 分桶后目录不再能由 id 直接拼出 ⇒ 走统一解析（桶内 → 旧扁平布局 → 默认桶）
      const sessionDir =
        this.resolveExistingDir(sessionId) ?? this.dirForNew('normal', sessionId);

      // 目录不存在 → 自动创建（首次调用或重启后重建）。
      // 跨进程互斥：TUI 与 WebUI 共享 sessions 目录，双进程同时建同一 session
      // 会并发写 meta/events/stats。锁内二次检查 + 递归读回（meta 分支在下方）。
      try {
        await fs.access(sessionDir);
      } catch {
        return withSessionDirLock(sessionDir, async () => {
          // ⚠️ 二次检查必须查 **meta.json**（物化标记），**不能查目录** ✗：
          // withSessionDirLock 自己会先 mkdir(sessionDir)（session-lock.ts:39）⇒
          // 查目录**必然成功** ⇒ 下面那段物化**永不执行** ⇒ 只留 0 文件空目录。
          // 实测 2026-09-20：136 个 0 文件的 webui_ 空壳即由此产生 ✓
          try {
            await fs.access(path.join(sessionDir, 'meta.json'));
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
   * 列出所有 session —— **两种布局都认**：
   *   · 分桶（现行）：`sessions/<模式名>/<sessionId>/`
   *   · 旧扁平（待迁移）：`sessions/<sessionId>/`
   * 判据 = 该目录有没有 `meta.json`（会话物化标记）：有 ⇒ 它自己就是会话；
   * 没有 ⇒ 当作模式桶，往下再扫一层。这样迁移做到一半也不会丢会话 ✓
   */
  async list(): Promise<Session[]> {
    await ensureDir(this.sessionsRoot);

    const entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(this.sessionsRoot, entry.name);

      if (existsSync(path.join(entryPath, 'meta.json'))) {
        const s = await this.readSessionAt(entryPath, entry.name);
        if (s) sessions.push(s);
        continue;
      }

      let inner: Array<{ isDirectory(): boolean; name: string }> = [];
      try {
        inner = await fs.readdir(entryPath, { withFileTypes: true });
      } catch { continue; }
      for (const sub of inner) {
        if (!sub.isDirectory()) continue;
        const s = await this.readSessionAt(path.join(entryPath, sub.name), sub.name);
        if (s) sessions.push(s);
      }
    }

    // 按 createdAt 降序排列
    sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sessions;
  }

  /** 读一个会话目录的元信息（列表与解析共用；读不到 meta 时按普通模式兜底） */
  private async readSessionAt(sessionDir: string, id: string): Promise<Session | null> {
    try {
      const stat = await fs.stat(sessionDir);
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
      return {
        id,
        projectKey,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        type: sessionType ?? 'normal',
        channel,
      };
    } catch {
      return null; // 无法访问的目录 → 跳过
    }
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
    // list() 已按 createdAt 降序，第一个匹配的即该渠道最近 session。
    // 判据三重（②③ 为兜底，专治「meta.json 缺 channel 的存量会话」）：
    //   ① meta.channel 精确匹配
    //   ② ID 前缀反解（注册表，能识别 webui_/ui_ 这类一渠道多前缀）
    //   ③ ID 前缀字面量 `<channel>_`
    // 需要 ②③ 的原因：channel 是后加的字段，2026-09-17 之前由 UI 入口创建的
    // webui_*/ui_* 会话 meta 里没有它（当时前缀未登记、反解失败）。只认 ① 会让
    // 这些会话**永远**恢复不到 ⇒ 每次重启都新开一个会话。
    return sessions.find((s) =>
      s.channel === channel
      || resolveChannelFromSessionId(s.id) === channel
      || s.id.startsWith(`${channel}_`),
    ) ?? null;
  }

  /**
   * 桶名（= 模式名）—— 最小净化：只接受安全字符，防路径穿越；空/非法 → normal。
   * 静态：解析与迁移都要用，且不依赖实例状态。
   */
  static bucketName(type: string | undefined): string {
    const t = (type ?? '').trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(t) ? t : 'normal';
  }

  /** 新建会话的目标目录：`sessions/<模式名>/<id>` */
  private dirForNew(type: string | undefined, sessionId: string): string {
    return path.join(this.sessionsRoot, SessionManager.bucketName(type), sessionId);
  }

  /**
   * 已存在会话的目录：桶内 `sessions/<某模式>/<id>` → 旧扁平 `sessions/<id>`；
   * 都没有 → null。
   *
   * 同步解析（调用方多为同步路径）⇒ 用 readdirSync：顶层只有"每个模式一个桶"
   * ＋若干待迁移会话，量级很小 ✓
   */
  private resolveExistingDir(sessionId: string): string | null {
    let names: string[] = [];
    try {
      names = readdirSync(this.sessionsRoot);
    } catch { /* 根目录还不存在 → 视为不存在 */ }
    for (const name of names) {
      if (name === sessionId) continue;
      const candidate = path.join(this.sessionsRoot, name, sessionId);
      if (existsSync(candidate)) return candidate;
    }
    const legacy = path.join(this.sessionsRoot, sessionId);
    return existsSync(legacy) ? legacy : null;
  }

  /**
   * 获取 session 目录路径 —— **桶内优先，兼容旧扁平布局**。
   *
   * 分桶后目录不再能由 id 拼出（要先知道模式）⇒ 统一在这里解析；
   * 找不到（尚未物化）时给默认桶路径（调用方若已知模式，应改用 dirForNew）。
   */
  getSessionDir(sessionId: string): string {
    return this.resolveExistingDir(sessionId) ?? this.dirForNew('normal', sessionId);
  }

  /**
   * 把旧扁平布局的会话迁进各自的模式桶：`sessions/<id>` → `sessions/<meta.type>/<id>`。
   *
   * - **幂等 / 可重入**：只动"顶层含 meta.json 的目录"（= 会话本体）；已分桶的结构天然不匹配
   * - **不丢数据**：目标已存在同名会话 ⇒ 跳过并计入 skipped（**绝不覆盖** ✗）
   * - 单个失败不影响其余（计入 skipped，下次启动重试）
   * - 返回 `{ moved, skipped }`：启动日志与验证都用它
   */
  async migrateLegacyLayout(): Promise<{ moved: string[]; skipped: string[] }> {
    await ensureDir(this.sessionsRoot);
    const moved: string[] = [];
    const skipped: string[] = [];

    for (const entry of await fs.readdir(this.sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const from = path.join(this.sessionsRoot, entry.name);
      const metaPath = path.join(from, 'meta.json');
      if (!existsSync(metaPath)) continue; // 不是会话目录（可能已是桶）

      let type = 'normal';
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        if (typeof meta.type === 'string' && meta.type.trim()) type = meta.type.trim();
      } catch { /* meta 损坏 → 归入 normal 桶，会话本体不丢 */ }

      const bucket = SessionManager.bucketName(type);
      const to = path.join(this.sessionsRoot, bucket, entry.name);
      if (existsSync(to)) {
        skipped.push(entry.name);
        continue;
      }
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        moved.push(`${entry.name} -> ${bucket}/`);
        logger.info('session migrated to mode bucket', { id: entry.name, bucket });
      } catch (err) {
        skipped.push(entry.name);
        logger.warn('session migrate failed (will retry next boot)', {
          id: entry.name,
          error: (err as Error).message,
        });
      }
    }
    return { moved, skipped };
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
        // ⚠️ 分桶后目录必须**先解析**（不能由 id 拼 ✗）：`sessions/<id>` 那个位置现在是
        // **模式桶**，直接拼会连整桶（该模式所有会话）一起删掉 ✗✗
        const sessionDir = this.getSessionDir(session.id);
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info('Cleaned up expired session', { sessionId: session.id });
        deletedCount++;
      }
    }

    // ── 空壳目录回收（2026-09-20）──
    // 判据：目录里**一个文件都没有** 且 mtime 早于 1 小时 ⇒ 是"只 mkdir、从未物化"的残留。
    // 来源事故：WebUI 每次 WS 连接都 resume(全新 id) ⇒ 建目录但从不写文件
    //   （resume 里那段死代码，已修 ✓）⇒ 实测累积 136 个。
    // 1 小时宽限期：避免误删"正在物化"的目录 ✓
    const EMPTY_DIR_GRACE_MS = 60 * 60 * 1000;
    for (const session of sessions) {
      const sessionDir = this.getSessionDir(session.id); // 同上：必须先解析
      try {
        const st = await fs.stat(sessionDir);
        if (now - st.mtimeMs < EMPTY_DIR_GRACE_MS) continue;
        const entries = await fs.readdir(sessionDir);
        if (entries.length > 0) continue;
        await fs.rm(sessionDir, { recursive: true, force: true });
        logger.info('Reaped empty session dir', { sessionId: session.id });
        deletedCount++;
      } catch { /* 目录已不存在/不可读 ⇒ 跳过 */ }
    }

    return deletedCount;
  }
}

/**
 * 便捷解析：给**不持有 SessionManager 实例**的调用方用（如旁路编排按 id 写 cluster
 * 摘要 / 读 conversation_full）。分桶后目录不能再由 id 直接拼 ✗ ——
 * 一律走这里，免得又散出几处 `path.join(homedir, '.agent', 'sessions', id)`。
 */
export function resolveSessionDir(sessionId: string, sessionsRoot?: string): string {
  return new SessionManager(process.cwd(), sessionsRoot).getSessionDir(sessionId);
}
