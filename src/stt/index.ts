/**
 * STT 模块入口 — 语音转文字服务的进程级单例。
 *
 * 与 companion/voice-library 的单例模式一致：serve 进程共享一个引擎实例
 * （模型 230MB + 识别器初始化只做一次，多会话/多 UI 复用同一推理面）。
 * 分层说明：本模块是业务核心；契约域（ui-protocol/domains/stt.ts）经
 * backend 注入门面消费，不反向依赖。
 */

import { SenseVoiceEngine } from './engines/sensevoice.js';
import type { SttEngine } from './engine.js';

let instance: SttEngine | null = null;

export function getSttService(): SttEngine {
  instance ??= new SenseVoiceEngine();
  return instance;
}
