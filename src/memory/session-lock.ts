// ============================================================
// session-lock — 跨进程会话目录文件锁
// ============================================================
// 动机：TUI 与 WebUI/serve 是独立进程，但共享 ~/.agent/sessions/ 目录。
// 当两个进程同时物化 / 自动创建同一 session 时，会并发写 meta.json /
// events.jsonl / stats.json（读改写初始化）→ 竞态损坏。
// 本模块提供基于「独占创建 lock 文件」的跨进程互斥：
//   - 原子获取：fs.open(path, 'wx')（EEXIST = 已被占用）
//   - 陈旧回收：lock 内记录 pid + 时间戳；超时或 pid 已退出视为可回收
//   - 只保护「初始化/物化」这类读改写路径；事件追加（O_APPEND 行级原子）无需加锁
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STALE_MS = 120_000; // 锁超时：2 分钟
const DEFAULT_RETRY_MS = 25; // 重试间隔
const DEFAULT_MAX_ATTEMPTS = 200; // 重试上限（约 5s）

export interface SessionDirLockOptions {
  staleMs?: number;
  retryMs?: number;
  maxAttempts?: number;
}

/**
 * 在 sessionDir 上获取跨进程排他锁后执行 fn，结束后释放。
 * 并发获取同一目录时串行化；锁被占用且未陈旧时重试直至超时抛错。
 */
export async function withSessionDirLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
  options: SessionDirLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const lockPath = path.join(sessionDir, '.lock');
  await fs.mkdir(sessionDir, { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fh: fs.FileHandle | null = null;
    try {
      fh = await fs.open(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isStaleLock(lockPath, staleMs)) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (attempt === maxAttempts - 1) {
        throw new Error(`Session directory lock timeout: ${sessionDir}`);
      }
      await sleep(retryMs);
      continue;
    }

    try {
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf-8');
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
    await fh.close();

    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  throw new Error(`Session directory lock timeout: ${sessionDir}`);
}

/** lock 文件陈旧判定：超时 或 记录 pid 已退出 → 可回收 */
async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: number; ts?: number };
    const ts = typeof info.ts === 'number' ? info.ts : 0;
    if (Date.now() - ts > staleMs) return true;
    if (typeof info.pid === 'number') {
      try {
        process.kill(info.pid, 0);
        return false; // 进程存活且未超时 → 活跃锁
      } catch {
        return true; // 进程已退出 → 陈旧
      }
    }
    return false;
  } catch {
    return true; // 无法解析 → 视为陈旧（安全删除重试）
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
