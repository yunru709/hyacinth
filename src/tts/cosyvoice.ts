/**
 * CosyVoice3 本地 TTS — 模型下载编排 + Python 推理服务生命周期。
 *
 * 与 STT（sherpa-onnx 进程内推理）不同：CosyVoice3 是 torch/LLM 混合架构，
 * 必须跑在 Python 生态里 —— 采用**本地推理服务**模式（同 llama.cpp 的本地
 * 后端先例）：源码只带一个自包含的推理脚本（engines/cosyvoice/server.py，
 * 胶水），python 环境 + torch + cosyvoice 包是**外来环境**，按需安装
 * （设置页检测并给出指引），模型按 variant（base / rl）按需下载。
 *
 * 进程管理复用 lifecycle 的模式（拉起/健康检查/停止），但不走
 * LifecycleSupervisor 全局注册（TTS 服务按需启停，不是常驻后台）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../logging/logger.js';
import { downloadFile, ModelDownloadError } from '../stt/download.js';
import {
  COSYVOICE_DIR,
  filesFor,
  fileUrls,
  missingFiles,
  type CosyVoiceVariant,
} from './cosyvoice-models.js';
import { cosyvoiceImportOk, cosyvoicePythonEnv, ensureCosyVoiceDeps } from './cosyvoice-deps.js';
import { DEFAULT_VOICE_ID, ensureVoicesReady, listVoiceEntries, voicesDir } from './voice-dir.js';

const logger = createLogger('tts-cosyvoice');

/** 本地推理服务的端口（固定：本地单用户，冲突时报错由 UI 呈现） */
export const COSYVOICE_PORT = 3178;

export interface TtsModelState {
  variant: CosyVoiceVariant;
  /** 下载源偏好：auto | hf-mirror | huggingface（经契约域从 models.mirror 同步） */
  mirror: string;
  /** 已选择的 variant 的缺失文件 */
  missingFiles: string[];
  ready: boolean;
  downloading: boolean;
  /**
   * 进度（downloading 时有值）。stage 区分「一键就绪」的两个阶段：
   * model = 模型权重下载（percent/received/total/speed 有效）；
   * deps = python 依赖自动安装（file 行 = git/pip 输出，数值字段缺省）。
   */
  downloadProgress?: { stage?: 'model' | 'deps'; percent?: number; received?: number; total?: number; speed?: string; file: string };
  /** 模型目录 */
  modelDir: string;
}

export interface PythonEnvState {
  pythonAvailable: boolean;
  pythonVersion: string | null;
  /** cosyvoice 包是否可导入（决定推理服务能否启动） */
  cosyvoiceInstalled: boolean | null;   // null=未检测
  pythonPath: string;
  hint: string;
}

export interface CosyVoiceServiceState {
  running: boolean;
  port: number;
  lastError?: string;
}

/** 音色目录条目（say.voice 参数 / 设置页下拉的数据源） */
export interface TtsVoiceInfo {
  id: string;
  label: string;
}

/**
 * 音色目录 = `<models.root>/voices/` 下的参考音对（<id>.wav + <id>.txt），
 * zero-shot 克隆该音色说话。位置在模型权重目录**之外**（用户资产，详见
 * voice-dir.ts）。id 'default' 固定列在首位：对应 voices/default.wav
 * （缺失时推理服务回退模型内置 sft 音色/明确报错）。
 * 旧位置（模型目录 prompts/ 与 prompt.*）在首次列出时自动搬迁一次。
 */
export function listVoices(): TtsVoiceInfo[] {
  ensureVoicesReady(COSYVOICE_DIR());
  const out: TtsVoiceInfo[] = [{ id: DEFAULT_VOICE_ID, label: '默认（voices/default.wav）' }];
  for (const e of listVoiceEntries()) {
    if (e.id === DEFAULT_VOICE_ID) continue;
    out.push({ id: e.id, label: `${e.id}（自定义参考音）` });
  }
  return out;
}

export class CosyVoiceService {
  private variant: CosyVoiceVariant = 'rl';
  private downloading = false;
  private downloadProgress: TtsModelState['downloadProgress'];
  private downloadError: string | null = null;
  private proc: ChildProcess | null = null;
  private lastServiceError: string | null = null;
  /** python 环境（探测结果缓存；设置页手动刷新） */
  private pyEnv: PythonEnvState | null = null;
  private pythonPath: string;
  /** 下载源偏好（'' = auto） */
  private mirrorPref: string = '';
  /** 下载队列（顺序逐文件） */
  private downloadQueue: Promise<void> = Promise.resolve();

  constructor(pythonPath?: string) {
    this.pythonPath = pythonPath || 'python';
  }

  setPythonPath(p: string): void {
    this.pythonPath = p;
    this.pyEnv = null;   // 强制重新探测
  }

  getVariant(): CosyVoiceVariant {
    return this.variant;
  }

  setVariant(v: CosyVoiceVariant): void {
    this.variant = v;
  }

  /** 下载源偏好（契约域从 models.mirror 配置同步） */
  setMirrorPref(pref: string): void {
    this.mirrorPref = pref || '';
  }

  modelState(): TtsModelState {
    const missing = missingFiles(this.variant);
    return {
      variant: this.variant,
      mirror: this.mirrorPref || 'auto',
      missingFiles: missing.map((f) => f.path),
      ready: missing.length === 0,
      downloading: this.downloading,
      downloadProgress: this.downloading ? this.downloadProgress : undefined,
      modelDir: COSYVOICE_DIR(),
    };
  }

  /**
   * 触发「一键就绪」（幂等；进行中重复调用返回 alreadyRunning）。
   * 两阶段：模型权重下载（stage=model）→ python 依赖自动安装（stage=deps，
   * clone CosyVoice 仓库 + pip 装推理裁剪集 —— 交给用户的是下载完成即可用）。
   * python 缺失时只下模型不装依赖（hint 指引装 python，装好后重新点下载即可）。
   */
  download(variant?: CosyVoiceVariant): { started: boolean; alreadyRunning: boolean } {
    if (variant) this.variant = variant;
    if (this.downloading) return { started: true, alreadyRunning: true };
    const missing = missingFiles(this.variant);
    const files = [...missing];

    this.downloading = true;
    this.downloadError = null;
    const dir = COSYVOICE_DIR();
    this.downloadQueue = this.downloadQueue.then(async () => {
      try {
        // ── 阶段 1：模型权重 ──
        for (const spec of files) {
          const dest = path.join(dir, spec.path);
          logger.info(`下载 TTS 模型文件：${spec.path}`);
          await downloadFile(fileUrls(spec.path, this.mirrorPref), dest, (p) => {
            this.downloadProgress = { stage: 'model', ...p, file: spec.path };
          });
        }
        if (files.length) logger.info('TTS 模型文件全部就绪');

        // ── 阶段 2：python 依赖（已通过导入探测则秒过）──
        const pythonOk = await this.execCapture(this.pythonPath, ['--version']).then(() => true).catch(() => false);
        if (!pythonOk) {
          logger.warn('TTS 依赖安装跳过：未检测到 python（模型已下载，装好 python 后重新点下载补依赖）');
          return;
        }
        if (await cosyvoiceImportOk(this.pythonPath)) {
          if (files.length) logger.info('TTS python 依赖已就绪（跳过安装）');
          return;
        }
        this.downloadProgress = { stage: 'deps', file: '检查 python 依赖…' };
        await ensureCosyVoiceDeps({
          pythonPath: this.pythonPath,
          onProgress: (line) => { this.downloadProgress = { stage: 'deps', file: line }; },
        });
        this.pyEnv = null;   // 依赖状态变了，强制下次探测刷新
        logger.info('TTS 一键就绪：模型 + python 依赖全部完成');
      } catch (err) {
        this.downloadError = err instanceof Error ? err.message : String(err);
        logger.warn(`TTS 下载/依赖安装失败：${this.downloadError}`);
      } finally {
        this.downloading = false;
        this.downloadProgress = undefined;
      }
    });
    return { started: true, alreadyRunning: false };
  }

  state(): TtsModelState {
    return this.modelState();
  }

  downloadErrorText(): string | null {
    return this.downloadError;
  }

  // ── Python 环境 ────────────────────────────────────────────

  async detectPython(): Promise<PythonEnvState> {
    const version = await this.execCapture(this.pythonPath, ['--version']).catch(() => null);
    const pythonAvailable = version !== null;
    let cosyvoiceInstalled: boolean | null = null;
    if (pythonAvailable) {
      // 探测带 PYTHONPATH（与运行环境一致：~/.agent/envs/CosyVoice 仓库根）
      cosyvoiceInstalled = await cosyvoiceImportOk(this.pythonPath);
    }
    this.pyEnv = {
      pythonAvailable,
      pythonVersion: version?.trim() ?? null,
      cosyvoiceInstalled,
      pythonPath: this.pythonPath,
      hint: pythonAvailable
        ? (cosyvoiceInstalled
          ? 'python 环境与 cosyvoice 已就绪'
          : '缺少 cosyvoice 依赖 —— 点「下载」自动配置（克隆官方仓库 + 安装推理依赖）')
        : '未检测到 python —— 语音合成推理需要 python 3.10+ 与 torch 生态，请安装后在下方填入 python 路径',
    };
    return this.pyEnv;
  }

  pythonEnv(): PythonEnvState | null {
    return this.pyEnv;
  }

  private execCapture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { shell: process.platform === 'win32' });
      let out = '';
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { out += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out || `exit ${code}`))));
    });
  }

  // ── 推理服务生命周期 ───────────────────────────────────────

  serviceState(): CosyVoiceServiceState {
    return { running: this.proc !== null && !this.proc.killed, port: COSYVOICE_PORT, lastError: this.lastServiceError ?? undefined };
  }

  /** 启动本地推理服务（模型未就绪 / cosyvoice 未安装时抛错）。 */
  async start(): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    const st = this.modelState();
    if (!st.ready) throw new Error(`CosyVoice3 模型未就绪（缺 ${st.missingFiles.join(', ')})，先在设置页下载`);
    const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'engines', 'cosyvoice', 'server.py');
    if (!fs.existsSync(script)) throw new Error(`推理脚本缺失：${script}`);

    logger.info(`启动 CosyVoice3 推理服务（variant=${this.variant}）`);
    // 就绪信号走 stdout 标记而非 HTTP 轮询：serve 进程内 http.get 探测实测会
    // 无故挂起（无 error/无 timeout/永不 settle，2026-10-24 实况 ✗），而 python
    // 侧 'model ready' 必然经 stdout 到达 —— 零额外连接、无挂起面。
    let readyFromStdout = false;
    // 参考音目录：用户资产（<models.root>/voices），与模型权重目录解耦；
    // 旧位置（模型目录内 prompt.*/prompts/）先搬迁一次再启动。
    ensureVoicesReady(COSYVOICE_DIR());
    this.proc = spawn(this.pythonPath, [script, '--model-dir', COSYVOICE_DIR(), '--variant', this.variant, '--port', String(COSYVOICE_PORT), '--voices-dir', voicesDir()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // PYTHONPATH 前置 CosyVoice 仓库根（~/.agent/envs/CosyVoice）：官方非 pip 包，
      // 依赖装好后靠仓库根 import —— spawn 与探测/安装共用同一环境合成。
      env: cosyvoicePythonEnv(),
    });
    this.proc.stdout?.on('data', (d) => {
      const t = String(d);
      if (t.includes('model ready')) readyFromStdout = true;
      logger.info(`[cosyvoice] ${t.trim()}`);
    });
    this.proc.stderr?.on('data', (d) => logger.warn(`[cosyvoice] ${String(d).trim()}`));
    this.proc.on('exit', (code) => {
      logger.warn(`CosyVoice3 推理服务退出（code=${code}）`);
      this.proc = null;
    });

    // 等待就绪：模型加载可能要数十秒（torch 初始化 + 权重载入）
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (readyFromStdout) {
        logger.info(`CosyVoice3 推理服务就绪（:${COSYVOICE_PORT}）`);
        this.lastServiceError = null;
        return;
      }
      if (!this.proc || this.proc.killed) throw new Error('CosyVoice3 推理服务启动失败（进程已退出，详见日志）');
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('CosyVoice3 推理服务 180s 内未就绪（python 环境或模型可能不完整，详见日志）');
  }

  stop(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  private health(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: COSYVOICE_PORT, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /** 合成语音 → WAV Buffer（推理服务返回 audio/wav）。speed 原生透传（0.5~2）。 */
  async synthesize(text: string, opts: { variant?: CosyVoiceVariant; voice?: string; speed?: number } = {}): Promise<Buffer> {
    // 预检走 TCP 层而非 http（health() 的 http.get 在 serve 进程内连接失败时会
    // 无故不触发任何回调 —— 2026-10-24 实况 ✗；net.connect 的 error/超时双保险
    // 可靠）。端口不通 → start() 拉起（就绪信号走 python stdout，见 start()）。
    if (!(await this.portOpen())) {
      await this.start();
    }
    return await this.postTts(text, opts);
  }

  /** TCP 探活（1.5s 超时 + error 兜底，两者都算「不通」） */
  private portOpen(timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: COSYVOICE_PORT }, () => { sock.destroy(); resolve(true); });
      const to = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
      sock.on('error', () => { clearTimeout(to); resolve(false); });
    });
  }

  private async postTts(text: string, opts: { variant?: CosyVoiceVariant; voice?: string; speed?: number }): Promise<Buffer> {
    // 用 fetch（undici 栈）而非 http.request：serve 进程内 node:http 客户端对
    // 本服务存在「连接失败无回调 / 响应 end 不触发」的挂死实况（2026-10-24 ✗，
    // bash 独立进程同代码正常 —— 疑似进程内 http 栈状态被污染）。undici 是独立
    // 实现，实测稳定；AbortSignal 兜底防一切挂起。
    const payload = JSON.stringify({ text, variant: opts.variant ?? this.variant, voice: opts.voice ?? '', speed: opts.speed ?? 1 });
    const res = await fetch(`http://127.0.0.1:${COSYVOICE_PORT}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      throw new Error(`TTS 服务返回 ${res.status}：${errText}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

let singleton: CosyVoiceService | null = null;

export function getTtsService(): CosyVoiceService {
  singleton ??= new CosyVoiceService();
  return singleton;
}
