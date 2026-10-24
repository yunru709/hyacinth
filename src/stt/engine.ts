/**
 * STT（语音转文字）引擎契约 — 语音输入功能的本地推理面。
 *
 * 选型（2026-10-24）：SenseVoiceSmall（Apache-2.0，中文第一梯队，CPU RTF≈0.07）
 * 经 sherpa-onnx 运行时推理；引擎接口可插拔（whisper.cpp 等留适配位）。
 *
 * 输入约定：**16kHz 单声道 PCM 的 Float32 样本** —— 解码/重采样由前端完成
 * （AudioContext 解 webm/opus → 16k 重采样 → WAV），后端只解析 WAV（stt/wav.ts）。
 */

export interface SttEngineStatus {
  /** 引擎标识 */
  engine: 'sensevoice';
  /** 下载源偏好：auto | hf-mirror | huggingface（经契约域从 models.mirror 配置同步） */
  mirror: string;
  /** sherpa-onnx 运行时（npm 可选依赖）是否可加载 */
  runtimeAvailable: boolean;
  /** 模型文件齐备（可与 runtimeAvailable 双 false：运行时缺时模型状态无从谈起） */
  modelReady: boolean;
  /** 模型目录（诊断用） */
  modelDir: string;
  /** 缺失的模型文件名 */
  missingFiles: string[];
  /** 下载进行中（幂等提示） */
  downloading: boolean;
  /** 下载进度（downloading 时有值） */
  downloadProgress?: { percent: number; received: number; total: number; speed: string; file: string };
  /** 最近一次错误（运行时缺失/下载失败） */
  lastError?: string;
}

export interface SttResult {
  text: string;
  /** 后端推理耗时（不含录音/传输） */
  durationMs: number;
}

export interface SttEngine {
  status(): SttEngineStatus;
  /** 下载缺失的模型文件（幂等；进度经引擎 status 轮询 / 事件回调可见） */
  ensureModel(): Promise<void>;
  /** 删除已下载的模型文件（释放磁盘；源码不携带模型，删除后可随时重新下载） */
  removeModel(): void;
  /** 转写 16kHz 单声道样本 */
  transcribe(samples: Float32Array, sampleRate: number): Promise<SttResult>;
}
