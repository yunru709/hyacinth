/**
 * TTS（文本转语音）引擎契约 — say 工具背后的可替换推理面。
 *
 * 【为什么要有这一层】（2026-10-26 孑遗定调）
 *   say 工具是**架构自带的能力**，底下用什么 TTS 引擎是**可换的**：
 *   本地重引擎（CosyVoice3 / Breeze-TTS-2 GGUF）、在线 API（Breeze / OpenAI 系）
 *   都只是实现。**不能把具体模型及其运行环境（Python venv、子进程、端口、
 *   模型权重路径）写进业务层**，否则换一个引擎就要改插件和 say 工具。
 *
 * 【三层结构】（对齐 src/stt 的既有分层，别另起一套）
 *   engine.ts          ← 本文件：契约 + 能力声明
 *   engines/*.ts       ← 各实现（cosyvoice.ts / breeze-tts2.ts / online.ts）
 *   index.ts           ← createTtsEngine(config)：按配置选实现 + 单例缓存
 *
 * 【能力自描述是硬要求】
 *   不同引擎支持的参数不同：本地 CosyVoice3 **不支持 emotion**（实测 instruct2
 *   会把指令本身念出来），在线 Breeze 支持（`instructions` 字段）。
 *   ⇒ 用 `capabilities()` 显式声明，不支持的参数**静默忽略**，绝不"硬上"
 *   （把 emotion 映射成语速那种妥协已撤销）。调用方据此决定是否提供该参数。
 */

/** 音色目录条目（say 的 voice 参数取值域 + 设置页下拉数据源） */
export interface TtsVoiceInfo {
  id: string;
  label: string;
}

/** 合成参数。引擎按 capabilities() 自行忽略不支持的项 */
export interface TtsSynthesizeOptions {
  /** 音色 id（各引擎自己的取值域） */
  voice?: string;
  /** 语速倍率，1 = 原速 */
  speed?: number;
  /** 情绪/语气描述。仅声明 emotion:true 的引擎会用到 */
  emotion?: string;
}

/** 引擎能力声明 —— 调用方据此判断某个参数是否有效 */
export interface TtsCapabilities {
  voice: boolean;
  speed: boolean;
  emotion: boolean;
}

/** 引擎运行态（本地引擎报模型/子进程状态；在线引擎报连通性） */
export interface TtsEngineStatus {
  /** 引擎是否可用（本地=模型就绪且服务在跑；在线=配置完整） */
  ready: boolean;
  /** 人类可读的一句话说明（诊断/设置页展示） */
  detail: string;
  /** 最近一次错误 */
  lastError?: string;
}

export interface TtsEngine {
  /** 引擎标识：'cosyvoice3' | 'breeze-tts2' | 'breeze-online' | 'openai-compatible' */
  id: string;
  /** local = 本机推理（可能起子进程）；remote = 走网络 API */
  kind: 'local' | 'remote';
  /** 可用音色目录。**必须同步返回**：调用方（ui-protocol / 设置页）是同步取值的 */
  voices(): TtsVoiceInfo[];
  /** 合成 → WAV Buffer。失败抛错（含可读原因） */
  synthesize(text: string, opts?: TtsSynthesizeOptions): Promise<Buffer>;
  /** 能力声明。未声明 = 视为不支持 */
  capabilities(): TtsCapabilities;
  /** 运行态（可选：在线引擎未配置时就该报出来，而不是等合成失败） */
  status?(): TtsEngineStatus;

  /**
   * 释放本引擎占用的**进程级资源**（子进程 / 显存 / 端口）。
   *
   * 【为什么必须存在】2026-10-26 事故：`voice.tts.engine` 从 cosyvoice3 切到
   * breeze-tts-2 后，旧引擎的 Python 服务**没人停**，与 breeze 的 3.7GB 权重
   * 同时驻留，实测 7167/8188 MiB —— 8GB 卡离 OOM 一步。切引擎必须「先放旧的」。
   *
   * 约定：
   *   · **同步优先**：`getTtsEngine` 是同步函数（say 高频调用），不能 await。
   *   · 认领来的外部实例不该被 kill（见 CosyVoiceService.adopted），尽力而为即可。
   *   · 无进程资源的引擎（在线 API）**不要实现**这个方法。
   */
  dispose?(): void;

  /**
   * 预热：把本地服务提前拉起来（切换引擎 / 插件挂载时调用）。
   *
   * 与 `dispose` 成对：切换引擎时「旧的 dispose、新的 warmup」。
   * 必须**异步且可失败** —— 调用方 fire-and-forget，失败只留痕不影响回合。
   * 无本地服务的引擎（在线 API）不要实现。
   */
  warmup?(): Promise<void>;
}
