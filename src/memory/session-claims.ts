// ============================================================
// session-claims — 进程级会话占用表
// ============================================================
// 一个会话目录同一时刻只允许**一条 UI 连接**驱动（WebUI 多标签页 /
// 桌面端）。两条连接同时挂在一个会话上会：
//   - 各自持有一份 AgentLoop，currentSessionDir 独立漂移；
//   - 同时往 events.jsonl / conversation.jsonl 追加，历史交错；
//   - 前端两侧看到的"当前会话"互相覆盖。
// 因此把"谁在用这个会话"变成显式占用，而不是靠前端祈祷用户别重复打开。
//
// 设计要点：
//   - 纯内存 Map：键 = sessionId，值 = 连接持有者 token（每条连接随机生成）；
//   - **同步 API**：Node 单线程，判定与占用之间不存在 await 窗口 ⇒ 无竞态；
//   - 进程级单例（getSessionClaims），连接关闭时由 UiProtocolSession 释放；
//   - 与 TUI 本地路径无关（TUI 装配时不传 claims，行为零变更）。
// ============================================================

export interface SessionClaimRegistry {
  /** 尝试占用；已被**他人**占用时返回 false（自己重复占用是幂等成功） */
  claim(sessionId: string, owner: string): boolean;
  /** 释放（仅当持有者匹配；不匹配则不动作） */
  release(sessionId: string, owner: string): void;
  /** 当前持有者；无人占用返回 null */
  ownerOf(sessionId: string): string | null;
  /**
   * 原子转移：占用 `to` 并释放 `from`。
   * `to` 被他人占用时返回 false，且**不改变** `from` 的占用（调用方可安全回滚）。
   */
  transfer(from: string | null | undefined, to: string, owner: string): boolean;
  /** 调试 / 诊断快照 */
  snapshot(): Record<string, string>;
}

export function createSessionClaims(): SessionClaimRegistry {
  const claims = new Map<string, string>();
  return {
    claim(sessionId, owner) {
      const holder = claims.get(sessionId);
      if (holder !== undefined && holder !== owner) return false;
      claims.set(sessionId, owner);
      return true;
    },
    release(sessionId, owner) {
      if (claims.get(sessionId) === owner) claims.delete(sessionId);
    },
    ownerOf(sessionId) {
      return claims.get(sessionId) ?? null;
    },
    transfer(from, to, owner) {
      if (from !== to) {
        const holder = claims.get(to);
        if (holder !== undefined && holder !== owner) return false;
      }
      claims.set(to, owner);
      if (from && from !== to && claims.get(from) === owner) claims.delete(from);
      return true;
    },
    snapshot() {
      return Object.fromEntries(claims);
    },
  };
}

const processClaims = createSessionClaims();

/** 进程级占用表（/ui /desktop /tui 远程共用同一实例） */
export function getSessionClaims(): SessionClaimRegistry {
  return processClaims;
}

/** 测试隔离：清空全部占用（生产代码不调用） */
export function resetSessionClaims(): void {
  for (const key of Object.keys(processClaims.snapshot())) {
    const owner = processClaims.ownerOf(key);
    if (owner) processClaims.release(key, owner);
  }
}
