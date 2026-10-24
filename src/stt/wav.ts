/**
 * WAV 解析 — 把前端上传的 PCM WAV 解成 sherpa-onnx 需要的 Float32Array。
 *
 * 为什么后端只收 WAV：前端录的是 webm/opus，但解码/重采样在浏览器里做
 * （AudioContext.decodeAudioData + 指定 16kHz 采样率）比在 Node 里引解码器干净；
 * 后端收到的永远是"16k 单声道 PCM16 的 WAV"，这里只做格式校验与位深转换。
 *
 * 只认 PCM16（前端 encodeWav 保证）；拒收非 RIFF/非 PCM/多声道（fail-closed）。
 */

export interface PcmWav {
  sampleRate: number;
  samples: Float32Array;
}

export class WavParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavParseError';
  }
}

export function parsePcmWav(buf: Buffer): PcmWav {
  if (buf.length < 44) throw new WavParseError('WAV 数据过短');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavParseError('不是 RIFF/WAVE 文件');
  }

  // 逐 chunk 走（fmt 与 data 的顺序不保证；容忍 LIST 等附加块）
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);   // chunk 按字对齐
  }

  if (!fmt) throw new WavParseError('缺少 fmt 块');
  if (!data) throw new WavParseError('缺少 data 块');
  if (fmt.audioFormat !== 1) throw new WavParseError(`只支持 PCM（audioFormat=${fmt.audioFormat}）`);
  if (fmt.channels !== 1) throw new WavParseError(`只支持单声道（${fmt.channels} 声道）`);
  if (fmt.bitsPerSample !== 16) throw new WavParseError(`只支持 16bit（${fmt.bitsPerSample}bit）`);

  const n = Math.floor(data.length / 2);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { sampleRate: fmt.sampleRate, samples };
}
