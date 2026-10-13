/**
 * stall-detector.ts —— 主线程卡死探测器（2026-10-13，孑遗指派）
 *
 * ## 为什么要有这个文件
 *
 * 孑遗报告：进程**偶发卡死**（界面发白 = Windows 判定该窗口「未响应」，即消息泵停摆），
 * 只能手动强杀重启；频率「偶尔」，记不清上次是什么时候。
 *
 * 排查了 **8 个候选，全部有证据排除**（这份清单就是本模块存在的原因，别删）：
 *   ① provider 请求超时   —— `Request timed out` 全历史 35 次，最后一次 16:58，卡死时(18:17+)没有
 *   ② prompt-watcher      —— 读源码：只 `clearPromptCache()`，不触发装配
 *   ③ MCP 进程泄漏        —— 实测只有一套 npx 链，切换时旧套被正常清理
 *   ④ install-manager     —— 4 处 `execSync`，但只在 `packageType` 配置下走；本机是 npx 型 ⇒ 不经过
 *   ⑤ orphan-sweeper      —— 用 `promisify(exec)`，异步
 *   ⑥ env-collector       —— `execSync('nvidia-smi')` 曾是主嫌，**实测当场否证**：46ms（P8 省电态也一样）
 *   ⑦ clawbot poll        —— 有 3 秒退避 + 请求超时，全异步
 *   ⑧ tui.log 写盘        —— `fs.createWriteStream`，异步流
 *
 * **结论不是"没找到"，而是"现场没留下"**：主线程卡死的证据只存在于那一刻的内存里，
 * 用户一强杀（TerminateProcess），进程没有任何机会写下诊断。⇒ 继续猜第九个候选是白费力气，
 * **必须先让进程自己在卡死时留下证据**。这就是本模块。
 *
 * ## 原理（以及为什么非这么写不可）
 *
 *   - 主线程每 `heartbeatMs`（默认 250ms）把 `Date.now()` 写进 **SharedArrayBuffer**
 *   - **独立 worker 线程**每 `pollMs`（默认 1000ms）读一次：超过 `stallMs`（默认 5000ms）
 *     没更新 ⇒ 判定主线程卡死
 *   - 卡死时 ⇒ `process.report.writeReport()` 落盘
 *     （Node 内置，报告含**该进程所有 JS 线程的调用栈**、libuv 句柄、资源占用 —— 这正是我们要的"现场"）
 *
 * ### ① 为什么必须是 worker，不能主线程自己 setInterval？
 *   主线程一旦卡死，**它自己的定时器同样不会跑** —— 自己检测自己是不可能的。
 *
 * ### ② 为什么必须 SharedArrayBuffer + Atomics，不能用 postMessage / 普通对象？
 *   主线程被彻底冻住时，**连 `postMessage` 都发不出去**，普通对象更是读不到最新值。
 *   SAB 是**共享内存**：worker 直接读主线程写过的那个槽 —— 主线程冻住后，最后一次心跳值依然可读。
 *   这正是"检测卡死"的前提 ✓
 *
 * ### ③ 为什么心跳存 BigInt64Array 而不是 Int32Array？
 *   `Atomics` 只支持 `Int32Array` / `BigInt64Array`。而 `Date.now()` ≈ 1.76e12，
 *   **超出 Int32 范围**（2^31-1 ≈ 2.1e9）⇒ 必须用 BigInt64Array（64 位）。
 *   存绝对值而非"递增计数器"的好处：worker 能直接算出**卡了多久**（`now - heartbeat`）。
 *
 * ### ④ 为什么不覆盖 TUI 的 stdout/stderr 或做别的侵入？
 *   本模块**只读**共享内存 + 只在卡死时写一个文件。平时零文件 IO、零网络、零日志。
 *   worker `unref()` ⇒ **不会阻止进程退出**（用户 Ctrl+C / 正常退出都不受影响）。
 *
 * ### ⑤ 与 `lifecycle/watchdog.ts` 的区别（别搞混）
 *   - `watchdog.ts`：**父进程死了**之后，替它杀掉**子进程树**（防孤儿）
 *   - 本模块：**进程自己还活着但主线程冻住**时，留下诊断（防"死得不明不白"）
 *   两者互补，互不依赖。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('lifecycle:stall-detector');

/** 共享内存布局（BigInt64Array 索引） */
const SLOT_HEARTBEAT = 0;

export interface StallDetectorOptions {
  /** 主线程心跳写入间隔（ms）。默认 250 —— 足够细，又不至于自身成为负担 */
  heartbeatMs?: number;
  /** worker 检查间隔（ms）。默认 1000 */
  pollMs?: number;
  /** 超过这么久没心跳即判定卡死（ms）。默认 5000 —— 与 Windows「未响应」的观感阈值一致 */
  stallMs?: number;
  /** 每次卡死都要写一份新报告（默认 true）。false = 每次卡死周期只写第一份 */
  reportEveryStall?: boolean;
  /** 诊断报告输出目录。默认 `~/.agent/crash` */
  reportDir?: string;
  /**
   * 卡死超过这么久后**强制退出**进程（ms）。**默认 undefined = 不退出**（只留证据）。
   *
   * ⚠️ 为什么默认关闭：自动退出会**丢掉用户当前上下文**（未落盘的对话/工具结果），
   * 而孑遗的原话是"我结束进程后重新启动"——他已有手动恢复的路径。
   * 若将来确认"卡死后自愈优于手杀"，再把这里打开即可（本模块已实现该分支）。
   */
  hardExitAfterMs?: number;
}

export interface StallDetectorHandle {
  /** 停止探测器：清心跳定时器 + terminate worker（幂等） */
  stop(): void;
  /** 供测试/诊断：当前心跳值（主线程视角） */
  getHeartbeat(): number;
  /** 供测试：worker 是否已就绪 */
  isReady(): boolean;
  /** 供测试：已写出的报告路径 */
  getReports(): string[];
}

/** worker 侧脚本（内联，避免多一个文件依赖构建产物路径 —— 与 lifecycle/watchdog.ts 同风格） */
function buildWorkerScript(): string {
  return `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { sab, heartbeatMs, pollMs, stallMs, reportDir, reportEveryStall, hardExitAfterMs } = workerData;
const view = new BigInt64Array(sab);
const SLOT = ${SLOT_HEARTBEAT};

let lastSeen = 0n;
let stalledSince = 0;
let reportedThisStall = false;
let hardExitArmed = false;

function writeReport(stalledForMs) {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(reportDir, 'stall-' + ts + '.json');
    // process.report 是**进程级**的：在 worker 里调用同样能拿到**所有线程**的栈 —— 这正是需求
    // （主线程被冻住时，只有别的线程还能替它留证据）。
    // 注意：writeReport 本身是同步的，会阻塞**调用它的这个 worker 线程**，不影响主线程 ✓
    process.report.writeReport(file, { compact: false });
    parentPort.postMessage({ type: 'report', file, stalledForMs });
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
}

parentPort.postMessage({ type: 'ready' });

setInterval(() => {
  const hb = Atomics.load(view, SLOT);
  const now = BigInt(Date.now());

  if (hb === lastSeen) {
    // 心跳没动 —— 可能是主线程卡住，也可能只是它这一拍还没轮到（心跳间隔 < 检查间隔时正常）
    if (hb !== 0n) {
      const stalledFor = Number(now - hb);
      if (stalledFor >= stallMs) {
        if (!reportedThisStall || reportEveryStall) {
          // reportEveryStall=false 时，每次卡死周期只写第一份
          if (!reportedThisStall) writeReport(stalledFor);
        }
        if (!reportedThisStall) {
          reportedThisStall = true;
          stalledSince = Date.now();
        }
        // 可选自愈：卡死持续超过 hardExitAfterMs ⇒ 退出，交给外部/用户重启
        if (hardExitAfterMs && !hardExitArmed && stalledSince && (Date.now() - stalledSince) >= hardExitAfterMs) {
          hardExitArmed = true;
          parentPort.postMessage({ type: 'hard-exit', stalledForMs: stalledFor });
          process.exit(99);
        }
      }
    }
  } else {
    // 心跳恢复/正常推进
    if (reportedThisStall) {
      parentPort.postMessage({ type: 'recovered', stalledForMs: Number(now - hb) });
    }
    lastSeen = hb;
    reportedThisStall = false;
    stalledSince = 0;
    hardExitArmed = false;
  }
}, pollMs);
`;
}

/**
 * 启动探测器。**幂等**：重复调用返回同一个 handle（避免重启链路里挂多个 worker）。
 *
 * 失败**绝不影响主流程**：worker 起不来（权限/环境异常）只记一条 warn 并返回一个空 handle
 * —— 诊断模块没有资格拖垮主程序。
 */
let activeHandle: StallDetectorHandle | null = null;

export function startStallDetector(opts: StallDetectorOptions = {}): StallDetectorHandle {
  if (activeHandle) return activeHandle;

  const heartbeatMs = opts.heartbeatMs ?? 250;
  const pollMs = opts.pollMs ?? 1000;
  const stallMs = opts.stallMs ?? 5000;
  const reportDir = opts.reportDir ?? path.join(os.homedir(), '.agent', 'crash');
  const reportEveryStall = opts.reportEveryStall ?? true;
  const hardExitAfterMs = opts.hardExitAfterMs;

  // 8 字节对齐的共享内存（BigInt64Array 需要一个槽）
  const sab = new SharedArrayBuffer(8);
  const view = new BigInt64Array(sab);

  // 先写一次心跳，避免 worker 刚起时把"从未写过"误判成卡死
  Atomics.store(view, SLOT_HEARTBEAT, BigInt(Date.now()));

  const reports: string[] = [];
  const heartbeatTimer = setInterval(() => {
    Atomics.store(view, SLOT_HEARTBEAT, BigInt(Date.now()));
  }, heartbeatMs);
  // 心跳定时器不该阻止进程退出（它只是诊断）
  heartbeatTimer.unref?.();

  let worker: Worker | null = null;
  let ready = false;

  try {
    worker = new Worker(buildWorkerScript(), {
      eval: true,
      workerData: { sab, heartbeatMs, pollMs, stallMs, reportDir, reportEveryStall, hardExitAfterMs },
    });
    worker.on('message', (m: { type: string; file?: string; message?: string; stalledForMs?: number }) => {
      if (m.type === 'ready') {
        ready = true;
        logger.info('stall detector armed', { heartbeatMs, pollMs, stallMs, reportDir });
      } else if (m.type === 'report') {
        if (m.file) reports.push(m.file);
        logger.warn('MAIN THREAD STALL DETECTED — report written', {
          file: m.file,
          stalledForMs: m.stalledForMs,
        });
      } else if (m.type === 'recovered') {
        logger.warn('main thread recovered', { stalledForMs: m.stalledForMs });
      } else if (m.type === 'hard-exit') {
        // ⚠️ `logger.error` 的签名是 (msg, error?: Error, context?) —— **第二个参数是 Error 而不是 ctx**，
        // 直接把 { stalledForMs } 当第二个参数传会 TS2353（本模块实测踩过）。
        // 数值类上下文一律走**第三个**参数。（`logger.warn/info/debug` 才是 (msg, ctx) —— 别记混。）
        logger.error('main thread stalled beyond hardExitAfterMs — exiting', undefined, {
          stalledForMs: m.stalledForMs,
        });
      } else if (m.type === 'error') {
        logger.warn('stall detector worker error', { message: m.message });
      }
    });
    // ⚠️ worker 的 'error' 事件回调参数类型是 `unknown`（并非 Error）⇒ 必须自己收窄，
    // 否则 `err.message` 报 TS18046（本模块实测踩过）。
    worker.on('error', (err: unknown) => {
      logger.warn('stall detector worker crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // ⚠️ 必须 unref：否则这个诊断 worker 会**阻止进程正常退出**（Ctrl+C 也退不掉）
    worker.unref();
  } catch (err) {
    logger.warn('stall detector failed to start (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    clearInterval(heartbeatTimer);
    return { stop: () => {}, getHeartbeat: () => 0, isReady: () => false, getReports: () => [] };
  }

  activeHandle = {
    stop: () => {
      clearInterval(heartbeatTimer);
      void worker?.terminate();
      activeHandle = null;
    },
    getHeartbeat: () => Number(Atomics.load(view, SLOT_HEARTBEAT)),
    isReady: () => ready,
    getReports: () => [...reports],
  };
  return activeHandle;
}

/** 供测试/关闭路径调用（幂等） */
export function stopStallDetector(): void {
  activeHandle?.stop();
}

/** 供测试：重置单例（**仅测试用**，生产路径不需要） */
export function __resetStallDetectorForTest(): void {
  activeHandle?.stop();
  activeHandle = null;
}

/** 诊断报告默认目录（供 UI/诊断命令展示） */
export function stallReportDir(): string {
  return path.join(os.homedir(), '.agent', 'crash');
}

/** 确保报告目录存在（启动时调一次，省得卡死那一刻才 mkdir —— 那时主线程正冻着） */
export function ensureStallReportDir(): void {
  try {
    const dir = stallReportDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建目录失败不影响主流程；report 侧还会再试一次 */
  }
}
