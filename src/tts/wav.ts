/**
 * WAV 适配工具 —— 目前只有「垫前导静音」一件事。
 *
 * 【为什么住在 tts 层】（2026-11-01 迁出，原址 gateway/say-playback-queue.ts）
 *   垫静音必须对**所有播放端**生效，而不是只在某一个播放器里。实际情况是：
 *     · TUI：每句**新起一个 powershell** 做 SoundPlayer.PlaySync，音频设备从空闲
 *       被打开到真正出声要几十~几百毫秒，这段唤醒期送进去的音频被直接吞掉
 *       ⇒ 每句开头都缺一点（2026-10-26 孑遗实听，已在此日修复）。
 *     · webui：`<audio>` 复用常驻音频栈，只在设备休眠/被独占后唤醒时偶发吞开头
 *       ⇒ 表现为「有时候听不到第一个字」。当时修复只落在 TUI 的播放队列里，
 *       webui 的 handleSayVoice 一行没沾（2026-11-01 孑遗再次实听复现）。
 *   ⇒ 修在「合成出口」（say-voice-plugin 投递事件前）一次垫好，播放端无需知情，
 *     将来再加任何播放端都自动受益。
 *
 * 【为什么用「垫静音」而不是「预热播放器」】
 *   静音本身就是合法音频数据，播放器无法丢弃它；设备在放这段静音的时间里完成
 *   唤醒，真正的第一个字紧随其后，必然被完整播出。比先播一个 dummy 文件更简单，
 *   也不依赖具体播放器的缓冲行为。
 */

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
 * 波形取证（2026-10-26，证明合成端清白再动播放端）：
 *   · 抓下来的真实 wav：开头 0-190ms 的 RMS ≈ 0.019，是全文件 p90 水平，
 *     比文件中位数（0.0080）还响 **2 倍**，且 10ms 处就已达到正常能量一半
 *     ⇒ 第一个字在文件里、音量正常，合成端没有问题。
 *   · A/B 对照（同一份文件）：直接播听不到 → 前垫 300ms 静音后完整听到。
 *   ⇒ 结论：是播放端冷启动吃掉了开头，不是 TTS 少生成了字。
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
