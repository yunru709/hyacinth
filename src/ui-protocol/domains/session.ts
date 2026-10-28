// ============================================================
// UI 契约层 — 会话域（session.*）
// ============================================================
// 覆盖 UI 对会话管理的全部操作：
//   session.list       列出所有会话（元数据数组）
//   session.resume     恢复指定会话（不指定则恢复最近）
//   session.create     创建新会话（type: normal|companion, channel?）
//   session.delete     删除会话（及其全部数据）
//   session.getLatest  获取最近会话
//
// 会话域包一层 SessionManager（真实实现）或测试 mock。
// delete 复用了项目既有的 fs.rm(sessionDir) 语义（与 http-webhook
// 的 DELETE /api/sessions/:id、cli delete 命令一致）。
// ============================================================

import { rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';
import type { SessionMeta } from '../types.js';
import type { SessionType } from '../../types.js';
import type { LoopLike } from './state.js';
import { buildZip } from '../util/zip.js';

// ────────────────────────────────────────────────────────────
// 最小会话管理器接口（SessionManager 结构兼容）
// ────────────────────────────────────────────────────────────

/** 后端会话对象（对应 src/types.ts 的 Session） */
export interface BackendSession {
  id: string;
  projectKey: string;
  createdAt: string;
  updatedAt: string;
  type?: SessionType;
  channel?: string;
}

export interface SessionManagerLike {
  /**
   * 新建会话。
   * `opts.lazy` ⇒ 只铸 id、不落盘（目录等首条消息由 loop 物化）。
   * 见 SessionManager.create 的同名参数说明。
   */
  create(type?: SessionType, channel?: string, opts?: { lazy?: boolean }): Promise<BackendSession>;
  resume(sessionId?: string): Promise<BackendSession>;
  list(): Promise<BackendSession[]>;
  getLatest(): Promise<BackendSession | null>;
  getLatestByChannel(channel: string): Promise<BackendSession | null>;
  getSessionDir(sessionId: string): string;
}

// ────────────────────────────────────────────────────────────
// 会话域选项
// ────────────────────────────────────────────────────────────

/**
 * 会话占用端口（结构兼容 src/memory/session-claims.ts）。
 * 协议层只依赖这 4 个同步方法，不 import 存储层实现。
 */
export interface SessionClaimPort {
  claim(sessionId: string, owner: string): boolean;
  release(sessionId: string, owner: string): void;
  ownerOf(sessionId: string): string | null;
  transfer(from: string | null | undefined, to: string, owner: string): boolean;
}

export interface SessionDomainOptions {
  sessionManager: SessionManagerLike;
  /** 会话变更事件推送（绑定到 server.broadcast）。可选。 */
  emit?: (type: string, payload?: unknown) => void;
  /** AgentLoop（session.switch 用：切换 loop 当前会话目录）。可选。 */
  loop?: LoopLike | null;
  /** 动态获取 AgentLoop（loop 在 initialize 后才就绪时的延迟解析）。可选。 */
  getLoop?: () => LoopLike | null;
  /** 会话占用表（多标签互斥）。未注入时不做占用校验。 */
  claims?: SessionClaimPort;
  /** 本连接的占用令牌（每条 UI 连接唯一）。 */
  claimOwner?: string;
  /** 本连接当前占用的 sessionId（切换后由 setClaimedSessionId 更新）。 */
  getClaimedSessionId?: () => string | null;
  setClaimedSessionId?: (sessionId: string) => void;
}

// ────────────────────────────────────────────────────────────
// 会话域工厂
// ────────────────────────────────────────────────────────────

export function createSessionDomain(options: SessionDomainOptions): DomainHandler {
  const { sessionManager, emit, loop, getLoop, claims, claimOwner } = options;

  /** 后端 Session → 协议 SessionMeta（剔除 projectKey 等内部字段） */
  const toMeta = (s: BackendSession): SessionMeta => ({
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    type: s.type,
    channel: s.channel,
  });

  /** 校验 sessionId 存在（delete/resume 用） */
  async function ensureExists(sessionId: string): Promise<void> {
    const sessions = await sessionManager.list();
    if (!sessions.some((s) => s.id === sessionId)) {
      throw new Error(`session "${sessionId}" not found`);
    }
  }

  /** 递归收集目录内全部文件（相对路径，正斜杠分隔） */
  async function collectFiles(dir: string): Promise<{ rel: string; data: Buffer }[]> {
    const out: { rel: string; data: Buffer }[] = [];
    const walk = async (cur: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(cur, { withFileTypes: true });
      } catch {
        return; // 目录不存在或不可读 → 跳过
      }
      for (const e of entries) {
        const abs = path.join(cur, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(abs, rel);
        } else if (e.isFile()) {
          const data = await readFile(abs);
          out.push({ rel, data });
        }
      }
    };
    await walk(dir, '');
    return out;
  }

  /** 归一化 sessionIds：去重、去空串 */
  function normalizeIds(params: unknown): string[] {
    const ids = (params as { sessionIds?: unknown } | undefined)?.sessionIds;
    if (!Array.isArray(ids)) {
      throw new Error('requires non-empty "sessionIds" array');
    }
    const unique = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))];
    if (unique.length === 0) {
      throw new Error('requires non-empty "sessionIds" array');
    }
    return unique;
  }

  /**
   * 当前"用户看着"的会话 id（由 loop 的目录末段推断）；拿不到返回 ''。
   *
   * 优先 targetSessionDir（含待切换）：空闲状态下切会话时 currentSessionDir 还是旧的，
   * 而界面已经显示新会话 —— 用 current 判断"删的是不是当前"会全部漏判
   * （实测 nextSessionId 恒为 null，删光都不新建）。
   */
  function currentSessionIdOf(): string {
    const l = loop ?? getLoop?.() ?? null;
    const dir = l?.targetSessionDir ?? l?.currentSessionDir;
    return dir ? path.basename(dir) : '';
  }

  /** 释放本连接对某会话的占用（delete 走这条；仅持有者匹配时生效） */
  function releaseClaim(sessionId: string): void {
    if (claims && claimOwner) claims.release(sessionId, claimOwner);
  }

  /**
   * 删掉**当前会话**之后的自愈：切到剩余里最新的一条；一条不剩就新建一条。
   *
   * 为什么必须在域里做（而不是交给前端）：这是**会话语义**——
   * "当前会话没了，下一条消息该写到哪"。后端 `session.delete` 只 rm 目录、
   * 不动 `loop.sessionDir`，若没人接管，下一条消息会沿旧路径把目录原样写回来
   * （用户看到"刚清空，刷新一下又有几条"）。TUI 删当前会话时也必须得到同一结果，
   * 放在前端就等于只修了 WebUI —— 所以判定与切换都在这里，UI 只负责"跳过去并重画"。
   *
   * @returns nextSessionId 为空表示"删的不是当前会话"（无需善后）
   */
  async function settleAfterDelete(deleted: string[]): Promise<{
    nextSessionId: string | null;
    createdNew: boolean;
  }> {
    const cur = currentSessionIdOf();
    if (!cur || !deleted.includes(cur)) return { nextSessionId: null, createdNew: false };
    const l = loop ?? getLoop?.() ?? null;
    // 没有 loop（测试 / 无 agent 场景）：无从自愈，前端拿到 null 也不会乱切
    if (!l?.switchSession) return { nextSessionId: null, createdNew: false };

    const gone = new Set(deleted);
    const rest = (await sessionManager.list())
      .filter((s) => !gone.has(s.id))
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    // 优先挑**没有被别的标签占用**的会话：否则自愈会把本 loop 接到别人正在
    // 驱动的目录上，两个 loop 交错写同一个 events.jsonl（多标签场景新增约束）。
    const free = claims && claimOwner
      ? rest.filter((s) => {
          const holder = claims.ownerOf(s.id);
          return !holder || holder === claimOwner;
        })
      : rest;

    if (free.length > 0) {
      const next = free[0];
      await l.switchSession(sessionManager.getSessionDir(next.id));
      if (claims && claimOwner && claims.claim(next.id, claimOwner)) {
        options.setClaimedSessionId?.(next.id);
      }
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'switch', sessionId: next.id });
      return { nextSessionId: next.id, createdNew: false };
    }
    const created = await sessionManager.create();
    await l.switchSession(sessionManager.getSessionDir(created.id));
    if (claims && claimOwner) {
      claims.claim(created.id, claimOwner);
      options.setClaimedSessionId?.(created.id);
    }
    emit?.(UI_EVENT.SESSION_CHANGE, { action: 'create', session: toMeta(created) });
    emit?.(UI_EVENT.SESSION_CHANGE, { action: 'switch', sessionId: created.id });
    return { nextSessionId: created.id, createdNew: true };
  }

  return {
    // ── session.list ───────────────────────────────────────
    async list(): Promise<{ sessions: SessionMeta[] }> {
      // **只列当前模式的会话**（会话与模式一一归属 ⇒ 列出别的模式的会话，只会诱使人
      // 去切、然后被拒 ✗）。TUI 的 `/命令` 与 WebUI 都走这里 ⇒ 一处过滤，两处受益 ✓
      //
      // 优先走管理器的 listByMode（过滤的唯一入口）；测试里的轻量假件没有它 ⇒ 退回全量 ✗
      const mode = (options.loop as { activeRouter?: { name?: string } } | undefined)?.activeRouter?.name ?? 'normal';
      const sm = sessionManager as unknown as { listByMode?(m: string): Promise<BackendSession[]> };
      const sessions = sm.listByMode ? await sm.listByMode(mode) : await sessionManager.list();
      // 过滤一次性临时会话（定时任务 sessionPolicy='new' 建的 ephemeral 会话，5min 后自动销毁，列表不展示）
      const visible = sessions.filter((s) => !(s as { ephemeral?: boolean }).ephemeral);
      return { sessions: visible.map(toMeta) };
    },

    // ── session.resume ─────────────────────────────────────
    async resume(params: unknown): Promise<SessionMeta> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      const session = await sessionManager.resume(sessionId);
      return toMeta(session);
    },

    // ── session.create ─────────────────────────────────────
    // `lazy: true` ⇒ 只铸 id、不落盘（见 SessionManager.create 的同名参数）。
    // WebUI 的「新建标签 / 最后一个标签重置」走这条：用户只是想看到空对话界面，
    // 可能马上切回旧会话或去改配置，不该在磁盘留 0 文件空壳。
    // 落盘时机 = 首条消息（loop.materializeSessionIfNeeded）。
    async create(params: unknown): Promise<SessionMeta> {
      const { type, channel, lazy } =
        (params as { type?: SessionType; channel?: string; lazy?: boolean } | undefined) ?? {};
      const session = await sessionManager.create(type, channel, { lazy });
      const meta = toMeta(session);
      // lazy 的新会话尚未落盘 ⇒ 不广播 create（列表里查不到它，广播只会让前端困惑）
      if (lazy !== true) {
        emit?.(UI_EVENT.SESSION_CHANGE, { action: 'create', session: meta });
      }
      return meta;
    },

    // ── session.delete ─────────────────────────────────────
    // 删完若正是当前会话，顺手自愈（切到剩余里最新的一条 / 一条不剩就新建）。
    // nextSessionId 直接回给调用方：前端不必自己排序、也不必判断"该不该切"。
    async delete(params: unknown): Promise<{
      ok: true;
      sessionId: string;
      nextSessionId: string | null;
      createdNew: boolean;
    }> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error('session.delete requires "sessionId"');
      await ensureExists(sessionId);
      const sessionDir = sessionManager.getSessionDir(sessionId);
      releaseClaim(sessionId);
      await rm(sessionDir, { recursive: true, force: true });
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'delete', sessionId });
      const settled = await settleAfterDelete([sessionId]);
      return { ok: true, sessionId, ...settled };
    },

    // ── session.batchDelete ────────────────────────────────
    // 批量删除多个会话（不存在的不报错，记录到 notFound）。
    async batchDelete(params: unknown): Promise<{
      ok: true;
      deleted: string[];
      notFound: string[];
      nextSessionId: string | null;
      createdNew: boolean;
    }> {
      const sessionIds = normalizeIds(params);
      const sessions = await sessionManager.list();
      const exist = new Set(sessions.map((s) => s.id));
      const deleted: string[] = [];
      const notFound: string[] = [];
      for (const id of sessionIds) {
        if (!exist.has(id)) {
          notFound.push(id);
          continue;
        }
        releaseClaim(id);
        await rm(sessionManager.getSessionDir(id), { recursive: true, force: true });
        deleted.push(id);
      }
      if (deleted.length > 0) {
        emit?.(UI_EVENT.SESSION_CHANGE, { action: 'batchDelete', deleted });
      }
      const settled = deleted.length > 0
        ? await settleAfterDelete(deleted)
        : { nextSessionId: null, createdNew: false };
      return { ok: true, deleted, notFound, ...settled };
    },

    // ── session.export ─────────────────────────────────────
    // 把多份 session 打包为一个 zip（deflate），返回 base64 + 文件名。
    // zip 内结构：<sessionId>/<文件相对路径>（conversation.jsonl / events.jsonl /
    // stats.json / meta.json / 子目录等，递归收集）。
    async export(params: unknown): Promise<{ filename: string; data: string; count: number; notFound: string[] }> {
      const sessionIds = normalizeIds(params);
      const sessions = await sessionManager.list();
      const exist = new Set(sessions.map((s) => s.id));
      const entries: { path: string; data: Buffer }[] = [];
      const notFound: string[] = [];
      for (const id of sessionIds) {
        if (!exist.has(id)) {
          notFound.push(id);
          continue;
        }
        const dir = sessionManager.getSessionDir(id);
        const files = await collectFiles(dir);
        for (const f of files) {
          entries.push({ path: `${id}/${f.rel}`, data: f.data });
        }
      }
      if (entries.length === 0) {
        throw new Error('没有可导出的会话数据（所选会话均不存在或为空）');
      }
      const zipBuf = buildZip(entries);
      const pad = (n: number): string => String(n).padStart(2, '0');
      const now = new Date();
      const filename = `hyacinth-sessions-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.zip`;
      return { filename, data: zipBuf.toString('base64'), count: entries.length, notFound };
    },

    // ── session.getLatest ──────────────────────────────────
    async getLatest(): Promise<SessionMeta | null> {
      const session = await sessionManager.getLatest();
      return session ? toMeta(session) : null;
    },

    // ── session.switch ─────────────────────────────────────
    // 将 loop 当前会话切换为指定会话（对应 TUI /session <id>/load 的
    // loop.switchSession + 会话目录切换；会话内容历史由 message.history 读取）。
    async switch(params: unknown): Promise<{ ok: true; sessionId: string }> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error('session.switch requires "sessionId"');
      await ensureExists(sessionId);
      const l = loop ?? getLoop?.() ?? null;
      if (!l?.switchSession) {
        throw new Error('session.switch not supported (loop.switchSession not available)');
      }
      // 占用校验与转移必须在**切换之前**完成：切换后 loop 已经指向新目录，
      // 这时才发现被别人占用，本连接的下一条消息已经会写进对方会话 ✗
      const prevClaimed = options.getClaimedSessionId?.() ?? null;
      if (claims && claimOwner) {
        if (!claims.transfer(prevClaimed, sessionId, claimOwner)) {
          throw new Error(`会话 "${sessionId}" 已在另一个标签中打开，请先关闭那个标签`);
        }
      }
      const sessionDir = sessionManager.getSessionDir(sessionId);
      try {
        await l.switchSession(sessionDir);
      } catch (err) {
        // 切换失败：把占用还回去，避免目标会话被本连接"空占"到断线
        if (claims && claimOwner) {
          claims.release(sessionId, claimOwner);
          if (prevClaimed) claims.claim(prevClaimed, claimOwner);
        }
        throw err;
      }
      options.setClaimedSessionId?.(sessionId);
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'switch', sessionId });
      return { ok: true, sessionId };
    },
  };
}

