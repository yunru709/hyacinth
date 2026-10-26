/**
 * CosyVoice3 本地引擎适配 — 把现有重服务包成 `TtsEngine`。
 *
 * 【这一层只做「契约适配」，不搬运行逻辑】
 *   模型下载 / Python venv 探测 / 子进程启停 / 端口 3178 仍归 `../cosyvoice.ts`。
 *   换引擎时业务层只认 `TtsEngine`，不碰这些。这正是 2026-10-26 解耦的目的。
 *
 * 【能力声明：emotion 不支持，如实报 false】
 *   实测（2026-10-26，STT 闭环）CosyVoice3 的 `inference_instruct2` 会把**指令本身
 *   朗读出来**：输入「用温柔的语气说这句话」+ 正文，转写结果是「用温柔的语气说这句话，
 *   今天天气不错…」。根因是 `frontend_instruct2` 删掉 `llm_prompt_speech_token` 后，
 *   模型失去「指令这段已经说过了」的锚点。
 *   ⇒ 按孑遗定调：**不支持就不支持，让参数不被使用**，不做"映射成语速"这类妥协。
 *   详见 `engines/cosyvoice/server.py` 里 _EMO_SPEED 附近的实验记录。
 */
import { getTtsService, listVoices } from '../cosyvoice.js';
import type { TtsCapabilities, TtsEngine } from '../engine.js';

export function createCosyVoiceEngine(): TtsEngine {
  const svc = getTtsService();
  return {
    id: 'cosyvoice3',
    kind: 'local',
    voices: () => listVoices(),
    // emotion 有意不传：本引擎不支持（见文件头注释）。传了也只是被丢弃。
    synthesize: (text, opts = {}) =>
      svc.synthesize(text, { voice: opts.voice, speed: opts.speed }),
    capabilities: (): TtsCapabilities => ({ voice: true, speed: true, emotion: false }),
    status: () => {
      const st = svc.serviceState();
      return {
        ready: st.running,
        detail: st.running
          ? `本地 CosyVoice3 运行中（端口 ${st.port}）`
          : '未启动（首次合成时自动拉起，约 40s）',
        lastError: st.lastError,
      };
    },
  };
}
