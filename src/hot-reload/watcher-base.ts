// ============================================================
// 热重载 — Watcher 统一骨架（P5-7 watcher 收敛）
// ============================================================
// 13 个 watcher 的公共骨架收敛于此。收敛前每个 watcher 各自
// 手写 fs.watch / fs.watchFile + debounce + mtime 去重 + try/catch
// + logger 样板，重复度 >70%（1433 行）；收敛后 watcher 文件只
// 声明 spec（监听路径 + reload 业务回调），骨架统一维护。
//
// 两种监听模式（保留原有各 watcher 的选择，不改变行为）：
//   watch — fs.watch 事件驱动：适合目录递归（prompt/tool/skill）
//           或独立配置文件；.agent 目录下密集写入时误触发多，
//           因此独立配置文件多数走 poll。
//   poll  — fs.watchFile stat 轮询 + mtime 去重：.agent/ 目录
//           文件密集（session、SQLite、scheduler），fs.watch 在
//           Windows 上产生大量无效回调；5s 轮询对极少变更的
//           配置文件开销更低。
// ============================================================

import fs from 'node:fs';
import { createLogger, type Logger } from '../logging/logger.js';
import { pollIntervalMs } from './hot-reload-config.js';

/** 触发上下文：watch 模式带 filename，poll 模式 filename 为 null */
export interface WatchTrigger {
  /** 触发变更的文件名（相对监听目录）；poll 模式为 null */
  filename: string | null;
  /** 触发的监听路径 */
  dir: string;
}

export interface WatcherSpec {
  /** 日志标识（logger 模块名 hot-reload:<name>） */
  name: string;
  /** 监听路径（函数形式：允许延迟解析环境相关路径） */
  paths: () => string[];
  /**
   * 变更回调（业务差异点）。骨架统一提供 try/catch + 日志，
   * 回调内无需再包错误处理。
   */
  reload: (trigger: WatchTrigger) => void | Promise<void>;
  /** 监听模式，默认 'watch' */
  mode?: 'watch' | 'poll';
  /** poll 模式轮询间隔（ms），默认 5000 */
  pollIntervalMs?: number;
  /** watch 模式防抖（ms）；省略则不防抖 */
  debounceMs?: number;
  /** 目录递归监听（fs.watch recursive），默认 false */
  recursive?: boolean;
  /** filename 过滤（在防抖之前判断，省 CPU）；省略则不过滤 */
  filter?: (filename: string) => boolean;
  /**
   * 条件跳过钩子（在防抖之后、reload 之前判断）——
   * 用于竞态保护（如 configCenter.isSaving：跳过自身 save() 触发的变更）。
   */
  shouldSkip?: () => boolean;
}

/** 统一监听句柄：watch/poll 两种模式的关闭方式归一（供 HotReloadManager.stop()） */
export interface WatcherHandle {
  close(): void;
}

/**
 * 按 spec 创建监听器集合。返回的句柄统一可 close()，
 * 由 HotReloadManager.stop() 生命周期管理。
 */
export function createWatcher(spec: WatcherSpec): WatcherHandle[] {
  const logger: Logger = createLogger(`hot-reload:${spec.name}`);
  const mode = spec.mode ?? 'watch';
  return mode === 'poll' ? createPollWatcher(spec, logger) : createEventWatcher(spec, logger);
}

// ── watch 模式：fs.watch 事件驱动 ─────────────────────────────

function createEventWatcher(
  spec: WatcherSpec,
  logger: Logger,
): WatcherHandle[] {
  const watchers: WatcherHandle[] = [];
  // 每个监听路径独立防抖计时器（对齐原 skill-watcher 的 per-dir 行为）
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  for (const dir of spec.paths()) {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(
        dir,
        { persistent: true, recursive: spec.recursive ?? false },
        (_eventType, filename) => {
          if (filename && spec.filter && !spec.filter(filename)) return;
          const debounceMs = spec.debounceMs;
          if (debounceMs === undefined) {
            void runReload(spec, logger, filename, dir);
            return;
          }
          const prev = timers.get(dir);
          if (prev) clearTimeout(prev);
          timers.set(
            dir,
            setTimeout(() => {
              timers.delete(dir);
              void runReload(spec, logger, filename, dir);
            }, debounceMs),
          );
        },
      );
    } catch {
      // 文件/目录不存在或无法监听，静默跳过（对齐原各 watcher 行为）
      continue;
    }
    watcher.on('error', (err) => {
      logger.warn('watcher error', { path: dir, error: err.message });
    });
    watchers.push({ close: () => watcher.close() });
  }

  return watchers;
}

// ── poll 模式：fs.watchFile stat 轮询 + mtime 去重 ────────────

function createPollWatcher(
  spec: WatcherSpec,
  logger: Logger,
): WatcherHandle[] {
  const interval = spec.pollIntervalMs ?? pollIntervalMs();
  const lastMtimes = new Map<string, number>();
  let reloadLock = false; // 异步 reload 防重入（对齐原 mcp-watcher handleLock）

  for (const dir of spec.paths()) {
    try {
      lastMtimes.set(dir, fs.statSync(dir).mtimeMs);
    } catch {
      // 文件不存在：记 0，首次创建时 mtime > 0 会触发
      lastMtimes.set(dir, 0);
    }
  }

  const watchers: WatcherHandle[] = [];
  for (const dir of spec.paths()) {
    fs.watchFile(dir, { interval }, (curr) => {
      const prev = lastMtimes.get(dir) ?? 0;
      if (curr.mtimeMs === prev) return;
      lastMtimes.set(dir, curr.mtimeMs);
      if (reloadLock) return;
      reloadLock = true;
      Promise.resolve()
        .then(async () => {
          if (spec.shouldSkip?.()) {
            logger.debug('reload skipped (shouldSkip)', { path: dir });
            return;
          }
          await spec.reload({ filename: null, dir });
          logger.info('reloaded', { path: dir });
        })
        .catch((err) => {
          logger.warn('reload failed', { path: dir, error: msg(err) });
        })
        .finally(() => {
          reloadLock = false;
        });
    });
    // StatWatcher 无 close()：poll 模式以 unwatchFile 关闭
    watchers.push({ close: () => fs.unwatchFile(dir) });
  }

  return watchers;
}

// ── 公共执行器：shouldSkip → reload，统一错误捕获 ─────────────

async function runReload(
  spec: WatcherSpec,
  logger: Logger,
  filename: string | null,
  dir: string,
): Promise<void> {
  if (spec.shouldSkip?.()) {
    logger.debug('reload skipped (shouldSkip)', { path: dir });
    return;
  }
  try {
    await spec.reload({ filename, dir });
    logger.info('reloaded', { path: dir, filename: filename ?? undefined });
  } catch (err) {
    logger.warn('reload failed', { path: dir, error: msg(err) });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
