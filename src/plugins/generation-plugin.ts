/**
 * Generation 插件（P3 第二个功能插件）—— 把陪伴台词 TTS 装配从 factory 迁为插件。
 *
 * 原为 gateway/factory.ts 的 ~32 行内联装配（781-812）：GenerationRegistry.load +
 * GenerationService + CompanionVoiceService 包装成 loop.companionVoice（仅
 * companion.tts.enabled 时创建）。
 *
 * 插件化后：
 * - 模块留在 src/generation/ + src/companion/voice.ts（引擎不动），本文件提供 HyPlugin
 * - activate 时装配 GenerationRegistry/Service/CompanionVoiceService，注册
 *   'generation.api' 服务句柄（含 tts 工厂回调），factory 取回后写回 loop.companionVoice
 * - 与工厂内联装配行为等价：仅 TTS 启用时创建；overrides 每回合现读 config
 * - 场景渲染（SCENE_RENDER_TOOL/executeSceneRender/getSceneDir）是纯函数，
 *   被 media-routes/companion agent 直接 import，天然独立，不属于本插件范围
 */
import type { HyPlugin, PluginContext } from '../kernel/plugin-host.js';
import type { LoopHooks } from '../orchestrator/loop-hooks.js';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import type { GenerationRegistry, GenerationService } from '../generation/index.js';
import type { CompanionVoiceService } from '../companion/voice.js';

export const GENERATION_PLUGIN_ID = 'generation';

export interface GenerationPluginServices {
  cwd: string;
  configCenter?: RuntimeConfigCenter;
}

/**
 * TTS 装配结果：factory 取回后直接赋给 loop.companionVoice（签名完全对齐）。
 * 第 4 参 overrides 只承载 sayId 等事件贯通字段；语音/供应商/容量等配置
 * 由插件闭包在每回合现读 configCenter（与工厂原包装层一致）。
 */
export interface GenerationTtsHandle {
  onTurnEnd(
    text: string,
    character: string,
    notify: (type: string, payload?: unknown) => void,
    overrides?: { voice?: string; voiceId?: string; tone?: string; sayId?: string },
  ): void;
}

/** Generation 插件对外服务句柄 */
export interface GenerationApi {
  /** TTS 服务实例（CompanionVoiceService 内部持有；供 factory 写回 loop） */
  tts: GenerationTtsHandle | null;
}

export const GENERATION_API_KEY = 'generation.api';

export function createGenerationPlugin(
  services: GenerationPluginServices,
): HyPlugin<Record<string, unknown>, LoopHooks> {
  return {
    id: GENERATION_PLUGIN_ID,

    async activate(ctx: PluginContext<Record<string, unknown>, LoopHooks>) {
      const { cwd, configCenter } = services;
      // 仅 TTS 启用时装配（与工厂一致：不启用则不创建，零开销）
      if (!configCenter?.get<boolean>('companion.tts.enabled')) {
        ctx.logger.info('generation plugin: companion.tts disabled, idle');
        ctx.register(GENERATION_API_KEY, { tts: null });
        return;
      }

      const { GenerationRegistry, GenerationService } = await import('../generation/index.js');
      const { CompanionVoiceService } = await import('../companion/voice.js');
      const genRegistry = GenerationRegistry.load(cwd);
      const genService = new GenerationService(genRegistry, cwd);
      const companionVoice = new CompanionVoiceService({ registry: genRegistry, service: genService, cwd });

      const tts: GenerationTtsHandle = {
        onTurnEnd: (text, character, notify, overrides) => {
          // 每回合现读配置：运行时 config.set 即时生效（无需重启）
          if (!configCenter?.get<boolean>('companion.tts.enabled')) return;
          companionVoice.onTurnEnd(
            text,
            character,
            notify,
            {
              enabled: true,
              voice: configCenter?.get<string>('companion.tts.voice') || undefined,
              provider: configCenter?.get<string>('companion.tts.provider') || undefined,
              // 容量治理：每角色保留最近 N 条（0 = 不清理）；未配置时域内回退默认值
              keepPerCharacter:
                configCenter?.get<number>('companion.tts.keepPerCharacter') ?? undefined,
            },
            overrides,
          );
        },
      };

      ctx.register(GENERATION_API_KEY, { tts } satisfies GenerationApi);
      ctx.logger.info('generation plugin activated: companion TTS ready');
    },
  };
}
