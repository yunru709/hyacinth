/**
 * exit-policy 单测 —— 出口屏蔽策略（自主模式 P2 后半）。
 *
 * 🔴 本文件的核心回归用例是「provider 原始 finish_reason = 'stop' 也必须被拦」。
 *    2026-11-05 事故：原实现 `if (stopReason !== 'end_turn') return { stop }` 精确匹配字面量，
 *    而 llm 阶段把 provider 的 finish_reason 原样透传（OpenAI 兼容 → 'stop'，
 *    Anthropic → 'end_turn'）⇒ 在 OpenAI 系上自主模式开了也拦不住，纯文本一说完
 *    回合就结束。实测取证：{stop:true, stopReason:"stop", policies:["end_turn-blocked"]}。
 *    改成白名单后，这些用例守着"别再改回精确匹配"。
 */
import { describe, it, expect } from 'vitest';
import {
  createEndTurnBlockPolicy,
  applyExitPolicies,
  END_TURN_BLOCKED_REASON,
} from './exit-policy.js';

describe('createEndTurnBlockPolicy 白名单', () => {
  const policy = createEndTurnBlockPolicy();

  // ── 必须拦：各种"自然结束"的 stopReason 形态 ──
  const mustBlock = [
    ['end_turn', 'Anthropic / finalize 默认值'],
    ['stop', 'OpenAI 兼容 finish_reason（2026-11-05 事故根因）'],
    [undefined, '部分流式实现不给 reason'],
    ['length', '截断（不应静默结束）'],
    ['某个未来新增的 reason', '未知值一律视为自然结束'],
    // ⚠️ 2026-11-06 定调（孑遗）：交付与结束要**按模式区分**。
    //    本策略只在自主模式下被挂上 ⇒ 拦掉它不影响普通模式（那时 policies 为空，
    //    deliver 照常结束回合）。自主模式下 deliver 只把内容送出去、回合继续，
    //    要停必须显式 suspend。
    ['say_submitted', 'deliver 交付：自主模式下不结束回合'],
  ] as const;

  for (const [reason, why] of mustBlock) {
    it(`拦住 stop=true + reason=${String(reason)}（${why}）`, () => {
      const d = policy.gate(true, reason);
      expect(d.stop).toBe(false);
      expect(d.stopReason).toBe(END_TURN_BLOCKED_REASON);
      expect(d.message).toBeTruthy(); // 必须告诉模型"为什么停不下来"
      expect(d.warn).toBe(true);
    });
  }

  // ── 必须放行：显式声明的出口 ──
  const mustAllow = [
    'suspended',            // suspend 工具（自主模式唯一的正常出口）
    'say_failed',           // say 中止：错误态，不该被要求改成 suspend
    'goal_achieved',
    'goal_budget_exceeded',
  ];

  for (const reason of mustAllow) {
    it(`放行显式出口 reason=${reason}`, () => {
      const d = policy.gate(true, reason);
      expect(d.stop).toBe(true);
      expect(d.stopReason).toBe(reason);
      expect(d.message).toBeUndefined();
    });
  }

  it('stop=false 时原样放行（不参与判停）', () => {
    const d = policy.gate(false, 'end_turn');
    expect(d.stop).toBe(false);
    expect(d.message).toBeUndefined();
  });

  it('自定义 hint 会替代默认提示语', () => {
    const d = createEndTurnBlockPolicy('自定义提示').gate(true, 'stop');
    expect(d.message).toBe('自定义提示');
  });
});

describe('applyExitPolicies 链式判定', () => {
  it('空策略链 → 原样放行（零回归）', () => {
    const r = applyExitPolicies([], true, 'end_turn');
    expect(r.stop).toBe(true);
    expect(r.stopReason).toBe('end_turn');
  });

  it('有屏蔽策略 + reason=stop → stop 被改回 false', () => {
    const r = applyExitPolicies([createEndTurnBlockPolicy()], true, 'stop');
    expect(r.stop).toBe(false);
    expect(r.stopReason).toBe(END_TURN_BLOCKED_REASON);
  });
});
