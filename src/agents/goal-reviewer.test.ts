/**
 * goal-reviewer 裁决解析单测 —— 守 2026-10-10 修的那个缺陷：
 * 判据必须是「目标是否达成」，而不是「证据是否支持结论」。
 *
 * 这里只测纯函数 parseVerdict（不拉起子 agent）：`objective_achieved` 必须**严格 === true**
 * 才算达成 —— 缺失 / 类型不对一律 false（保守），loop 侧据此拦下「诚实的负面报告」。
 */

import { describe, it, expect } from 'vitest';
import { parseVerdict, GOAL_REVIEWER_TOOLS } from './goal-reviewer.js';

describe('parseVerdict', () => {
  it('目标达成 + pass → 解析出 objectiveAchieved=true', () => {
    const r = parseVerdict('{"objective_achieved":true,"verdict":"pass","reason":"指标达标"}');
    expect(r).toEqual({ verdict: 'pass', reason: '指标达标', objectiveAchieved: true });
  });

  it('诚实负面报告（未达成）→ objectiveAchieved=false', () => {
    const r = parseVerdict('{"objective_achieved":false,"verdict":"fail","reason":"目标未达成"}');
    expect(r?.verdict).toBe('fail');
    expect(r?.objectiveAchieved).toBe(false);
  });

  it('判绿但没确认达成（objective_achieved 缺失/false）→ objectiveAchieved=false（这是关键回归点）', () => {
    expect(parseVerdict('{"verdict":"pass","reason":"证据支持结论"}')?.objectiveAchieved).toBe(false);
    expect(parseVerdict('{"verdict":"pass","objective_achieved":false,"reason":"x"}')?.objectiveAchieved).toBe(false);
    // 类型不对（字符串 "true"）也不算达成 —— 严格相等
    expect(parseVerdict('{"verdict":"pass","objective_achieved":"true","reason":"x"}')?.objectiveAchieved).toBe(false);
  });

  it('容忍 ```json 围栏与前后杂字', () => {
    const r = parseVerdict('先说明一下：\n```json\n{"objective_achieved":true,"verdict":"pass","reason":"ok"}\n```\n完。');
    expect(r?.objectiveAchieved).toBe(true);
    expect(r?.verdict).toBe('pass');
  });

  it('无法解析 / verdict 非法 → null', () => {
    expect(parseVerdict('没有 JSON')).toBeNull();
    expect(parseVerdict('{"verdict":"maybe","reason":"x"}')).toBeNull();
    expect(parseVerdict('{ 坏 json }')).toBeNull();
  });
});

describe('审查官工具白名单', () => {
  it('能读能跑，但不给写（审查官不该改东西）', () => {
    expect([...GOAL_REVIEWER_TOOLS].sort()).toEqual(['bash', 'glob', 'grep', 'read']);
    expect(GOAL_REVIEWER_TOOLS).not.toContain('write');
    expect(GOAL_REVIEWER_TOOLS).not.toContain('edit');
  });
});
