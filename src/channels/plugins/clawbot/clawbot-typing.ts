// ============================================================
// ClawbotTypingController — 微信「正在输入」状态控制器
// ============================================================
//
// 用途：在 Agent 处理用户消息期间，持续向微信发送「正在输入」状态。
//
// 为什么必须续期：微信的 typing 状态有寿命（实测约 5 秒），只发一次几秒后
// 就会自行消失；而 Agent 跑一轮 loop 常需几十秒 —— 必须周期性重发。
// 这正是「其他 Agent 看起来一直在输入」的真实原因（不是黑魔法）。
//
// 对照官方实现（@tencent-weixin/openclaw-weixin 2.4.8，见桌面交接文档）：
//   - keepalive 间隔 5s（官方 process-message.ts 同值）
//   - TTL 硬上限：防止 Agent 卡死导致「正在输入」永久挂住
//   - 失败兜底：所有网络调用 fire-and-forget，绝不阻断消息主流程
//   - in-flight 抑制：上一次请求未返回时跳过本次 tick，防并发风暴
//
// 与官方架构的差异（有意为之）：
//   官方基于 dispatcher 驱动、per-user 多账号缓存（Map）；
//   我方 clawbot 是**单会话**渠道，且消息队列 per-session 串行 ——
//   同一时刻只有一个 typing 状态，故简化为实例级单布尔，无需 Map。
//   **不移植官方的 dispatcher 抽象**（那属于过度工程）。
// ============================================================

/** typing 状态值（对齐官方 TypingStatus） */
export const TYPING_STATUS = {
  /** 开始输入 */
  TYPING: 1,
  /** 取消输入 */
  CANCEL: 2,
} as const;

export interface TypingControllerOptions {
  /** 发送一次 typing 状态；status 见 TYPING_STATUS */
  send: (status: number) => Promise<void>;
  /** 续期间隔（毫秒），默认 5000 */
  keepaliveIntervalMs?: number;
  /** 硬上限（毫秒），默认 120000 */
  maxDurationMs?: number;
  /** 日志出口（失败不抛出，仅记录） */
  log?: (msg: string) => void;
}

const DEFAULT_KEEPALIVE_MS = 5000;
const DEFAULT_MAX_DURATION_MS = 120_000;

export class ClawbotTypingController {
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private inFlight = false;

  constructor(private readonly opts: TypingControllerOptions) {}

  /**
   * 开始 typing 状态。幂等：已在运行时直接返回（避免叠加定时器）。
   * 立即首发一次，随后按 keepalive 间隔续期。
   */
  start(): void {
    if (this.active) return;
    this.active = true;

    this.fire(TYPING_STATUS.TYPING);

    const interval = this.opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    if (interval > 0) {
      this.keepaliveTimer = setInterval(() => this.fire(TYPING_STATUS.TYPING), interval);
      this.keepaliveTimer.unref?.();
    }

    // TTL 安全阀：Agent 卡死不返回时，也不能让「正在输入」永久挂住
    const ttl = this.opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    if (ttl > 0) {
      this.ttlTimer = setTimeout(() => {
        this.opts.log?.(`[typing] TTL exceeded (${ttl}ms), auto-stopping`);
        this.stop();
      }, ttl);
      this.ttlTimer.unref?.();
    }
  }

  /** 停止 typing 状态。幂等：未运行时直接返回。调用方应放在 finally 中。 */
  stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }

    // 取消是「收尾动作」，优先级高于 in-flight 抑制，必须放行
    this.fire(TYPING_STATUS.CANCEL, true);
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * 发送一次状态。fire-and-forget：失败只记日志，绝不抛出。
   *
   * @param force 跳过 in-flight 抑制（仅用于 CANCEL，保证收尾送达）
   */
  private fire(status: number, force = false): void {
    if (this.inFlight && !force) return;

    this.inFlight = true;
    void this.opts
      .send(status)
      .catch((err) => {
        this.opts.log?.(`[typing] send failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.inFlight = false;
      });
  }
}
