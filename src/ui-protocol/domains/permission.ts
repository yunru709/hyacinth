// ============================================================
// UI 协议层 — 权限域（permission.*）
// ============================================================
// 覆盖 UI 对权限请求的应答：
//   permission.resolve   { id, result }  应答指定权限请求
//
// 请求-应答关联机制：后端 OutputHandler.onPermissionRequest 会
// 返回一个 Promise，协议层把它转成 permission.request 事件广播
// 给所有 UI（带唯一 id），等 UI 通过 permission.resolve 回传
// result 后 resolve 该 Promise。
//
// 同时提供通用的 PendingRequestRegistry —— 消息域的
// onAskUser 也复用同一张应答表（ask_user 的请求-应答）。
// ============================================================

import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';
import type { PermissionResult } from '../types.js';

// ────────────────────────────────────────────────────────────
// PendingRequestRegistry — 请求-应答关联表
// ────────────────────────────────────────────────────────────

export class PendingRequestRegistry {
  private requests = new Map<string, { resolve: (value: unknown) => void }>();
  private counter = 0;

  /** 生成唯一请求 ID */
  create(): string {
    return `req_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
  }

  /** 注册一个待应答请求（保存 resolver） */
  register<T>(id: string, resolve: (value: T) => void): void {
    this.requests.set(id, { resolve: resolve as (value: unknown) => void });
  }

  /** 应答指定请求。返回是否找到并已应答。 */
  resolve(id: string, value: unknown): boolean {
    const entry = this.requests.get(id);
    if (!entry) return false;
    this.requests.delete(id);
    entry.resolve(value);
    return true;
  }

  /** 是否存在该待应答请求 */
  has(id: string): boolean {
    return this.requests.has(id);
  }

  /** 当前待应答请求数 */
  get size(): number {
    return this.requests.size;
  }

  /** 清空所有待应答请求（连接断开时） */
  clear(): void {
    this.requests.clear();
  }
}

// ────────────────────────────────────────────────────────────
// 权限域选项
// ────────────────────────────────────────────────────────────

export interface PermissionDomainOptions {
  /** 请求-应答关联表（与消息域共享） */
  pending: PendingRequestRegistry;
}

// ────────────────────────────────────────────────────────────
// 权限域工厂
// ────────────────────────────────────────────────────────────

export function createPermissionDomain(options: PermissionDomainOptions): DomainHandler {
  const { pending } = options;

  return {
    // ── permission.resolve ────────────────────────────────
    resolve(params: unknown): { ok: true; id: string; result: PermissionResult } {
      const { id, result } = (params ?? {}) as {
        id?: string;
        result?: PermissionResult;
      };
      if (!id) throw new Error('permission.resolve requires "id"');
      if (!result || !['yes', 'no', 'always', 'aor'].includes(result)) {
        throw new Error(`permission.resolve requires valid "result" (yes|no|always|aor)`);
      }
      const ok = pending.resolve(id, result);
      if (!ok) {
        throw new Error(`permission request "${id}" not found or already resolved`);
      }
      return { ok: true, id, result };
    },
  };
}

/** 事件类型导出（供外部构造 permission.request 广播时引用） */
export { UI_EVENT };
