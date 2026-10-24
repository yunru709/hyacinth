// ============================================================
// UI 契约层 — 语音转文字域（stt.*）
// ============================================================
// 覆盖 WebUI/TUI 的语音输入推理面（本地 SenseVoice，见 src/stt/）：
//   stt.status                引擎/模型就绪状态（含下载进度）
//   stt.download              触发模型下载（幂等；进度经 stt.model_progress 事件推送）
//   stt.transcribe {audioWavBase64}
//                             转写：入参是 **16kHz 单声道 PCM16 的 WAV**（前端负责
//                             录音解码与重采样，见 webui 的 sttToggle），出参
//                             { text, durationMs }
//
// 引擎经 backend 注入门面（SttEngineLike，真实引擎天然兼容）；未注入时
// transcribe 报错（fail-closed）。音频走 RPC base64：语音输入典型 5~30 秒
// （240KB/min base64），量级可承受，不开 HTTP 旁路 —— 保持"数据走契约层"。
// ============================================================

import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实引擎 src/stt/ 天然兼容）
// ────────────────────────────────────────────────────────────

export interface SttEngineLike {
  status(): {
    engine: string;
    runtimeAvailable: boolean;
    modelReady: boolean;
    modelDir: string;
    missingFiles: string[];
    downloading: boolean;
    downloadProgress?: { percent: number; received: number; total: number; speed: string; file: string };
    lastError?: string;
    /** 下载源偏好：auto | hf-mirror | huggingface */
    mirror: string;
  };
  ensureModel(): Promise<void>;
  removeModel(): void;
  /** 同步下载源偏好（契约域从 models.mirror 配置读取后下发） */
  setMirrorPref?(pref: string): void;
  transcribe(samples: Float32Array, sampleRate: number): Promise<{ text: string; durationMs: number }>;
}

// ────────────────────────────────────────────────────────────
// 语音转文字域选项
// ────────────────────────────────────────────────────────────

export interface SttDomainOptions {
  /** 获取 STT 引擎（进程级单例；未注入时 transcribe/download 报错） */
  getEngine: () => SttEngineLike | null;
  /** 读取下载源偏好（config models.mirror：''=auto | hf-mirror | huggingface） */
  getMirrorPref?: () => string | undefined;
  /** 事件广播（stt.model_progress 下载进度推送；缺省静默） */
  emit?: (type: string, payload?: unknown) => void;
}

// ────────────────────────────────────────────────────────────
// 语音转文字域工厂
// ────────────────────────────────────────────────────────────

export function createSttDomain(options: SttDomainOptions): DomainHandler {
  const { getEngine } = options;
  /** 把 models.mirror 配置同步到引擎（引擎据此排序下载源）。 */
  const syncMirror = (e: SttEngineLike): void => {
    const pref = options.getMirrorPref?.();
    if (typeof pref === 'string') e.setMirrorPref?.(pref);
  };
  const engine = (): SttEngineLike => {
    const e = getEngine();
    if (!e) throw new Error('stt engine not available（该 UI 通道未接入语音转文字）');
    return e;
  };

  return {
    // ── stt.status ─────────────────────────────────────────
    status() {
      const e = engine();
      syncMirror(e);
      return e.status();
    },

    // ── stt.download ───────────────────────────────────────
    /** 幂等：模型已齐返回 ready；进行中返回 started:true（重复调用不重复下载）。
     *  下载期间以 ~800ms 周期广播 stt.model_progress，完成/失败各推一帧终态。 */
    async download() {
      const e = engine();
      syncMirror(e);
      const st = e.status();
      if (st.modelReady) return { started: false, ready: true };
      if (st.downloading) return { started: true, alreadyRunning: true };

      void (async () => {
        const timer = setInterval(() => {
          const s = e.status();
          if (s.downloading && s.downloadProgress) {
            options.emit?.(UI_EVENT.STT_MODEL_PROGRESS, { phase: 'downloading', ...s.downloadProgress });
          }
        }, 800);
        try {
          await e.ensureModel();
          options.emit?.(UI_EVENT.STT_MODEL_PROGRESS, { phase: 'done', percent: 100 });
        } catch (err) {
          options.emit?.(UI_EVENT.STT_MODEL_PROGRESS, {
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearInterval(timer);
        }
      })();

      return { started: true, ready: false };
    },

    // ── stt.remove ─────────────────────────────────────────
    /** 删除已下载的模型文件（释放磁盘；幂等——目录不存在时也返回 ok）。
     *  源码不携带模型：删除后 status 回 needsDownload，可随时重新下载。 */
    remove() {
      const e = engine();
      e.removeModel();
      return { ok: true, modelDir: e.status().modelDir };
    },

    // ── stt.transcribe ─────────────────────────────────────
    async transcribe(params: unknown): Promise<{ text: string; durationMs: number }> {
      syncMirror(engine());
      const audioWavBase64 = (params as { audioWavBase64?: string } | undefined)?.audioWavBase64;
      if (!audioWavBase64 || typeof audioWavBase64 !== 'string') {
        throw new Error('stt.transcribe requires "audioWavBase64"（16kHz 单声道 PCM16 WAV）');
      }
      const { parsePcmWav } = await import('../../stt/wav.js');
      const buf = Buffer.from(audioWavBase64, 'base64');
      if (buf.length > 16 * 1024 * 1024) throw new Error('音频过大（>16MB）');
      const { sampleRate, samples } = parsePcmWav(buf);
      if (samples.length === 0) throw new Error('音频为空');
      return engine().transcribe(samples, sampleRate);
    },
  };
}
