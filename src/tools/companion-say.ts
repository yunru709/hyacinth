/**
 * companion_say — 陪伴模式表达工具（主 agent 的唯一"开口"通道）。
 *
 * 设计原则：工具极简（四个参数、一句话描述），使用规范靠 soul 提示词里的
 * 少样本示例示范——LLM 天然模仿示例格式，不需要冗长描述。
 *
 * 参数（语气 / 内心活动 / 具体内容 / 额外动作）：
 *   - text   具体内容：说的话（上屏 + TTS 朗读）
 *   - tone   语气（随台词展示，TTS 情感透传留作扩展）
 *   - think  内心活动（仅 UI，渲染为（…），不朗读）
 *   - action 额外动作（仅 UI，渲染为[…]，不朗读）
 *
 * 渲染格式：[动作]（内心）内容
 * 表达同时捕获到 loop 回合级缓冲，postTurn 时旁路用它维护世界。
 */

import type { AgentLoop } from '../orchestrator/loop.js';
import type { Tool } from './interface.js';
import { normalizeForTts } from '../companion/normalize.js';
import { getVoiceLibrary } from '../companion/voice-library.js';
import { getSayHistoryStore } from '../companion/say-history.js';
import { UI_EVENT, type CompanionSayEvent } from '../events.js';

/**
 * sayId：每次表达的唯一标识，贯穿 companion.say（文字）与 companion.voice（语音）
 * 两个事件。TTS 合成是异步的（长句可达数分钟），文字早已上屏、语音迟到——
 * 前端靠比对 sayId 丢弃"过期语音"，避免播放与屏幕文字对不上的声音。
 */
let saySeq = 0;
function nextSayId(): string {
  return `say_${Date.now().toString(36)}_${++saySeq}`;
}

/** 供 loop 兜底路径复用（模型未调工具时把普通文本包装成表达） */
export { nextSayId };

/** UI 渲染格式：[动作]（内心）内容（各段可选） */
export function composeCompanionRender(input: {
  text?: string;
  think?: string;
  action?: string;
}): string {
  const parts: string[] = [];
  const action = (input.action ?? '').trim();
  const think = (input.think ?? '').trim();
  const text = (input.text ?? '').trim();
  if (action) parts.push(`[${action}]`);
  if (think) parts.push(`（${think}）`);
  if (text) parts.push(text);
  return parts.join('');
}

export function createCompanionSayTool(agentLoop: AgentLoop): Tool {
  return {
    name: 'companion_say',
    description: '把你此刻的表达（话语/动作/心声）传递给对方。',
    /** 陪伴专属：普通模式硬隔离（不可见也不可用） */
    companionOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '具体内容：说出口的话（口语化）',
        },
        tone: {
          type: 'string',
          description: '语气',
        },
        think: {
          type: 'string',
          description: '内心活动（对方听不到，只展示）',
        },
        action: {
          type: 'string',
          description: '额外动作（对方看得到，不朗读）',
        },
        voice: {
          type: 'string',
          description:
            '音色覆盖（音色库 id 或文件名；音色由用户在设置页登记管理）。省略则用角色绑定的默认音色。',
        },
      },
      required: ['text'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      // 运行时守卫：非陪伴模式拒绝执行（双保险，配合 companionOnly 可见性隔离）
      const routerName = (agentLoop.activeRouter as { name?: string } | undefined)?.name;
      if (routerName !== 'companion') {
        return 'error: companion_say 仅在陪伴模式可用。';
      }

      const text = String(args.text ?? '').trim();
      const tone = String(args.tone ?? '').trim();
      const think = String(args.think ?? '').trim();
      const action = String(args.action ?? '').trim();
      const voice = String(args.voice ?? '').trim();
      if (!text && !think && !action) {
        return 'error: 表达内容不能为空（text/think/action 至少一项）';
      }

      // ① UI 渲染：[动作]（内心）内容
      const render = composeCompanionRender({ text, think, action });
      const sayId = nextSayId();
      const character =
        (agentLoop.activeRouter as { activeCompanionName?: string } | undefined)?.activeCompanionName || '';
      agentLoop.emitUiEvent?.(UI_EVENT.COMPANION_SAY, {
        text: render,
        tone,
        at: new Date().toISOString(),
        sayId,
      } satisfies CompanionSayEvent);

      // ①b 台词历史落盘（companion.sayHistory 数据源；刷新后可恢复台词对话）
      getSayHistoryStore().append({
        sayId,
        character,
        mode: 'speak',
        text: text || render,
        tone: tone || undefined,
        think: think || undefined,
        action: action || undefined,
        at: new Date().toISOString(),
      });

      // ② 回合级捕获：postTurn 时旁路 agent 拿它维护世界
      agentLoop.recordCompanionExpression?.({ text: text || render, as: 'speak', tone: tone || undefined });

      // ③ 语音：只朗读具体内容（动作/心声不朗读）。
      // 音色解析链：voice 参数（库 id/文件名/绝对路径）→ 角色绑定 → config 兜底
      if (text) {
        const spoken = normalizeForTts(text);
        if (spoken) {
          const overrides: { voice?: string; voiceId?: string; tone?: string; sayId: string } = {
            tone: tone || undefined,
            sayId,
          };
          if (voice) {
            const resolved = getVoiceLibrary().resolveRef(voice);
            if (resolved) {
              overrides.voice = resolved.path;
              overrides.voiceId = resolved.entry?.id;
            }
            // 解析不到 → 落到下面用角色默认音色。
            // 音色只是表达方式，不该因为找不到就打断这一句。
          }
          if (!overrides.voice) {
            const bound = getVoiceLibrary().resolveForCharacter(character);
            if (bound) {
              const p = getVoiceLibrary().fileOf(bound);
              if (p) {
                overrides.voice = p;
                overrides.voiceId = bound.id;
              }
            }
          }
          agentLoop.companionVoice?.onTurnEnd(
            spoken,
            character,
            (type, payload) => agentLoop.emitUiEvent?.(type, payload),
            overrides,
          );
        }
      }

      return '已表达。';
    },
  };
}
