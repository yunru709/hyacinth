/**
 * CompanionVoiceService — 陪伴模式台词语音合成（TTS）。
 *
 * 职责：companion_say 表达时，把台词合成为语音，写入生成语音库
 * （角色-文本-情绪 索引），通过事件推给 UI 播放/重放。
 *
 * 双轨 TTS：供应商走生成层 defaults.audio_tts（云端 minimax /
 * openai-compatible，或本地 IndexTTS2 薄壳），切换只改 generation.json。
 *
 * 数据链（两个库）：
 *   - 音色库 VoiceLibrary（参考声音，输入侧）：voice 解析
 *     say.voice → 角色 bind → config 兜底
 *   - 生成语音库 GeneratedVoiceStore（输出侧）：唯一键
 *     (character, text_hash, emotion_key, voice_id) → 命中秒回（不烧 TTS）
 *
 * 设计约束：串行队列（忙时只留最新台词）；失败静默不影响对话主流程。
 */

import { createHash } from 'node:crypto';
import type { GenerationRegistry, GenerationService } from '../generation/index.js';
import type { GenerationRequest } from '../generation/interface.js';
import {
  GeneratedVoiceStore,
  getGeneratedVoiceStore,
  DEFAULT_KEEP_PER_CHARACTER,
  type GeneratedVoiceRow,
} from './voice-store.js';

/** 容量治理默认值（定义在 voice-store，此处重导出，保持对外 API） */
export { DEFAULT_KEEP_PER_CHARACTER };
import { getVoiceLibrary } from './voice-library.js';
import { createLogger } from '../logging/logger.js';
import { UI_EVENT, type CompanionVoiceEvent } from '../events.js';

const logger = createLogger('companion:voice');

/**
 * 合成事件的接收方（loop 里包一层 outputHandler.onEvent 转发给 UI）。
 *
 * 载荷按 CompanionVoiceEvent 契约约束。此前签名是
 * `(type: string, payload?: unknown)`，整条链路零约束 —— 字段拼错、
 * 漏传、多余字段都无法在编译期发现（`voiceId` 就是因此被 emit 了却
 * 未登记进契约）。语音通道只推 companion.voice 一种事件，故类型上
 * 直接体现，一处收紧即可约束全部调用点。
 */
export type VoiceNotify = (
  type: typeof UI_EVENT.COMPANION_VOICE,
  payload: CompanionVoiceEvent,
) => void;

/** 语音合成配置（configCenter 的 companion.tts 节） */
export interface CompanionTtsConfig {
  enabled: boolean;
  /** 兜底音色（库解析链最后一级；云供应商原生音色名或本地参考音频路径） */
  voice?: string;
  /** 覆盖供应商（空则用 generation.json 的 defaults.audio_tts） */
  provider?: string;
  /**
   * 容量治理：每角色保留最近多少条生成语音（0 = 不清理）。
   * 未配置时用 DEFAULT_KEEP_PER_CHARACTER。
   */
  keepPerCharacter?: number;
}

/*
 * 容量治理说明：生成语音是**缓存**而非资产 —— 台词文本仍在，删掉后角色再说
 * 同一句会重新合成。因此库必须有上限，否则随对话无限增长（每句新台词一条）。
 * 默认每角色保留 300 条（约 30~70MB），兼顾缓存命中率与磁盘占用。
 */

/** 每次表达的音色覆盖（companion_say 参数解析结果） */
export interface VoiceOverride {
  /** 音色库条目 id（入库索引） */
  voiceId?: string;
  /** 合成用音色引用（本地=参考音频绝对路径；云端=供应商音色名） */
  voice?: string;
  tone?: string;
  /**
   * 表达唯一标识：companion.say（文字）与 companion.voice（语音）共用，
   * 语音事件原样带回。前端据此丢弃"过期语音"——TTS 异步合成（长句可达
   * 数分钟），文字早已上屏、语音迟到，播放前必须确认它还对应屏幕上这句。
   */
  sayId?: string;
}

/** 依赖最小接口（便于测试注入） */
export interface VoiceServiceDeps {
  registry: GenerationRegistry;
  service: GenerationService;
  /** 生成语音库（默认全局实例；测试注入临时目录实例） */
  store?: GeneratedVoiceStore;
  cwd: string;
}

/** 单条合成任务的最长文本（台词过长截断，控制成本与时长） */
const MAX_TEXT_LEN = 500;

/** 规范化情绪索引值：trim + 折叠空白 */
function normalizeEmotion(tone?: string): string {
  return (tone ?? '').trim().replace(/\s+/g, ' ');
}

export class CompanionVoiceService {
  private busy = false;
  private pending: {
    text: string;
    character: string;
    overrides?: VoiceOverride;
  } | null = null;
  private store: GeneratedVoiceStore;

  constructor(private deps: VoiceServiceDeps) {
    this.store = deps.store ?? getGeneratedVoiceStore();
  }

  /**
   * 表达工具的语音入口。fire-and-forget：内部排队，绝不抛出、不阻塞回合。
   * @param text      台词（调用方已 normalizeForTts）
   * @param character 当前陪伴角色
   * @param notify    事件转发（UI）
   * @param cfg       本次合成配置（工厂每回合现读传入）
   * @param overrides 音色覆盖（say.voice 解析结果：库条目 → {voiceId, voice}）
   */
  onTurnEnd(
    text: string,
    character: string,
    notify: VoiceNotify,
    cfg: CompanionTtsConfig,
    overrides?: VoiceOverride,
  ): void {
    const clean = (text || '').trim().slice(0, MAX_TEXT_LEN);
    if (!clean) return;

    if (this.busy) {
      // 忙时只保留最新台词（旧台词跳过不补播）
      this.pending = { text: clean, character, overrides };
      return;
    }
    this.busy = true;
    void this.synthesizeLoop(clean, character, notify, cfg, overrides);
  }

  private async synthesizeLoop(
    firstText: string,
    character: string,
    notify: VoiceNotify,
    cfg: CompanionTtsConfig,
    overrides?: VoiceOverride,
  ): Promise<void> {
    let current: {
      text: string;
      character: string;
      overrides?: VoiceOverride;
    } = { text: firstText, character, overrides };
    try {
      for (;;) {
        await this.synthesizeOnce(current.text, current.character, notify, cfg, current.overrides);
        if (!this.pending) break;
        const next = this.pending;
        this.pending = null;
        current = next;
      }
    } finally {
      this.busy = false;
    }
  }

  private async synthesizeOnce(
    text: string,
    character: string,
    notify: VoiceNotify,
    cfg: CompanionTtsConfig,
    overrides?: VoiceOverride,
  ): Promise<void> {
    try {
      const providerName =
        cfg.provider || this.deps.registry.getDefaultProviderName('audio_tts');
      if (!providerName) {
        notify(UI_EVENT.COMPANION_VOICE, {
          state: 'error',
          message:
            '未配置 TTS 供应商：请在 generation.json 配置 providers + defaults.audio_tts' +
            '（本地可用 openai-compatible 指向本地 TTS 服务器）',
        });
        return;
      }

      // 音色解析链：表达覆盖 → config 兜底（库解析在工具侧已完成 voiceId/voice 配对）
      const voice = overrides?.voice || cfg.voice || '';
      const voiceId = overrides?.voiceId || (cfg.voice && !overrides?.voice ? 'config:' + cfg.voice : '');
      const emotionKey = normalizeEmotion(overrides?.tone);
      const textHash = createHash('sha256').update(text).digest('hex').slice(0, 16);

      // ── 生成语音库：命中直接复用（角色-文本-情绪-音色 去重，不烧 TTS）──
      const cached = this.store.find(character, textHash, emotionKey, voiceId);
      if (cached) {
        logger.info('voice cache hit', { character, mediaId: cached.id, emotionKey });
        notify(UI_EVENT.COMPANION_VOICE, {
          state: 'ready',
          url: `/api/companion/voice/${cached.id}/file`,
          voiceId: cached.voiceId,
          character,
          provider: cached.provider,
          tone: overrides?.tone,
          cached: true,
          textPreview: text.slice(0, 60),
          ...(overrides?.sayId ? { sayId: overrides.sayId } : {}),
        });
        return;
      }

      const req: GenerationRequest = {
        provider: providerName,
        taskType: 'audio_tts',
        prompt: text,
        ...(voice ? { voice } : {}),
        ...(emotionKey || overrides?.tone ? { emotion: overrides?.tone || emotionKey } : {}),
      };
      const artifact = await this.deps.service.generate(req);

      // 落生成语音库（文件收纳进 <角色>/ 目录 + 索引入库）
      const row = this.store.insert(artifact.localPath, {
        character: character || 'default',
        textNorm: text,
        textHash,
        emotionKey,
        emotionRaw: overrides?.tone,
        voiceId: voiceId || '',
        voiceName: overrides?.voice,
        provider: artifact.provider,
        model: artifact.model,
        format: artifact.mediaType.includes('wav') ? 'wav' : artifact.mediaType.split('/')[1] || 'wav',
        byteSize: artifact.byteSize,
      });

      // 容量治理：落库后按角色保留最近 N 条（缓存可重建，超出的清理掉）
      this.pruneIfNeeded(character || 'default', cfg.keepPerCharacter);

      logger.info('voice synthesized', {
        character,
        provider: artifact.provider,
        voiceId: row.id,
      });
      notify(UI_EVENT.COMPANION_VOICE, {
        state: 'ready',
        url: `/api/companion/voice/${row.id}/file`,
        character,
        provider: artifact.provider,
        tone: overrides?.tone,
        textPreview: text.slice(0, 60),
        ...(overrides?.sayId ? { sayId: overrides.sayId } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('voice synthesis failed', { error: msg });
      notify(UI_EVENT.COMPANION_VOICE, {
        state: 'error',
        message: `语音合成失败: ${msg}`,
        ...(overrides?.sayId ? { sayId: overrides.sayId } : {}),
      });
    }
  }

  /**
   * 容量治理：按角色保留最近 keep 条，超出的条目与音频文件一并删除。
   * keep <= 0 = 不清理。仅在成功落库后调用（缓存命中不新增条目，无需清理）。
   * 清理失败不影响本次播放——库会稍大，下次落库再试。
   */
  private pruneIfNeeded(character: string, keep?: number): void {
    const n = keep ?? DEFAULT_KEEP_PER_CHARACTER;
    if (n <= 0) return;
    try {
      const removed = this.store.prune(character, n);
      if (removed > 0) {
        logger.info('voice pruned', { character, keep: n, removed });
      }
    } catch (err) {
      logger.warn('voice prune failed', {
        character,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
