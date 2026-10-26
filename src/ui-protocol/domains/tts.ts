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
import { UI_EVENT, type SayVoiceEvent } from '../../events.js';

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

/**
 * 引擎清单条目 —— 「say 接哪个 TTS 引擎」的数据源（设置页下拉 / TUI 面板）。
 *
 * 契约层不反向依赖业务层（src/tts/index.ts），所以这里重新声明一份结构；
 * 两边靠**结构化类型**兼容，字段名必须与 TtsEngineInfo 保持一致。
 */
export interface TtsEngineInfoLike {
  /** 实现自己的 id：cosyvoice3 / breeze-tts-2 / online-breeze */
  id: string;
  /** 配置取值，写回 voice.tts.engine 用这个 */
  kind: string;
  /** local = 本机推理；remote = 走网络 */
  kindType: 'local' | 'remote';
  /** 给人看的一句话说明 */
  label: string;
  /** 能力声明：不支持的参数由引擎忽略，UI 据此置灰 */
  capabilities: { voice: boolean; speed: boolean; emotion: boolean };
  /** 是否可用（本地看模型在不在，在线看配置全不全） */
  ready: boolean;
  /** 就绪 / 缺失详情 */
  detail: string;
  /** 是否当前选中 */
  active: boolean;
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
  /** 引擎清单（缺省则不暴露 tts.engines / tts.setEngine） */
  listEngines?: () => TtsEngineInfoLike[];
  /**
   * 用「当前选中的引擎」合成 —— 设置页试听必须走这条。
   *
   * 为什么不复用 getService()：那个是 cosyvoice 专属服务对象。若试听仍走它，
   * 用户切到「在线 API」后点击试听，听到的还是本地 CosyVoice3 的声音，
   * 会让人以为切换没生效 —— 典型的"界面对了、行为没对"。
   */
  synthesizeViaEngine?: (
    text: string,
    opts: { voice?: string; speed?: number; emotion?: string },
  ) => Promise<Buffer>;
  /** 写引擎选择（voice.tts.engine） */
  setEngineKind?: (kind: string) => void;
  /** 读当前引擎选择 */
  getEngineKind?: () => string;
  /** 读取下载源偏好（config models.mirror：''=auto | hf-mirror | huggingface） */
  getMirrorPref?: () => string | undefined;
  /** 音色目录（<models.root>/voices 参考音对；缺省只报默认音色） */
  getVoices?: () => TtsVoiceInfoLike[];
  /** 参考音目录绝对路径（设置页展示「放哪」；缺省不报） */
  getVoicesDir?: () => string;
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
        voicesDir: options.getVoicesDir?.() ?? '',
        say: options.getSayConfig?.() ?? { broadcast: false, voice: '' },
      };
    },

    // ── tts.engines / tts.setEngine ────────────────────────
    /**
     * 引擎清单 + 当前选中（设置页「say 接在哪个引擎」下拉 / TUI /tts 面板的数据源）。
     *
     * 与 status() 分开是有意的：status 依赖 cosyvoice 服务对象，而「该接哪个引擎」
     * 这件事不该因为没有本地服务而被挡住（选了在线引擎时根本不跑 cosyvoice）。
     */
    engines() {
      if (!options.listEngines) throw new Error('engine list not available（该 UI 通道未接入 TTS 工厂）');
      return {
        active: options.getEngineKind?.() ?? 'cosyvoice3',
        engines: options.listEngines(),
      };
    },

    /**
     * 切换 say 使用的 TTS 引擎（写 voice.tts.engine 并持久化）。
     *
     * 生效时机：下一回合 say 取引擎时 —— 工厂按"配置指纹"重建实例，无需重启进程。
     * 只校验 kind 在清单内，不校验 ready：允许先选中再补模型/密钥（UI 会标「未就绪」）。
     */
    setEngine(params: unknown) {
      const kind = (params as { kind?: string } | undefined)?.kind;
      if (!kind || typeof kind !== 'string') throw new Error('tts.setEngine requires "kind"');
      if (!options.setEngineKind) throw new Error('engine switch not available（该 UI 通道未接入配置中心）');
      const allowed = (options.listEngines?.() ?? []).map((e) => e.kind);
      if (allowed.length && !allowed.includes(kind)) {
        throw new Error(`未知引擎 "${kind}"，可选：${allowed.join(' / ')}`);
      }
      options.setEngineKind(kind);
      return { ok: true, active: options.getEngineKind?.() ?? kind };
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
    /**
     * 合成 → WAV base64（服务运行时会自动拉起，冷启动含模型加载可能 30s+）。
     * broadcast=true 时同时广播 tts.say_voice 事件（与 say 工具播报同一条
     * 事件通路）—— 设置页「试听」用它验证真实播报链，而非前端本地播放。
     */
    async synthesize(params: unknown): Promise<{ audioWavBase64: string }> {
      const { text, variant, voice, speed, emotion, broadcast } = (params ?? {}) as {
        text?: string; variant?: 'base' | 'rl'; voice?: string; speed?: number; emotion?: string; broadcast?: boolean;
      };
      if (!text || typeof text !== 'string') throw new Error('tts.synthesize requires "text"');
      // 优先走「当前选中的引擎」—— 切到在线 API / 本地 GGUF 后，试听要听到那家的声音。
      // 未注入时退回 cosyvoice 服务（老通道兼容，行为与改动前一致）。
      let buf: Buffer;
      if (options.synthesizeViaEngine) {
        buf = await options.synthesizeViaEngine(text, { voice, speed, emotion });
      } else {
        syncMirror(service());
        buf = await service().synthesize(text, { variant, voice, speed });
      }
      const audioWavBase64 = buf.toString('base64');
      if (broadcast === true) {
        options.emit?.(UI_EVENT.SAY_VOICE, {
          state: 'ready',
          audioWavBase64,
          textPreview: text.slice(0, 60),
          voice,
          speed,
        });
      }
      return { audioWavBase64 };
    },
  };
}
