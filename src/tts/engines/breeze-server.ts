/**
 * audiocpp_server.exe 生命周期管理 —— breeze-tts-2 的常驻推理进程。
 *
 * 【为什么必须有它】2026-10-26 实测把「9.7 秒」拆开：
 *
 *     audiocpp_cli --metrics
 *       metrics.wall_ms  = 1919      ← 纯合成只占 1.9s
 *       metrics.rtf      = 0.857
 *       整次进程调用     = 9709 ms   ← 其余 8s 全是进程启动 + 模型加载
 *
 * 也就是说 CLI 模式每说一句都要重付 8 秒的加载费。同一模型常驻后单次实测
 * **2.0s**。所以「让服务活着」比任何合成侧优化（streaming 等）都重要。
 *
 * 【为什么单独一个模块而不是塞进适配器】
 *   进程生命周期（spawn / 健康检查 / 认领 / kill）与「怎么合成一句话」是两件事。
 *   塞进 breeze-tts2.ts 会让 synthesize() 里一半代码是进程管理，且无法单独测。
 *
 * 【认领语义，照抄 CosyVoiceService 踩出来的教训】
 *   端口上已经有人在听 ⇒ **认领**它，不 spawn（那是别人的子进程，我们不负责 kill）。
 *   2026-10-25 的显存事故就是「只看自己的 proc 句柄、不看端口」导致重复拉起。
 *
 * 【火绒】生成的 server config JSON 放模型同级目录，**不放 %TEMP%**
 *   （火绒拦新 exe 写临时目录）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('tts-breeze-server');

/** 默认端口。选 8189 是因为 3178 被 cosyvoice 占了，3130/3199 是 webui/桌面。 */
export const BREEZE_SERVER_DEFAULT_PORT = 8189;

/** 启动等健康的最长时间（实测模型加载约 10~14s，给足余量） */
const READY_TIMEOUT_MS = 120_000;

export interface BreezeServerOptions {
  /** audiocpp_server.exe 路径（留空 ⇒ 取 modelPath 同目录 / cliPath 同目录的 audiocpp_server.exe） */
  exePath?: string;
  /** GGUF 模型路径（必填） */
  modelPath: string;
  /** audiocpp_cli.exe 路径，仅用于推导 server exe 位置 */
  cliPath?: string;
  backend?: 'cuda' | 'cpu' | 'vulkan';
  device?: number;
  port?: number;
  /** server config 里给该模型起的 id（请求体的 model 字段要与它一致） */
  modelId?: string;
  /** 生成的 config JSON 落盘目录（默认 = 模型同级） */
  workDir?: string;
}

export interface BreezeServerState {
  running: boolean;
  /** true = 端口上那个实例不是我们 spawn 的（我们不负责 kill） */
  adopted: boolean;
  port: number;
  lastError?: string;
}

let proc: ChildProcess | null = null;
let adopted = false;
let lastError: string | null = null;
let activePort: number = BREEZE_SERVER_DEFAULT_PORT;
/** 串行化并发 ensure：多个 say 同时进来时只允许 spawn 一次 */
let startChain: Promise<unknown> = Promise.resolve();
let exitHookInstalled = false;
/**
 * 代次：每次 stopBreezeServer() 递增。在途的 waitHealthy 靠它判断「我等的那个已被停掉」。
 * 没有它 → stop 把 proc 置 null 后旧判据失效 → 空等 120s → 堵死 startChain 串行队列
 * （2026-10-26 生命周期探针：切走再切回，新引擎 60s 起不来）。
 */
let generation = 0;

export function breezeServerState(): BreezeServerState {
  const own = proc !== null && !proc.killed;
  return { running: own || adopted, adopted: adopted && !own, port: activePort, lastError: lastError ?? undefined };
}

/** TCP 探活（不用 http.get：cosyvoice 那边实测过 http.get 在连接失败时会静默不回调） */
function portOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

/** /health 判据：TCP 通了还不够，要它自己说 ok（模型可能还在加载） */
async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}

function resolveExePath(o: BreezeServerOptions): string {
  if (o.exePath) return o.exePath;
  // server 与 cli 同目录（实测 F:\TTSEngines\audio-cpp 下三个 exe 并排）
  if (o.cliPath) return path.join(path.dirname(o.cliPath), 'audiocpp_server.exe');
  return path.join(path.dirname(o.modelPath), 'audiocpp_server.exe');
}

function writeServerConfig(o: BreezeServerOptions, port: number): string {
  const dir = o.workDir || path.dirname(o.modelPath);
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'breeze-server.json');
  const cfg = {
    host: '127.0.0.1',
    port,
    backend: o.backend || 'cuda',
    device: o.device ?? 0,
    // 实测：缺 id / path 任一键 server 直接退出并报 missing required json key
    models: [{ id: o.modelId || 'breeze-tts-2', family: 'breeze_tts', path: o.modelPath }],
  };
  // 无 BOM：server 用严格 JSON 解析，BOM 会让它报 not an object
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfgPath;
}

/**
 * 等 /health 就绪。
 *
 * ⚠️ `gen`（代次）是必须的：`stopBreezeServer()` 把 proc 置 null 后，旧版这里只判
 * `proc && proc.killed` ⇒ proc 为 null 时条件为假 ⇒ 会**空等到 120s 超时**。
 * 而 `ensureBreezeServer` 用 `startChain` 串行 ⇒ 这个空等会把后续所有 ensure 堵在队列里：
 * 「切走再切回」时，新引擎 60s 都起不来 —— 2026-10-26 生命周期探针抓到的就是这个。
 * 现在只要期间被 stop 过（代次变化），本次等待立即作废，后果只是返回 false（调用方已不关心）。
 */
async function waitHealthy(port: number, deadline: number, gen: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (gen !== generation) return false; // 期间被 stop 过 ⇒ 本次等待作废
    if (await healthy(port)) return true;
    if (!proc || proc.killed) return false; // 进程没了，没必要继续等
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 确保 server 在跑，返回可用的 base URL（`http://127.0.0.1:<port>`）。
 * 已在跑 ⇒ 直接返回；没在跑 ⇒ spawn 并等健康。
 */
export async function ensureBreezeServer(o: BreezeServerOptions): Promise<string> {
  const port = o.port ?? BREEZE_SERVER_DEFAULT_PORT;
  activePort = port;
  const url = `http://127.0.0.1:${port}`;

  // 已经在跑（可能是用户手工起的，也可能是上一次 ensure 起的）⇒ 认领
  if (await healthy(port)) {
    if (!proc) adopted = true;
    lastError = null;
    return url;
  }

  // 并发 ensure 只允许一个真的去 spawn
  const run = async (): Promise<string> => {
    // 本次 ensure 的代次。stop() 会让它失效 ⇒ 下面的等待立刻作废，别空耗到 120s。
    const gen = generation;
    // 排队等待期间别人可能已经拉起来了，再确认一次
    if (await healthy(port)) {
      if (!proc) adopted = true;
      return url;
    }
    if (proc && !proc.killed) {
      // 我们起的那个还在加载，继续等就行
      if (await waitHealthy(port, Date.now() + READY_TIMEOUT_MS, gen)) return url;
      if (gen !== generation) throw new Error('Breeze-TTS-2 启动已被 stop 取消（引擎已切换）');
      throw new Error(`Breeze-TTS-2 server 已在运行但 ${READY_TIMEOUT_MS / 1000}s 内未就绪`);
    }

    // ── 端口占用：别一看到占用就抛错 ──────────────────────────────
    // 切引擎走的是「停旧的 → 起新的」，而 kill 到进程真正退出、端口真正释放之间
    // 有个窗口（实测 ~0.3s，Windows 上更久）。旧版在这里直接抛「端口被占用」，
    // 导致切走再切回来时服务永远起不来 —— 2026-10-26 生命周期探针抓到的就是这个。
    // 现在给 8s 宽限期：期间变健康 ⇒ 认领；期间端口关了 ⇒ 继续往下 spawn。
    if (await portOpen(port)) {
      const grace = Date.now() + 8_000;
      let becameHealthy = false;
      while (Date.now() < grace) {
        if (await healthy(port)) { becameHealthy = true; break; }
        if (!(await portOpen(port))) break; // 端口已释放（旧进程退干净了）
        await new Promise((r) => setTimeout(r, 250));
      }
      if (becameHealthy) {
        if (!proc) adopted = true;
        lastError = null;
        return url;
      }
      if (await portOpen(port)) {
        throw new Error(
          `端口 ${port} 已被占用但不是 Breeze-TTS-2 server（/health 不响应）—— 换 voice.tts.breeze.serverPort 或关掉占用者`,
        );
      }
    }

    const exe = resolveExePath(o);
    if (!fs.existsSync(exe)) {
      throw new Error(`找不到 audiocpp_server.exe：${exe}（应与 audiocpp_cli.exe 同目录）`);
    }
    if (!fs.existsSync(o.modelPath)) {
      throw new Error(`找不到 GGUF 模型：${o.modelPath}`);
    }

    const cfgPath = writeServerConfig(o, port);
    logger.info(`启动 Breeze-TTS-2 常驻服务 :${port}（模型 ${path.basename(o.modelPath)}）`);

    adopted = false;
    lastError = null;
    // windowsHide：别弹控制台窗口。不 detached —— 我们希望它随本进程收尾，
    // 且 exit 钩子负责 kill（Windows 上父进程退出不会自动带走子进程）。
    //
    // ⚠️ 必须留一份 child 引用。旧写法在 exit 回调里无条件 `proc = null`：
    // 切引擎时旧进程的 exit 事件可能**晚于**新进程的 spawn 到达，于是把新句柄
    // 抹掉 —— 状态谎报 running:false，且之后 stopBreezeServer 杀不到它（孤儿吃显存）。
    const child = spawn(exe, ['--config', cfgPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc = child;
    child.stdout?.on('data', (d) => logger.debug(`[breeze-server] ${String(d).trim()}`));
    child.stderr?.on('data', (d) => logger.debug(`[breeze-server] ${String(d).trim()}`));
    child.on('exit', (code) => {
      logger.warn(`Breeze-TTS-2 server 退出（code=${code}）`);
      // 只清「还是这个 child」时的 proc（见上面的教训）
      if (proc === child) {
        proc = null;
        adopted = false;
      }
    });
    child.on('error', (err) => {
      lastError = err.message;
      logger.warn('Breeze-TTS-2 server 启动失败', { error: err.message });
    });

    if (!exitHookInstalled) {
      exitHookInstalled = true;
      // 尽力而为：正常退出时带走子进程。被强杀时这条不会跑 —— 那种情况下
      // 残留的 server 下次会被"认领"逻辑接住，不会重复拉起。
      process.once('exit', () => {
        try {
          proc?.kill();
        } catch {
          /* ignore */
        }
      });
    }

    if (await waitHealthy(port, Date.now() + READY_TIMEOUT_MS, gen)) {
      logger.info(`Breeze-TTS-2 常驻服务就绪 :${port}`);
      return url;
    }
    if (gen !== generation) throw new Error('Breeze-TTS-2 启动已被 stop 取消（引擎已切换）');
    const detail = lastError ? `：${lastError}` : '';
    throw new Error(
      `Breeze-TTS-2 server ${READY_TIMEOUT_MS / 1000}s 内未就绪${detail}（详见 ~/.agent 日志）`,
    );
  };

  const next = startChain.then(run, run);
  // 吞掉失败以免污染后续排队（调用方仍从 next 拿到自己的错误）
  startChain = next.catch(() => undefined);
  return next;
}

/** 停掉**我们自己起的**服务（认领来的不碰） */
export function stopBreezeServer(): void {
  // ⚠️ 必须先递增代次再 kill：在途的 waitHealthy 靠它判断「我等的那次已被取消」。
  // 否则 proc 置 null 后旧判据失效 ⇒ 空等 120s ⇒ 堵死 startChain（切回不来）。
  generation++;
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    proc = null;
  }
  adopted = false;
}
