/**
 * say 播报的**播放**队列 —— 串行，一句播完再起下一句。
 *
 * 【为什么需要】（2026-10-26 孑遗实听反馈：「同时播放好多个话，一句话没说完，
 * 另一句就开始了」）
 *
 * 原实现收到 `tts.say_voice` 事件就**立刻 spawn 一个 powershell** 做
 * `SoundPlayer.PlaySync()`，彼此之间没有任何等待。模型在一轮里连发多个 `say`
 * 时（我实测一口气发过 7 个）⇒ 7 个 powershell 进程**并发发声**，声音糊成一片。
 *
 * 合成侧（say-voice-plugin 的 drain）本来就是串行的，所以问题**纯粹在播放侧**：
 * 合成完一句 notify 一次，播放端来一次起一个进程，谁也不等谁。
 *
 * 【为什么必须有超时兜底】
 * 串行队列的经典死法：`PlaySync()` 若因音频设备被独占 / 驱动异常 / wav 损坏而
 * **永不返回**，队列就永久堵死 —— 之后所有播报全哑，而且**不会有任何报错**
 * （外部只看到「没声音」）。⇒ 每句都有硬上限，到点强制放行下一句并留痕。
 *
 * 上限按 **wav 头里的真实时长 × 2 + 10s** 推算，不是拍脑袋的固定值：
 * 短句不会被误杀；长句（say 正文上限 800 字，中文约 2-3 分钟）也不会被截断。
 *
 * 【积压上限】
 * 保留全部句子（聊天场景丢话是 bug），但积压超过 `maxPending` 时丢**最旧**的
 * 一句并留痕 —— 宁可少播一句陈年旧话，也不要让音频滞后几分钟。
 */

/** 从 WAV 头解析播放时长（毫秒）。解析失败返回 0（调用方走默认上限）。 */
export function wavDurationMs(wav: Buffer): number {
  try {
    if (wav.length < 44) return 0;
    if (wav.toString('ascii', 0, 4) !== 'RIFF') return 0;
    if (wav.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let pos = 12;
    let byteRate = 0;
    let dataSize = 0;
    // 遍历 chunk：fmt 拿 byteRate（offset 16 = 采样率*块对齐），data 拿长度
    while (pos + 8 <= wav.length) {
      const id = wav.toString('ascii', pos, pos + 4);
      const size = wav.readUInt32LE(pos + 4);
      if (id === 'fmt ' && pos + 8 + 16 <= wav.length) {
        byteRate = wav.readUInt32LE(pos + 16);
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      // chunk 之间按偶数对齐
      pos += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0; // 头损坏 ⇒ 交给默认上限，绝不因解析失败而放弃播放
  }
}

/**
 * 每次播放前在 PCM 头部垫的静音时长（毫秒）—— **设备唤醒余量**。
 *
 * 300ms 是实测值，不是猜的：孑遗反馈「听不到第一个字」，同一份 wav 直接播会吞掉
 * 开头的「一」，前面垫 300ms 静音再播就完整听到了。
 */
export const SAY_LEAD_SILENCE_MS = 300;

/**
 * 在 WAV 的 PCM 数据前插入静音。
 *
 * 【为什么需要】（2026-10-26 孑遗实听反馈：「我这里似乎听不到第一个字」）
 * 每次 say 都**新起一个 powershell 进程**做 `SoundPlayer.PlaySync()`。Windows 音频
 * 设备从空闲状态被打开、到真正出声需要几十~几百毫秒，这段唤醒期里送进去的音频被
 * 直接吞掉 ⇒ 每句的开头都会丢一点，也就是"第一个字听不见"。
 *
 * 【怎么定位到播放侧的】（先证明合成端清白，再动播放端）
 *   · 波形分析抓下来的真实 wav：开头 0-190ms 的 RMS ≈ 0.019，是全文件 p90 水平，
 *     比文件中位数（0.0080）还响 **2 倍**，且 10ms 处就已达到正常能量一半
 *     ⇒ 第一个字在文件里、音量正常，合成端没有问题。
 *   · A/B 对照（同一份文件）：直接播听不到 → 前垫 300ms 静音后完整听到。
 *   ⇒ 结论：是播放端冷启动吃掉了开头，不是 TTS 少生成了字。
 *
 * 【为什么用「垫静音」而不是「预热播放器」】
 * 静音本身就是合法的音频数据，播放器无法丢弃它；设备在放这 300ms 的时间里完成
 * 唤醒，真正的第一个字紧随其后，必然被完整播出。比在 powershell 里先播一个
 * dummy 文件更简单，也不依赖播放器的缓冲行为。
 *
 * 【安全性】非 RIFF/WAVE、找不到 fmt/data、或 ms<=0 时**原样返回** ——
 * 这是音频适配层，绝不能因为"垫静音失败"而让一句播报整个不播。
 */
export function prependSilence(wav: Buffer, ms: number): Buffer {
  if (ms <= 0) return wav;
  try {
    if (wav.length < 44) return wav;
    if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav;
    if (wav.toString('ascii', 8, 12) !== 'WAVE') return wav;

    let pos = 12;
    let byteRate = 0;
    let blockAlign = 0;
    let bitsPerSample = 16;
    let dataOff = -1;
    let dataSize = 0;
    while (pos + 8 <= wav.length) {
      const id = wav.toString('ascii', pos, pos + 4);
      const size = wav.readUInt32LE(pos + 4);
      if (id === 'fmt ' && pos + 8 + 16 <= wav.length) {
        bitsPerSample = wav.readUInt16LE(pos + 22);
        blockAlign = wav.readUInt16LE(pos + 20);
        byteRate = wav.readUInt32LE(pos + 16);
      } else if (id === 'data') {
        dataOff = pos + 8;
        dataSize = size;
        break;
      }
      pos += 8 + size + (size % 2);
    }
    if (dataOff < 0 || byteRate <= 0) return wav;

    // 按块对齐（blockAlign = 声道数 × 每样本字节数），否则后半段样本会错位成噪声
    const align = blockAlign > 1 ? blockAlign : 2;
    const silenceLen = Math.floor(Math.round((byteRate * ms) / 1000) / align) * align;
    if (silenceLen <= 0) return wav;

    // dataSize 可能大于文件真实剩余长度（截断/流式写了一半）⇒ 以真实长度为准
    const realDataLen = Math.max(0, Math.min(dataSize, wav.length - dataOff));
    // 8-bit PCM 是无符号，静音值是 0x80；16/24/32-bit 是有符号，静音值是 0
    const out = Buffer.alloc(wav.length + silenceLen, bitsPerSample === 8 ? 0x80 : 0);
    wav.copy(out, 0, 0, dataOff); // 头部原样（含 "data" 与 size 占位）
    wav.copy(out, dataOff + silenceLen, dataOff, dataOff + realDataLen); // 原 PCM 后移
    // data 之后可能还有别的 chunk（LIST/ID3 等），原样搬到新末尾
    const tailStart = dataOff + realDataLen;
    if (tailStart < wav.length) {
      wav.copy(out, dataOff + silenceLen + realDataLen, tailStart, wav.length);
    }
    out.writeUInt32LE(realDataLen + silenceLen, dataOff - 4); // data chunk 长度
    out.writeUInt32LE(out.length - 8, 4); // RIFF 总长度（不含前 8 字节）
    return out;
  } catch {
    return wav; // 适配失败也必须能播，绝不因此放弃整句
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

/** 单句播放的硬上限：真实时长 × 2 + 10s，夹在 [30s, 300s] */
export function defaultTimeoutMs(wav: Buffer): number {
  const dur = wavDurationMs(wav);
  if (dur <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, dur * 2 + 10_000));
}

export interface SayPlaybackLogger {
  warn(msg: string, ctx?: unknown): void;
}

export interface SayPlaybackQueueDeps {
  /**
   * 真正播放一个 wav。播完（或失败）时**必须**调用 done。
   * 允许同步调用（内部已处理），也允许异步。
   */
  play: (wav: Buffer, done: () => void) => void;
  /** 单句超时（毫秒）。缺省见 defaultTimeoutMs。 */
  timeoutMs?: (wav: Buffer) => number;
  /** 最多积压多少句（不含正在播的）。缺省 20。 */
  maxPending?: number;
  logger?: SayPlaybackLogger;
}

export class SayPlaybackQueue {
  private readonly pending: Buffer[] = [];
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SayPlaybackQueueDeps) {}

  /** 当前积压句数（不含正在播的那句；诊断与测试用） */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 是否正在播（诊断与测试用） */
  get isBusy(): boolean {
    return this.busy;
  }

  /** 入队并立即返回 —— 调用方（TUI 事件分发）绝不能被播放阻塞 */
  enqueue(wav: Buffer): void {
    const max = this.deps.maxPending ?? 20;
    if (this.pending.length >= max) {
      this.pending.shift(); // 丢最旧：宁可少播一句旧话，也不让音频滞后
      this.deps.logger?.warn('say-playback: 积压超限，丢弃最早一句', { max });
    }
    this.pending.push(wav);
    if (!this.busy) this.pump();
  }

  /** 清空积压（退出时调用；正在播的那句不受影响，由它自己超时/结束） */
  clear(): void {
    const n = this.pending.length;
    this.pending.length = 0;
    if (n > 0) this.deps.logger?.warn('say-playback: 已清空积压', { dropped: n });
  }

  private pump(): void {
    if (this.busy) return;
    const wav = this.pending.shift();
    if (!wav) {
      this.busy = false;
      return;
    }
    this.busy = true;
    this.playOne(wav);
  }

  private playOne(wav: Buffer): void {
    let finished = false;
    const finish = (warnMsg?: string): void => {
      // 幂等：播放器回调与超时定时器会竞争，只认第一次
      if (finished) return;
      finished = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (warnMsg) this.deps.logger?.warn(warnMsg, { timeoutMs: this.deps.timeoutMs?.(wav) ?? defaultTimeoutMs(wav) });
      this.busy = false;
      // 用微任务切换，避免「play 同步调 done」时在长队列上累积递归深度
      queueMicrotask(() => this.pump());
    };

    const ms = this.deps.timeoutMs?.(wav) ?? defaultTimeoutMs(wav);
    this.timer = setTimeout(() => finish('say-playback: 单句播放超时，强制放行下一句'), ms);

    try {
      this.deps.play(wav, () => finish());
    } catch (err) {
      finish(`say-playback: 播放启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
