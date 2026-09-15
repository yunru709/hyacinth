// ============================================================
// UI 协议层 — 会话域（session.*）
// ============================================================
// 覆盖 UI 对会话管理的全部操作：
//   session.list       列出所有会话（元数据数组）
//   session.resume     恢复指定会话（不指定则恢复最近）
//   session.create     创建新会话（type: normal|precise|companion, channel?）
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
  create(type?: SessionType, channel?: string): Promise<BackendSession>;
  resume(sessionId?: string): Promise<BackendSession>;
  list(): Promise<BackendSession[]>;
  getLatest(): Promise<BackendSession | null>;
  getLatestByChannel(channel: string): Promise<BackendSession | null>;
  getSessionDir(sessionId: string): string;
}

// ────────────────────────────────────────────────────────────
// 会话域选项
// ────────────────────────────────────────────────────────────

export interface SessionDomainOptions {
  sessionManager: SessionManagerLike;
  /** 会话变更事件推送（绑定到 server.broadcast）。可选。 */
  emit?: (type: string, payload?: unknown) => void;
  /** AgentLoop（session.switch 用：切换 loop 当前会话目录）。可选。 */
  loop?: LoopLike | null;
  /** 动态获取 AgentLoop（loop 在 initialize 后才就绪时的延迟解析）。可选。 */
  getLoop?: () => LoopLike | null;
}

// ────────────────────────────────────────────────────────────
// 会话域工厂
// ────────────────────────────────────────────────────────────

export function createSessionDomain(options: SessionDomainOptions): DomainHandler {
  const { sessionManager, emit, loop, getLoop } = options;

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

  return {
    // ── session.list ───────────────────────────────────────
    async list(): Promise<{ sessions: SessionMeta[] }> {
      const sessions = await sessionManager.list();
      return { sessions: sessions.map(toMeta) };
    },

    // ── session.resume ─────────────────────────────────────
    async resume(params: unknown): Promise<SessionMeta> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      const session = await sessionManager.resume(sessionId);
      return toMeta(session);
    },

    // ── session.create ─────────────────────────────────────
    async create(params: unknown): Promise<SessionMeta> {
      const { type, channel } = (params as { type?: SessionType; channel?: string } | undefined) ?? {};
      const session = await sessionManager.create(type, channel);
      const meta = toMeta(session);
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'create', session: meta });
      return meta;
    },

    // ── session.delete ─────────────────────────────────────
    async delete(params: unknown): Promise<{ ok: true; sessionId: string }> {
      const sessionId = (params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error('session.delete requires "sessionId"');
      await ensureExists(sessionId);
      const sessionDir = sessionManager.getSessionDir(sessionId);
      await rm(sessionDir, { recursive: true, force: true });
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'delete', sessionId });
      return { ok: true, sessionId };
    },

    // ── session.batchDelete ────────────────────────────────
    // 批量删除多个会话（不存在的不报错，记录到 notFound）。
    async batchDelete(params: unknown): Promise<{ ok: true; deleted: string[]; notFound: string[] }> {
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
        await rm(sessionManager.getSessionDir(id), { recursive: true, force: true });
        deleted.push(id);
      }
      if (deleted.length > 0) {
        emit?.(UI_EVENT.SESSION_CHANGE, { action: 'batchDelete', deleted });
      }
      return { ok: true, deleted, notFound };
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
      const sessionDir = sessionManager.getSessionDir(sessionId);
      await l.switchSession(sessionDir);
      emit?.(UI_EVENT.SESSION_CHANGE, { action: 'switch', sessionId });
      return { ok: true, sessionId };
    },
  };
}

