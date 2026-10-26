/**
 * say 播放队列单测：串行 / 保序 / 不丢 / 超时不死锁 / 积压上限。
 *
 * 【为什么这些必须测】这条链的问题是「静默失败」：
 *  · 并发播放 ⇒ 声音糊在一起，但代码不报错
 *  · 队列丢话 ⇒ 少播几句，也不报错
 *  · 超时缺失 ⇒ 一句卡住后**之后所有播报全哑**，依然不报错
 * 三者都只能靠断言挡住，肉眼读代码看不出来。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SayPlaybackQueue,
  wavDurationMs,
  defaultTimeoutMs,
  prependSilence,
  SAY_LEAD_SILENCE_MS,
} from './say-playback-queue.js';

/** 造一个合法的最小 WAV 头（PCM 16bit）—— 只求解析器认，不求能播 */
function makeWav(opts: { sampleRate?: number; channels?: number; bits?: number; seconds?: number } = {}): Buffer {
  const sampleRate = opts.sampleRate ?? 24000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const seconds = opts.seconds ?? 1;
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = Math.round(byteRate * seconds);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

/**
 * 受控播放器：记录开始/结束顺序，由测试手动放行。
 *
 * 标识用 **Buffer 对象本身**（Map 查表），不往 wav 里塞标记 ——
 * 塞标记会破坏 RIFF 头 ⇒ 时长解析归零 ⇒ 每句挂 120s 兜底定时器，
 * 测试看着过、实际留下一堆悬挂定时器，且没验到「保序」这件事。
 */
function controlledPlayer() {
  const labels = new Map<Buffer, string>();
  const started: string[] = [];
  const finished: string[] = [];
  let pendingDone: (() => void) | null = null;
  let current: string | null = null;

  return {
    /** 造一个带标识的 wav（合法头，时长 10ms ⇒ 超时下限 30s，测试结束前都会被 release 清掉） */
    make(label: string): Buffer {
      const wav = makeWav({ seconds: 0.01 });
      labels.set(wav, label);
      return wav;
    },
    play(wav: Buffer, done: () => void): void {
      const tag = labels.get(wav) ?? '????';
      current = tag;
      started.push(tag);
      pendingDone = () => {
        finished.push(tag);
        current = null;
        done();
      };
    },
    started,
    finished,
    get current() { return current; },
    release(): void {
      const d = pendingDone;
      pendingDone = null;
      d?.();
    },
  };
}

describe('wavDurationMs', () => {
  it('24kHz/mono/16bit 的 1 秒音频 → 1000ms', () => {
    expect(wavDurationMs(makeWav({ seconds: 1 }))).toBe(1000);
  });

  it('0.5 秒 → 500ms（不四舍五入到整秒）', () => {
    expect(wavDurationMs(makeWav({ seconds: 0.5 }))).toBe(500);
  });

  it('44.1kHz/立体声/2 秒 → 2000ms（byteRate 换算正确）', () => {
    expect(wavDurationMs(makeWav({ sampleRate: 44100, channels: 2, seconds: 2 }))).toBe(2000);
  });

  it('非 WAV / 头损坏 ⇒ 返回 0（调用方走默认上限，不因解析失败放弃播放）', () => {
    expect(wavDurationMs(Buffer.from('not a wav at all'))).toBe(0);
    expect(wavDurationMs(Buffer.alloc(10))).toBe(0);
    expect(wavDurationMs(Buffer.alloc(0))).toBe(0);
  });
});

describe('defaultTimeoutMs', () => {
  it('短句被夹到下限 30s（不会被误杀）', () => {
    expect(defaultTimeoutMs(makeWav({ seconds: 0.1 }))).toBe(30_000);
  });

  it('长句按时长放大（时长×2+10s），且不超过上限 300s', () => {
    expect(defaultTimeoutMs(makeWav({ seconds: 60 }))).toBe(130_000);
    expect(defaultTimeoutMs(makeWav({ seconds: 200 }))).toBe(300_000);
  });

  it('无法解析时长 ⇒ 默认 120s', () => {
    expect(defaultTimeoutMs(Buffer.from('garbage'))).toBe(120_000);
  });
});

describe('SayPlaybackQueue（串行播放）', () => {
  it('三句连入：一次只播一句，前一句没 done 绝不开始下一句', async () => {
    const p = controlledPlayer();
    const q = new SayPlaybackQueue({ play: p.play });

    q.enqueue(p.make('AAA'));
    q.enqueue(p.make('BBB'));
    q.enqueue(p.make('CCC'));

    expect(p.started).toEqual(['AAA']);        // 只启动了第一句
    expect(q.pendingCount).toBe(2);
    expect(q.isBusy).toBe(true);

    p.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.started).toEqual(['AAA', 'BBB']);

    p.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.started).toEqual(['AAA', 'BBB', 'CCC']);

    p.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(p.finished).toEqual(['AAA', 'BBB', 'CCC']);
    expect(q.isBusy).toBe(false);
    expect(q.pendingCount).toBe(0);
  });

  it('保序：入队顺序 = 播放顺序（不重排、不跳句）', async () => {
    const p = controlledPlayer();
    const q = new SayPlaybackQueue({ play: p.play });
    const order = ['S1', 'S2', 'S3', 'S4', 'S5'];
    for (const t of order) q.enqueue(p.make(t));

    for (let i = 0; i < order.length; i++) {
      await Promise.resolve();
      await Promise.resolve();
      p.release();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(p.finished).toEqual(order);
  });

  it('播放器同步调 done 也不会爆栈（长队列）', async () => {
    let count = 0;
    const q = new SayPlaybackQueue({
      play: (_wav, done) => { count++; done(); },   // 同步完成
    });
    const wav = makeWav({ seconds: 0.01 });
    for (let i = 0; i < 500; i++) q.enqueue(wav);
    for (let i = 0; i < 600; i++) await Promise.resolve();
    expect(count).toBe(500);
    expect(q.isBusy).toBe(false);
  });
});

describe('SayPlaybackQueue（超时兜底：防死锁）', () => {
  it('播放器永不 done ⇒ 超时后强制放行下一句并留痕', async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const labels = new Map<Buffer, string>();
      const q = new SayPlaybackQueue({
        play: (wav, _done) => { started.push(labels.get(wav) ?? '?'); /* 永不 done */ },
        timeoutMs: () => 1000,
        logger: { warn: vi.fn() },
      });
      const a = makeWav({ seconds: 0.01 }); labels.set(a, 'HUNG');
      const b = makeWav({ seconds: 0.01 }); labels.set(b, 'NEXT');

      q.enqueue(a);
      q.enqueue(b);
      expect(started).toEqual(['HUNG']);

      vi.advanceTimersByTime(1000);
      await vi.runOnlyPendingTimersAsync();

      expect(started).toEqual(['HUNG', 'NEXT']);   // 没被永久堵死
    } finally {
      vi.useRealTimers();
    }
  });

  it('超时会打日志（静默失败是这类 bug 最危险之处）', () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const q = new SayPlaybackQueue({
        play: () => { /* 永不 done */ },
        timeoutMs: () => 500,
        logger: { warn },
      });
      q.enqueue(makeWav({ seconds: 0.01 }));
      vi.advanceTimersByTime(500);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('play 抛异常 ⇒ 不卡死，继续下一句并留痕', async () => {
    const warn = vi.fn();
    let n = 0;
    const q = new SayPlaybackQueue({
      play: (_wav, done) => {
        n++;
        if (n === 1) throw new Error('powershell 起不来');
        done();
      },
      logger: { warn },
    });
    q.enqueue(makeWav({ seconds: 0.01 }));
    q.enqueue(makeWav({ seconds: 0.01 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('播放启动失败');
  });
});

describe('SayPlaybackQueue（积压上限）', () => {
  it('超过 maxPending 丢最旧，保留最新，且留痕', () => {
    const warn = vi.fn();
    const p = controlledPlayer();
    const q = new SayPlaybackQueue({ play: p.play, maxPending: 2, logger: { warn } });

    q.enqueue(p.make('PLAY'));   // 立刻开播（占住 busy）
    q.enqueue(p.make('OLD1'));
    q.enqueue(p.make('OLD2'));
    q.enqueue(p.make('NEW3'));   // pending 已满 2 ⇒ 丢 OLD1

    expect(q.pendingCount).toBe(2);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('积压超限');
  });

  it('clear() 清空积压并留痕（正在播的那句不受影响）', () => {
    const warn = vi.fn();
    const p = controlledPlayer();
    const q = new SayPlaybackQueue({ play: p.play, logger: { warn } });
    q.enqueue(p.make('PLAY'));
    q.enqueue(p.make('WAIT'));
    expect(q.pendingCount).toBe(1);

    q.clear();
    expect(q.pendingCount).toBe(0);
    expect(p.current).toBe('PLAY');   // 正在播的没被中断
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * prependSilence —— 设备唤醒余量。
 *
 * 这条的失败模式同样是**静默的**：垫错长度 / 写错长度字段 / 把 PCM 挪歪，
 * 结果要么播放器直接不播（无报错），要么放出来是噪声。肉眼读代码看不出来。
 */
describe('prependSilence（设备唤醒余量）', () => {
  it('时长增加约 300ms，字节数精确等于 byteRate × ms', () => {
    const wav = makeWav({ seconds: 1 });            // 24k/mono/16bit ⇒ byteRate 48000
    const before = wavDurationMs(wav);
    const out = prependSilence(wav, 300);
    const after = wavDurationMs(out);
    expect(out.length - wav.length).toBe(14400);    // 48000 × 0.3
    expect(after - before).toBe(300);
  });

  it('RIFF 与 data 的长度字段被同步改写（否则播放器按旧长度读，尾部被截）', () => {
    const wav = makeWav({ seconds: 1 });
    const out = prependSilence(wav, 300);
    expect(out.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.toString('ascii', 8, 12)).toBe('WAVE');
    expect(out.readUInt32LE(4)).toBe(out.length - 8);   // RIFF size

    let pos = 12;
    let dataOff = -1;
    let dataSize = 0;
    while (pos + 8 <= out.length) {
      const id = out.toString('ascii', pos, pos + 4);
      const size = out.readUInt32LE(pos + 4);
      if (id === 'data') { dataOff = pos + 8; dataSize = size; break; }
      pos += 8 + size + (size % 2);
    }
    expect(dataOff).toBe(44);
    expect(dataSize).toBe(out.length - dataOff);        // data size 覆盖到文件尾
  });

  it('原始 PCM 一个字节都不丢，只是整体后移；插入区真的是静音', () => {
    const wav = makeWav({ seconds: 0.1 });          // dataSize 4800
    for (let i = 0; i < 4800; i++) wav[44 + i] = (i * 37 + 11) & 0xff;  // 填可辨识样本
    const out = prependSilence(wav, 100);           // 100ms ⇒ 4800 B
    expect(out.length).toBe(wav.length + 4800);
    for (let i = 0; i < 4800; i++) {
      expect(out[44 + 4800 + i]).toBe(wav[44 + i]); // PCM 后移后逐字节一致
    }
    for (let i = 0; i < 4800; i++) {
      expect(out[44 + i]).toBe(0);                  // 16bit 有符号 ⇒ 静音是 0
    }
  });

  it('立体声 44.1k：长度按 blockAlign 对齐（不对齐会让样本错位成噪声）', () => {
    const wav = makeWav({ sampleRate: 44100, channels: 2 });
    const out = prependSilence(wav, 300);
    const added = out.length - wav.length;
    expect(added).toBe(44100 * 4 * 0.3);            // 52920
    expect(added % 4).toBe(0);                      // blockAlign = 2ch × 2B
  });

  it('非 WAV / 过短 / ms<=0 一律原样返回（适配失败绝不能阻止整句播放）', () => {
    const junk = Buffer.from('definitely not a wav file');
    expect(prependSilence(junk, 300)).toBe(junk);
    const wav = makeWav({ seconds: 1 });
    expect(prependSilence(wav, 0)).toBe(wav);
    expect(prependSilence(wav, -100)).toBe(wav);
  });

  it('垫过静音后 defaultTimeoutMs 也相应变长（超时不会误杀变长的音频）', () => {
    // 必须用够长的 wav：短音频两者都会被 MIN_TIMEOUT_MS(30s) 夹住 ⇒ 看起来"没变长"，
    // 那是下限在起作用，不是 padding 没生效（写测试时踩过这个坑）。
    const wav = makeWav({ seconds: 30 });
    const out = prependSilence(wav, 300);
    expect(defaultTimeoutMs(wav)).toBe(70_000);   // 30000×2+10000
    expect(defaultTimeoutMs(out)).toBe(70_600);   // (30000+300)×2+10000
  });
});
