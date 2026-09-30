// ============================================================
// CompanionOutputProtocol —— 陪伴模式的输出协议（模式槽位实现）
// ============================================================
//
// 挂在 CompanionRouter.outputProtocol 上。契约：陪伴模式下模型的
// "表达"必须经 companion_say 工具说出（普通 text 是内心独白）。
// 本协议负责三件事：
//   1. 表达记录：companion_say 工具执行时经 loop.recordCompanionExpression 转发进来
//   2. 回合收尾兜底：模型未按契约调用 companion_say 时（部分模型对工具化表达
//      依从性弱），把普通文本当台词呈现，保证陪伴 UI 不会沉默
//   3. 台词历史落盘 + TTS 钩子（companion.sayHistory / companion.voice 数据源）
// ============================================================

import { UI_EVENT, type CompanionSayEvent } from '../events.js';
import { nextSayId } from '../tools/companion-say.js';
import { getSayHistoryStore } from './say-history.js';
import type { ModeExpression, ModeOutputProtocol, ModeVoiceHook } from '../context/router.js';

export class CompanionOutputProtocol implements ModeOutputProtocol {
  /** 本轮表达缓冲（turn-scoped，resetTurn 清空） */
  private expressions: ModeExpression[] = [];

  constructor(private readonly characterName: () => string) {}

  recordExpression(e: ModeExpression): void {
    this.expressions.push(e);
  }

  resetTurn(): void {
    this.expressions = [];
  }

  getExpressions(): readonly ModeExpression[] {
    return this.expressions;
  }

  async onTurnEnd(ctx: {
    assistantOutput: string;
    emitUiEvent(type: string, payload: unknown): void;
    voice: ModeVoiceHook | null;
  }): Promise<void> {
    // 表达兜底：本轮没有任何表达记录时，普通文本当作台词呈现。
    // 合规模型（已调用 companion_say）不受影响。
    if (this.expressions.length > 0 || !ctx.assistantOutput) return;

    // 兜底与工具路径一致：带 sayId（前端时序守卫依赖），事件名走协议层常量
    const sayId = nextSayId();
    ctx.emitUiEvent(UI_EVENT.COMPANION_SAY, {
      mode: 'speak',
      text: ctx.assistantOutput,
      tone: '',
      at: new Date().toISOString(),
      sayId,
    } satisfies CompanionSayEvent);
    // 兜底路径同样落盘台词历史（companion.sayHistory 数据源；与工具路径共用 sayId）
    getSayHistoryStore().append({
      sayId,
      character: this.characterName(),
      mode: 'speak',
      text: ctx.assistantOutput,
      at: new Date().toISOString(),
    });
    ctx.voice?.onTurnEnd(
      ctx.assistantOutput,
      this.characterName(),
      (type, payload) => ctx.emitUiEvent(type, payload),
      // overrides（第 4 参）：sayId 贯穿事件，供前端时序守卫；
      // cfg 由 factory 装配的包装层每回合现读，无需在此传入
      { sayId },
    );
  }
}
