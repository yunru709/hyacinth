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
// 音色目录的**单一真源**（<models.root>/voices，wav+txt 成对才算数）。
// 不要在这里自己 readdir 一套：cosyvoice 已经在用 voice-dir，两套实现迟早分叉。
import { listVoiceEntries, voicesDir as defaultVoicesDir } from '../voice-dir.js';
// 常驻 server 生命周期（起进程 / 健康检查 / 认领已有实例）。
// CLI 每句重付 8s 模型加载费（实测整次 9.7s，而 --metrics 说纯合成只 1.9s），
// 常驻后单次 2.0s —— 这是当前唯一有意义的提速来源。
import { ensureBreezeServer, stopBreezeServer } from './breeze-server.js';
import { createLogger } from '../../logging/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('tts-breeze2');

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
  /**
   * 常驻 server 地址（如 `http://127.0.0.1:8189`）。**空 = 走 CLI**。
   *
   * 【为什么需要它】2026-10-26 实测：CLI 单次 9.7s，但 `--metrics` 报
   * `wall_ms=1919` —— **纯合成只占 1.9s，另外 8s 全是进程启动 + 模型加载**。
   * 同一模型经 `audiocpp_server.exe` 常驻后，单次实测 **2.0s**（快 5 倍）。
   * 所以拿 CLI 做"每句一个新进程"是纯浪费，串行化的价值也只在 CLI 模式成立。
   *
   * 走 server 时能力不减：实测 `voice_ref` + `reference_text` 克隆输出
   * 145964 B（与 CLI 完全一致）、`instructions` 122924 B 正常生效。
   * 但 `speed` 依旧不支持（server 直接 500 `speed is not supported by this model`）。
   */
  serverUrl?: string;
  /** server config 里给这个模型起的 id（默认 breeze-tts-2）；只在 serverUrl 非空时用 */
  serverModelId?: string;
  /**
   * **自动托管 server**（默认 true）：适配器自己拉起 `audiocpp_server.exe` 并走 HTTP。
   * 这是让「2 秒」真正发生的开关 —— `serverUrl` 留空 + 本项 true ⇒ 用 `serverPort` 自启。
   * 起不来时退回 CLI：只降速、音频不变（与「静默换了音色」那种假成功不同，回落会打 warn）。
   * 显式配了 `serverUrl` 时以 `serverUrl` 为准，本项不参与。
   */
  serverAutoStart?: boolean;
  /** 自动托管时监听端口（默认 8189；3178 归 cosyvoice，别抢） */
  serverPort?: number;
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

  /** 音色目录：内置 + 参考音目录里的成对音色（wav + txt） */
  function voices(): TtsVoiceInfo[] {
    const c = conf();
    const out: TtsVoiceInfo[] = [{ id: 'default', label: 'BreezeTTS 2（内置音色）' }];
    try {
      // 复用 voice-dir 的单一真源：只有 wav + txt 成对的才列出来。
      // 落单的 wav 不能列 —— 克隆必须同时给文字稿，列出来点了必失败。
      for (const e of listVoiceEntries(c.voicesDir || defaultVoicesDir())) {
        if (e.id === 'default') continue;
        out.push({ id: e.id, label: `${e.id}（参考音克隆）` });
      }
    } catch {
      // 目录读不到就当只有内置音色：不能因为音色目录问题让 say 整体不可用
    }
    return out;
  }

  /**
   * 走常驻 server（audiocpp_server.exe）合成 —— 这是「快 5 倍」的关键路径。
   *
   * 【为什么值得单独一条路】2026-10-26 实测：CLI 单次 9.7s，但 `--metrics` 报
   * `wall_ms=1919` —— **纯合成只占 1.9s，其余 8s 是进程启动 + 模型加载**。
   * 同一模型常驻后单次实测 **2.0s**。CLI 的"每句一个新进程"纯属浪费。
   *
   * 【API 形状：实测确认过，不是猜的】
   *   POST /v1/audio/speech
   *   body: { model, input, response_format:'wav', voice_ref?, reference_text?, instructions?, options? }
   *   ⇒ 200 + audio/wav 原始字节
   *   ⚠️ `voice_id` 字段**是假的**：传 `voice_id:"FlutterShy"` 返回 107564 B（= 默认音色），
   *      与 plain 完全一致 ⇒ 克隆**只能**用 `voice_ref`（实测 145964 B 才对）。
   *   ⚠️ `speed` / `speaking_rate` ⇒ 500 `speed is not supported by this model`
   *      —— 与 CLI 一致，是模型 spec 没有语速项，不是 server 的锅。
   */
  async function synthesizeViaHttp(
    c: BreezeTts2Config,
    text: string,
    opts: { voice?: string; speed?: number; emotion?: string },
  ): Promise<Buffer> {
    const base = String(c.serverUrl).replace(/\/+$/, '');
    const body: Record<string, unknown> = {
      model: c.serverModelId || 'breeze-tts-2',
      input: text,
      response_format: 'wav',
    };

    // emotion → instructions（模型 spec 的 style_control 通道；实测 122924 B 生效）
    const instruct = opts.emotion || c.defaultInstruct;
    if (instruct) body.instructions = instruct;

    if (opts.voice && opts.voice !== 'default') {
      const dir = c.voicesDir || defaultVoicesDir();
      const entry = listVoiceEntries(dir).find((e) => e.id === opts.voice);
      if (!entry) {
        throw new Error(
          `Breeze-TTS-2 音色「${opts.voice}」不可用：需要 ${dir} 下成对的 ${opts.voice}.wav + ${opts.voice}.txt`,
        );
      }
      // 克隆必须成对：只给 voice_ref 不给 reference_text 会被拒
      //（CLI 侧实测报 `BreezeTTS clone requires reference_text`，server 侧同理）
      body.voice_ref = entry.wavPath;
      body.reference_text = fs.readFileSync(entry.txtPath, 'utf8').trim();
    }

    if (c.requestOptions && Object.keys(c.requestOptions).length > 0) {
      body.options = c.requestOptions;
    }

    const timeout = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${base}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      // 连不上 ≠ 合成失败：把"server 没起"和"合成本身坏了"分开报，否则用户无从下手
      throw new Error(
        `Breeze-TTS-2 server 不可达（${base}）：${err instanceof Error ? err.message : String(err)}` +
          ` —— 检查 voice.tts.breeze.serverUrl，或留空改走 CLI`,
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Breeze-TTS-2 server 返回 ${res.status}：${detail}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) {
      throw new Error(`Breeze-TTS-2 server 输出过短（${buf.length} 字节），可能不是有效 WAV`);
    }
    return buf;
  }

  /**
   * 取 server 基址：显式 `serverUrl` 优先；否则按 `serverAutoStart` 自启。
   * 返回 null ⇒ 调用方走 CLI。
   *
   * 【为什么自启失败不抛错】CLI 是同一模型的完整能力，只是慢。自启失败退回它
   * 仍能出声；抛错则把「慢」升级成「哑」，得不偿失。
   * 但**必须 warn 留痕**：否则用户只感到"提速没生效"，无从判断是配置问题还是缺 exe。
   */
  async function resolveServerUrl(c: BreezeTts2Config): Promise<string | null> {
    if (c.serverUrl) return String(c.serverUrl).replace(/\/+$/, '');
    if (c.serverAutoStart === false) return null;
    try {
      return await ensureBreezeServer({
        modelPath: c.modelPath,
        cliPath: c.cliPath,
        backend: c.backend,
        device: c.device,
        port: c.serverPort,
        modelId: c.serverModelId,
      });
    } catch (err) {
      logger.warn('Breeze-TTS-2 常驻服务自启失败，本次退回 CLI（约 9s）', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async function synthesize(
    text: string,
    opts: { voice?: string; speed?: number; emotion?: string } = {},
  ): Promise<Buffer> {
    const c = conf();
    // 常驻 server 优先：实测 CLI 整次 9.7s（`--metrics` 说纯合成只 1.9s，8s 是进程
    // 启动+模型加载），常驻后单次 2.0s。显式 serverUrl 或 serverAutoStart 任一成立即走 HTTP。
    // 仍走 serialize：8GB 卡的并发安全边界不变（server 侧 slots 也有限）。
    const serverUrl = await resolveServerUrl(c);
    if (serverUrl) return serialize(() => synthesizeViaHttp({ ...c, serverUrl }, text, opts));
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

    // 参考音克隆：voice 不是 default 时，必须**同时**给 --voice-ref 和 --reference-text。
    // 实测（2026-10-26）：只给 --voice-ref ⇒ CLI 报 `BreezeTTS clone requires reference_text`
    // 整单失败（spec 里 reference_text 标注 "required when reference audio codes are used"）。
    // 用 listVoiceEntries（保证 wav+txt 成对）而不是自己拼路径：落单 wav 克隆不了。
    // ⚠️ 找不到就**报错，不静默回退默认音色** —— 静默回退正是"以为换了音色、其实没换"的根源
    // （用户原话：两句都挺像的，其实两句都是模型默认音色）。
    if (opts.voice && opts.voice !== 'default') {
      const dir = c.voicesDir || defaultVoicesDir();
      const entry = listVoiceEntries(dir).find((e) => e.id === opts.voice);
      if (!entry) {
        throw new Error(
          `Breeze-TTS-2 音色「${opts.voice}」不可用：需要 ${dir} 下成对的 ${opts.voice}.wav + ${opts.voice}.txt`,
        );
      }
      args.push(
        '--voice-ref', entry.wavPath,
        '--reference-text', fs.readFileSync(entry.txtPath, 'utf8').trim(),
      );
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
    // 切走时停掉**我们自己起的**常驻 server（认领来的外部实例不碰，见 breeze-server.ts）。
    // 不停就会和下一个引擎的权重抢同一张 8GB 卡。
    dispose: () => stopBreezeServer(),
    // 预热：把 audiocpp_server 提前拉起来，首句不必付 8s 模型加载费。
    // 只有「配了 serverUrl」或「autoStart 开着」时才有服务可预热；否则是纯 CLI，直接返回。
    warmup: async () => {
      const c = conf();
      if (!c.serverUrl && c.serverAutoStart === false) return;
      const url = await resolveServerUrl(c);
      if (!url) throw new Error('Breeze-TTS-2 常驻服务未能就绪（详见日志）');
    },
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
