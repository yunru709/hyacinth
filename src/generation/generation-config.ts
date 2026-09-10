import type { RuntimeConfigCenter } from '../runtime/config-center.js';

/**
 * 生成配置出口 — generation 服务与适配器的轮询/音色/格式默认值走 configCenter（generation.* 键）。
 *
 * 模式与 tools/tool-config.ts、context/context-config.ts 一致：factory.ts 初始化
 * configCenter 后注入；注入前（bootstrap / 单测）回退硬编码默认值，零行为变化。
 *
 * 键位约定（schema/defaults 同步登记）：
 *   generation.pollIntervalMs        图片等同步态任务轮询间隔（默认 3000）
 *   generation.videoPollIntervalMs   视频任务轮询间隔（默认 15000）
 *   generation.maxPollAttempts       最大轮询次数（默认 600 ≈ 2.5h 视频上限）
 *   generation.minimaxDefaultVoiceId MiniMax T2A 默认音色（默认 moss_audio_…）
 *   generation.minimaxAudioFormat    MiniMax T2A 音频格式（默认 mp3）
 */

let _configCenter: RuntimeConfigCenter | null = null;

/** 注入 RuntimeConfigCenter（factory.ts 初始化后调用）；传 null 还原（测试用） */
export function injectGenerationConfigCenter(cc: RuntimeConfigCenter | null): void {
  _configCenter = cc;
}

/** 读取 generation 配置键，未注入/未配置/异常一律回退 fallback */
export function getGenerationConfig<T>(key: string, fallback: T): T {
  if (!_configCenter) return fallback;
  try {
    const v = _configCenter.get<T>(`generation.${key}`);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// ── 便捷读取（各消费点专用）───────────────────────────────────────────

export function pollIntervalMs(): number {
  return getGenerationConfig<number>('pollIntervalMs', 3000);
}

export function videoPollIntervalMs(): number {
  return getGenerationConfig<number>('videoPollIntervalMs', 15000);
}

export function maxPollAttempts(): number {
  return getGenerationConfig<number>('maxPollAttempts', 600);
}

export function minimaxDefaultVoiceId(): string {
  return getGenerationConfig<string>(
    'minimaxDefaultVoiceId',
    'moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85',
  );
}

export function minimaxAudioFormat(): string {
  return getGenerationConfig<string>('minimaxAudioFormat', 'mp3');
}
