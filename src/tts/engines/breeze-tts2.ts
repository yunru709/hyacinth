/**
 * Breeze-TTS-2 本地引擎（GGUF 量化，audio.cpp 运行时）。
 *
 * 【为什么选这条】
 *   在线 breeze 好用但要额度、要联网；本地 GGUF 离线免费。
 *   实测（2026-10-26，RTX 4070 Laptop 8GB）：q8_0 权重共 ~3.7GB 全在 CUDA0，
 *   显存够用；单次合成 wall≈9s（含模型加载），24kHz mono pcm16 WAV。
 *
 * 【能力：emotion 真支持】
 *   模型 spec 的 request option `instruct` = "BreezeTTS generation instruction"，
 *   spec 里 `capabilities.tts: ["style_control"]`。实测：
 *     基线 2.08s / warm 2.48s(+19%) / excited 2.56s(+23%)，三者内容都 100%，
 *     **不念出指令** —— 这点和 CosyVoice3 的 instruct2 完全不同（那个会念）。
 *
 * 【为什么用 CLI 而不是 audiocpp_server.exe】
 *   包里有 `audiocpp_server.exe`（常驻 HTTP），能省掉每次 ~9s 的模型加载。
 *   但那要额外管一个子进程 + 端口 + 健康检查。先用 CLI 把契约跑通，
 *   优化留到"单次延迟真的碍事"时再做（audiocpp_server 已在包内，切换成本低）。
 *
 * 【三个必须记住的坑】
 *   1. `--language` **不是** breeze_tts 支持的 request option（支持的只有 instruct /
 *      reference_text / text_chunk_size / text_chunk_mode / max_tokens / guidance_scale）。
 *      传了会得到 `unknown BreezeTTS request option: language` 并整单失败。
 *   2. 临时输出**不能放 %TEMP%** —— 火绒会拦新 exe 写 %TEMP%（memory 里的三坑之一）。
 *      默认落到模型同级的 `tts-work/`。
 *   3. **必须串行**：8GB 显存只够一份 3.7GB 权重，并发调用会 OOM。
 *      用模块级 promise 链把调用排队（同 cosyvoice 的 _LOCK 思路）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TtsCapabilities, TtsEngine, TtsVoiceInfo } from '../engine.js';

const execFileAsync = promisify(execFile);

export interface BreezeTts2Config {
  /** audiocpp_cli.exe 的绝对路径 */
  cliPath: string;
  /** GGUF 模型绝对路径 */
  modelPath: string;
  /** 推理后端（默认 cuda） */
  backend?: 'cuda' | 'cpu' | 'vulkan';
  /** 设备序号（默认 0） */
  device?: number;
  /** 默认 instruct（不传 emotion 时用；留空则用模型 spec 默认值） */
  defaultInstruct?: string;
  /** 透传 `--request-option key=value`（max_tokens / guidance_scale 等） */
  requestOptions?: Record<string, string>;
  /** 临时 WAV 目录。**别放 %TEMP%**（火绒） */
  workDir?: string;
  /** 参考音目录：<dir>/<id>.wav 可作为 --voice-ref 供克隆 */
  voicesDir?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/** 串行链：8GB 显存只能容一份权重，并发会 OOM */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  // 吞掉失败以免污染后续排队（调用方仍从 next 拿到自己的错误）
  chain = next.catch(() => undefined);
  return next;
}

/** 按 WAV 头算时长（24k mono pcm16 常见，但不写死：从 fmt chunk 读） */
function wavDuration(buf: Buffer): number {
  if (buf.length < 44 || buf.subarray(0, 4).toString() !== 'RIFF') return 0;
  const audioFormat = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (!sampleRate || !channels || !bits) return 0;
  const dataBytes = buf.length - 44;
  void audioFormat;
  return dataBytes / (sampleRate * channels * (bits / 8));
}

export function createBreezeTts2Engine(getConf: () => BreezeTts2Config): TtsEngine {
  const conf = () => getConf();

  /** 音色目录：内置 + 参考音目录里的 wav */
  function voices(): TtsVoiceInfo[] {
    const c = conf();
    const out: TtsVoiceInfo[] = [{ id: 'default', label: 'BreezeTTS 2（内置音色）' }];
    try {
      if (c.voicesDir && fs.existsSync(c.voicesDir)) {
        for (const f of fs.readdirSync(c.voicesDir)) {
          if (!f.toLowerCase().endsWith('.wav')) continue;
          const id = f.replace(/\.wav$/i, '');
          if (id === 'default') continue;
          out.push({ id, label: `${id}（参考音克隆）` });
        }
      }
    } catch {
      // 目录读不到就当只有内置音色：不能因为音色目录问题让 say 整体不可用
    }
    return out;
  }

  async function synthesize(
    text: string,
    opts: { voice?: string; speed?: number; emotion?: string } = {},
  ): Promise<Buffer> {
    const c = conf();
    if (!c.cliPath || !fs.existsSync(c.cliPath)) {
      throw new Error(`Breeze-TTS-2 未就绪：找不到 audiocpp_cli.exe（${c.cliPath || '未配置'}）`);
    }
    if (!c.modelPath || !fs.existsSync(c.modelPath)) {
      throw new Error(`Breeze-TTS-2 未就绪：找不到 GGUF 模型（${c.modelPath || '未配置'}）`);
    }

    // 临时文件放模型同级目录，**不放 %TEMP%**（火绒拦新 exe 写）
    const workDir = c.workDir || path.join(path.dirname(c.modelPath), 'tts-work');
    fs.mkdirSync(workDir, { recursive: true });
    const outFile = path.join(workDir, `breeze2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

    const args = [
      '--task', 'tts',
      '--family', 'breeze_tts',
      '--model', c.modelPath,
      '--backend', c.backend || 'cuda',
      '--device', String(c.device ?? 0),
      '--text', text,
      '--out', outFile,
    ];

    // emotion → instruct（模型 spec 的 style_control 通道）
    const instruct = opts.emotion || c.defaultInstruct;
    if (instruct) args.push('--instruct', instruct);

    // 参考音克隆：voice 不是 default 且目录里有同名 wav 时带上
    if (opts.voice && opts.voice !== 'default' && c.voicesDir) {
      const ref = path.join(c.voicesDir, `${opts.voice}.wav`);
      if (fs.existsSync(ref)) args.push('--voice-ref', ref);
    }

    for (const [k, v] of Object.entries(c.requestOptions ?? {})) {
      args.push('--request-option', `${k}=${v}`);
    }

    const env = { ...process.env };
    const timeout = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      await serialize(() =>
        execFileAsync(c.cliPath, args, { timeout, maxBuffer: 16 * 1024 * 1024, env }),
      );
      const buf = await fs.promises.readFile(outFile);
      if (buf.length < 64) {
        throw new Error(`Breeze-TTS-2 输出过短（${buf.length} 字节），可能不是有效 WAV`);
      }
      return buf;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
      if (e.killed) throw new Error(`Breeze-TTS-2 合成超时（${timeout}ms）`);
      // CLI 的真错误只在 stderr/stdout 里；包装错误本身没有信息量
      const detail = (e.stderr || e.stdout || e.message || '').toString().trim().slice(-400);
      throw new Error(`Breeze-TTS-2 合成失败：${detail}`);
    } finally {
      // 清洁：临时 WAV 不留在盘上（失败路径也要清）
      fs.promises.unlink(outFile).catch(() => undefined);
    }
  }

  return {
    id: 'breeze-tts-2',
    kind: 'local',
    voices,
    synthesize,
    capabilities: (): TtsCapabilities => ({
      voice: true,
      // speed：audio.cpp 的 breeze_tts spec 没有语速项（要变速得改时长参数或后处理），
      // 如实报 false 而不是假装支持。
      speed: false,
      // instruct = style_control，实测定性与内容都对
      emotion: true,
    }),
    status: () => {
      const c = conf();
      const missing: string[] = [];
      if (!c.cliPath || !fs.existsSync(c.cliPath)) missing.push('audiocpp_cli.exe');
      if (!c.modelPath || !fs.existsSync(c.modelPath)) missing.push('GGUF 模型');
      return {
        ready: missing.length === 0,
        detail:
          missing.length === 0
            ? `本地 BreezeTTS2（${c.backend || 'cuda'}，${path.basename(c.modelPath)}，单次约 9s）`
            : `缺：${missing.join('、')}（${os.platform()} 需先下载 audio.cpp 与 GGUF）`,
      };
    },
  };
}
