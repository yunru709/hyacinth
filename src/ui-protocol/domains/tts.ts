// ============================================================
// UI 契约层 — 语音合成域（tts.*）
// ============================================================
// 覆盖本地 TTS（Fun-CosyVoice3）的环境管理面与合成：
//   tts.status          python 环境 / 模型（base|rl）/ 服务运行状态
//   tts.detectPython    探测 python 与 cosyvoice 包（设置页手动刷新）
//   tts.setPythonPath   配置 python 可执行路径（环境不在 PATH 时）
//   tts.download {variant}   模型下载（base/rl 只差一个 LLM 权重，增量）
//   tts.start / tts.stop     本地推理服务（python server.py）启停
//   tts.synthesize {text}    合成 → WAV base64（服务运行时可用）
//
// 架构（对照 STT）：CosyVoice3 是 torch/LLM 混合模型，无法进程内推理 ——
// 采用本地推理服务模式（同 llama.cpp 先例）：源码只带 server.py 胶水，
// python 环境 + cosyvoice 包 + 模型权重均为**外来环境**，按需安装/下载，
// 设置页是它们的管理面。引擎经 backend 注入门面（与 stt 同模式）。
// ============================================================

import type { DomainHandler } from '../server.js';
import { UI_EVENT } from '../../events.js';

// ────────────────────────────────────────────────────────────
// 结构化接口（真实 CosyVoiceService 天然兼容）
// ────────────────────────────────────────────────────────────

export interface TtsServiceLike {
  modelState(): {
    variant: 'base' | 'rl';
    missingFiles: string[];
    ready: boolean;
    downloading: boolean;
    /** 一键就绪进度：stage=model 权重下载（数值字段有效）/ deps python 依赖安装（file=命令输出行） */
    downloadProgress?: { stage?: 'model' | 'deps'; percent?: number; received?: number; total?: number; speed?: string; file: string };
    modelDir: string;
    /** 下载源偏好：auto | hf-mirror | huggingface */
    mirror: string;
  };
  download(variant?: 'base' | 'rl'): { started: boolean; alreadyRunning: boolean };
  /** 同步下载源偏好（契约域从 models.mirror 配置读取后下发） */
  setMirrorPref?(pref: string): void;
  setVariant(v: 'base' | 'rl'): void;
  getVariant(): 'base' | 'rl';
  downloadErrorText(): string | null;
  detectPython(): Promise<{
    pythonAvailable: boolean;
    pythonVersion: string | null;
    cosyvoiceInstalled: boolean | null;
    pythonPath: string;
    hint: string;
  }>;
  pythonEnv(): {
    pythonAvailable: boolean;
    pythonVersion: string | null;
    cosyvoiceInstalled: boolean | null;
    pythonPath: string;
    hint: string;
  } | null;
  setPythonPath(p: string): void;
  serviceState(): { running: boolean; port: number; lastError?: string };
  start(): Promise<void>;
  stop(): void;
  synthesize(text: string, opts?: { variant?: 'base' | 'rl'; voice?: string; speed?: number }): Promise<Buffer>;
}

// ────────────────────────────────────────────────────────────
// 语音合成域选项
// ────────────────────────────────────────────────────────────

/** 音色目录条目（say.voice 参数取值域；真实 listVoices 天然兼容） */
export interface TtsVoiceInfoLike {
  id: string;
  label: string;
}

/** say 语音播报配置（voice.say.* 配置节；say-voice 插件每回合现读） */
export interface SayBroadcastConfig {
  /** 总开关（默认 false：模型/环境就绪后由用户打开） */
  broadcast: boolean;
  /** 默认音色 id（空 = 引擎默认） */
  voice: string;
}

export interface TtsDomainOptions {
  /** 获取 TTS 服务（进程级单例；未注入时全部方法报错） */
  getService: () => TtsServiceLike | null;
  /** 读取下载源偏好（config models.mirror：''=auto | hf-mirror | huggingface） */
  getMirrorPref?: () => string | undefined;
  /** 音色目录（模型目录 prompts/ 参考音对；缺省只报默认音色） */
  getVoices?: () => TtsVoiceInfoLike[];
  /** 读取 say 播报配置（voice.say.broadcast / voice.say.voice） */
  getSayConfig?: () => SayBroadcastConfig;
  /** 写 say 播报配置（设置页开关/默认音色下拉） */
  setSayConfig?: (cfg: Partial<SayBroadcastConfig>) => void;
  /** 事件广播（tts.model_progress 模型下载进度推送；缺省静默） */
  emit?: (type: string, payload?: unknown) => void;
}

// ────────────────────────────────────────────────────────────
// 语音合成域工厂
// ────────────────────────────────────────────────────────────

export function createTtsDomain(options: TtsDomainOptions): DomainHandler {
  const { getService } = options;
  /** 把 models.mirror 配置同步到服务（服务据此排序下载源）。 */
  const syncMirror = (s: TtsServiceLike): void => {
    const pref = options.getMirrorPref?.();
    // 临时诊断日志（定位 mirror 不同步问题后移除）
    if (typeof pref === 'string') s.setMirrorPref?.(pref);
  };
  const service = (): TtsServiceLike => {
    const s = getService();
    if (!s) throw new Error('tts service not available（该 UI 通道未接入语音合成）');
    return s;
  };

  return {
    // ── tts.status ─────────────────────────────────────────
    status() {
      const s = service();
      syncMirror(s);
      return {
        model: s.modelState(),
        python: s.pythonEnv(),
        service: s.serviceState(),
        downloadError: s.downloadErrorText() ?? undefined,
        voices: options.getVoices?.() ?? [],
        say: options.getSayConfig?.() ?? { broadcast: false, voice: '' },
      };
    },

    // ── tts.setSayBroadcast ────────────────────────────────
    /** say 语音播报开关 + 默认音色（部分更新；写 voice.say.* 配置节） */
    setSayBroadcast(params: unknown) {
      const { broadcast, voice } = (params ?? {}) as { broadcast?: boolean; voice?: string };
      if (broadcast === undefined && voice === undefined) {
        throw new Error('tts.setSayBroadcast requires "broadcast" or "voice"');
      }
      if (!options.setSayConfig) throw new Error('say broadcast config not available（该 UI 通道未接入配置中心）');
      options.setSayConfig({
        ...(typeof broadcast === 'boolean' ? { broadcast } : {}),
        ...(typeof voice === 'string' ? { voice } : {}),
      });
      return { ok: true, ...(options.getSayConfig?.() ?? {}) };
    },

    // ── tts.detectPython ───────────────────────────────────
    async detectPython() {
      return service().detectPython();
    },

    // ── tts.setPythonPath ──────────────────────────────────
    setPythonPath(params: unknown) {
      const p = (params as { pythonPath?: string } | undefined)?.pythonPath;
      if (!p) throw new Error('tts.setPythonPath requires "pythonPath"');
      service().setPythonPath(p);
      return { ok: true, pythonPath: p };
    },

    // ── tts.download ───────────────────────────────────────
    /** 幂等；进行中重复调用返回 alreadyRunning。进度经 tts.model_progress 推送。 */
    async download(params: unknown) {
      const variant = (params as { variant?: 'base' | 'rl' } | undefined)?.variant;
      syncMirror(service());
      const result = service().download(variant);
      if (result.started && !result.alreadyRunning) {
        // 后台跟踪：下载完成/失败各推一帧终态（进度中帧由前端轮询 status）
        const s = service();
        void Promise.resolve().then(() => {
          const timer = setInterval(() => {
            const st = s.modelState();
            if (st.downloading && st.downloadProgress) {
              options.emit?.(UI_EVENT.TTS_MODEL_PROGRESS, {
                phase: 'downloading', variant: st.variant, ...st.downloadProgress,
              });
            }
          }, 800);
          const poll = () => {
            const st = s.modelState();
            if (!st.downloading) {
              clearInterval(timer);
              options.emit?.(UI_EVENT.TTS_MODEL_PROGRESS, {
                phase: st.ready ? 'done' : 'error',
                variant: st.variant,
                message: st.ready ? undefined : (s.downloadErrorText() ?? '下载失败'),
              });
              return;
            }
            setTimeout(poll, 400);
          };
          setTimeout(poll, 400);
        });
      }
      return result;
    },

    // ── tts.start / tts.stop ───────────────────────────────
    async start() {
      await service().start();
      return service().serviceState();
    },

    stop() {
      service().stop();
      return service().serviceState();
    },

    // ── tts.synthesize ─────────────────────────────────────
    /** 合成 → WAV base64（服务运行时会自动拉起，冷启动含模型加载可能 30s+） */
    async synthesize(params: unknown): Promise<{ audioWavBase64: string }> {
      syncMirror(service());
      const { text, variant, voice } = (params ?? {}) as { text?: string; variant?: 'base' | 'rl'; voice?: string };
      if (!text || typeof text !== 'string') throw new Error('tts.synthesize requires "text"');
      const buf = await service().synthesize(text, { variant, voice });
      return { audioWavBase64: buf.toString('base64') };
    },
  };
}
