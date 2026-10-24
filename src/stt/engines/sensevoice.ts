/**
 * SenseVoiceSmall 引擎（sherpa-onnx + ONNX int8）— STT 引擎的默认实现。
 *
 * 选型依据（2026-10-24）：
 *  - 中文识别第一梯队，自带标点/ITN；CPU 实时率 ≈0.07（比 whisper small 快 5-15 倍）；
 *  - Apache-2.0 开源，模型单文件 ~230MB（model.int8.onnx）+ tokens.txt；
 *  - sherpa-onnx-node npm 包自带 win-x64 预编译二进制（node -e 可直接加载）；
 *  - DeepSeek Harness（DSH）同选 SenseVoice —— 竞品印证。
 *
 * 模型分发：hf-mirror 直链（国内可达）→ huggingface 官方兜底；落盘
 * ~/.agent/models/stt/sense-voice/。运行时依赖 sherpa-onnx-node 为可选依赖：
 * 未安装 / 模型未下载时 status 如实上报，transcribe 报错（fail-closed）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogger } from '../../logging/logger.js';
import { getModelRoot } from '../../runtime/model-root.js';
import { downloadFile, ModelDownloadError } from '../download.js';
import type { SttEngine, SttEngineStatus } from '../engine.js';

const logger = createLogger('stt-sensevoice');

const MODEL_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
/** 模型文件（相对模型目录） */
const MODEL_FILES = ['model.int8.onnx', 'tokens.txt'] as const;

/** 下载源（按序尝试；hf-mirror 国内可达优先） */
/** 下载源偏好 → 排序后的直链（锁定源优先，失败仍回落其它源）。 */
function modelUrls(file: string, mirrorPref: string): string[] {
  const sources = [
    { id: 'hf-mirror', url: `https://hf-mirror.com/${MODEL_REPO}/resolve/main/${file}` },
    { id: 'huggingface', url: `https://huggingface.co/${MODEL_REPO}/resolve/main/${file}` },
  ];
  if (mirrorPref === 'hf-mirror' || mirrorPref === 'huggingface') {
    const locked = sources.filter((x) => x.id === mirrorPref).map((x) => x.url);
    return [...locked, ...sources.filter((x) => x.id !== mirrorPref).map((x) => x.url)];
  }
  return sources.map((x) => x.url);   // auto：hf-mirror 优先（国内可达）
}

export function modelDir(): string {
  // 模型根目录唯一真源（可配置换盘）：env HYACINTH_MODELS_DIR > config models.root > ~/.agent/models
  return path.join(getModelRoot(), 'stt', 'sense-voice');
}

export class SenseVoiceEngine implements SttEngine {
  private recognizer: unknown = null;
  private sherpa: Record<string, unknown> | null = null;
  private runtimeError: string | null = null;
  private downloading = false;
  private progress: SttEngineStatus['downloadProgress'];
  private lastError: string | null = null;
  private initing: Promise<void> | null = null;
  /** 下载源偏好（'' = auto；'hf-mirror' | 'huggingface' 锁定优先源）——经契约域从 models.mirror 配置同步 */
  private mirrorPref: string = '';

  setMirrorPref(pref: string): void {
    this.mirrorPref = pref || '';
  }

  status(): SttEngineStatus {
    const dir = modelDir();
    const missing = MODEL_FILES.filter((f) => {
      try { return !fs.statSync(path.join(dir, f)).isFile(); } catch { return true; }
    });
    let runtimeAvailable = true;
    try {
      // 与 transcribe 同一动态 import 路径：包缺失/二进制不可加载都算不可用
      require_cached();
    } catch (err) {
      runtimeAvailable = false;
      this.runtimeError = err instanceof Error ? err.message : String(err);
    }
    return {
      engine: 'sensevoice',
      mirror: this.mirrorPref || 'auto',
      runtimeAvailable,
      modelReady: runtimeAvailable && missing.length === 0,
      modelDir: dir,
      missingFiles: [...missing],
      downloading: this.downloading,
      downloadProgress: this.downloading ? this.progress : undefined,
      lastError: this.lastError ?? this.runtimeError ?? undefined,
    };
  }

  /** 下载缺失的模型文件（幂等；进行中重复调用返回同一进度）。 */
  async ensureModel(): Promise<void> {
    if (this.downloading) {
      throw new ModelDownloadError('模型正在下载中');
    }
    const dir = modelDir();
    const missing = MODEL_FILES.filter((f) => {
      try { return !fs.statSync(path.join(dir, f)).isFile(); } catch { return true; }
    });
    if (missing.length === 0) return;

    this.downloading = true;
    try {
      for (const file of missing) {
        const dest = path.join(dir, file);
        logger.info(`下载 STT 模型文件：${file}`);
        await downloadFile(modelUrls(file, this.mirrorPref), dest, (p) => {
          this.progress = { ...p, file };
        });
        logger.info(`STT 模型文件下载完成：${file}`);
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.downloading = false;
      this.progress = undefined;
    }
  }

  removeModel(): void {
    // 删除模型目录（源码不携带模型，删除后 status 回 needsDownload，可随时重下）。
    // 识别器持有已加载的模型内存——一并释放（下次 transcribe 重新初始化）。
    this.recognizer = null;
    this.initing = null;
    const dir = modelDir();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info(`STT 模型已删除：${dir}`);
    } catch (err) {
      logger.warn(`STT 模型删除失败：${err instanceof Error ? err.message : err}`);
    }
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<{ text: string; durationMs: number }> {
    await this.ensureReady();
    const st = this.status();
    if (!st.modelReady) {
      throw new Error(`SenseVoice 模型未就绪（缺 ${st.missingFiles.join(', ') || '未知文件'}），先调用 stt.download 下载`);
    }
    if (sampleRate !== 16000) {
      throw new Error(`仅支持 16kHz 采样率（收到 ${sampleRate}）——前端负责重采样`);
    }
    const sherpa = require_cached();
    if (!this.recognizer) {
      // initing 防并发：首个调用做初始化，后续共享
      this.initing ??= this.initRecognizer(sherpa);
      await this.initing;
    }
    const started = Date.now();
    const recognizer = this.recognizer as {
      createStream(): { acceptWaveform(o: { sampleRate: number; samples: Float32Array }): void };
      decode(stream: unknown): void;
      getResult(stream: unknown): { text?: string };
    };
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    const text = (result?.text ?? '').trim();
    logger.info(`STT 转写完成：${text.length} 字 / ${(samples.length / 16000).toFixed(1)}s 音频`);
    return { text, durationMs: Date.now() - started };
  }

  private async initRecognizer(sherpa: Record<string, unknown>): Promise<void> {
    const dir = modelDir();
    const Ctor = sherpa.OfflineRecognizer as new (cfg: unknown) => unknown;
    // ⚠️ sherpa-onnx-node 2.0 的配置形状（实测踩过三个坑）：
    //   1. 模型相关字段包在 **modelConfig** 里（顶层直接放 tokens/senseVoice 会报
    //      "tokens: '' does not exist"——native 读的是 modelConfig 子对象）；
    //   2. tokens 在 modelConfig **顶层**（不在 senseVoice 里）；
    //   3. ITN 开关叫 useInverseTextNormalization（不是 useItn）。
    //   写错不报键名错而是 native 侧 "Please check your config!"。
    this.recognizer = new Ctor({
      modelConfig: {
        senseVoice: {
          model: path.join(dir, 'model.int8.onnx'),
          useInverseTextNormalization: 1,
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      },
    });
    logger.info('SenseVoice 识别器初始化完成');
  }

  private async ensureReady(): Promise<void> {
    const st = this.status();
    if (!st.runtimeAvailable) {
      throw new Error(`sherpa-onnx 运行时不可用（${st.lastError ?? '未安装'}）——执行 pnpm add sherpa-onnx-node`);
    }
    if (!st.modelReady) {
      throw new Error(`SenseVoice 模型未下载（${st.missingFiles.join(', ')}）——调用 stt.download 或到设置页下载`);
    }
  }
}

/** 动态加载 sherpa-onnx-node（CJS 原生绑定）；失败抛错由调用方归类为 runtimeUnavailable。 */
const requireSherpa = createRequire(import.meta.url);
function require_cached(): Record<string, unknown> {
  return requireSherpa('sherpa-onnx-node') as Record<string, unknown>;
}
