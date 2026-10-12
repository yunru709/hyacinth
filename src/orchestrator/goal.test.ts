/**
 * goal 模式内核单测（src/orchestrator/goal.ts）——
 * 出口闸门判定、禁用/强制可见清单、落盘往返。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGoalState, decideGoalGate, isToolForbiddenInGoal, isToolForcedVisibleInGoal,
  loadGoalState, saveGoalState, DEFAULT_GOAL_BUDGET,
  GOAL_FORBIDDEN_TOOLS, GOAL_FORCED_VISIBLE_TOOLS,
  GOAL_PENDING_REASON, GOAL_ACHIEVED_REASON, GOAL_BUDGET_EXCEEDED_REASON,
  type GoalState,
} from './goal.js';

describe('goal 出口闸门', () => {
  it('未激活 → 原样放行（不干预）', () => {
    const d = decideGoalGate(true, 'end_turn', null);
    expect(d.stop).toBe(true);
    expect(d.stopReason).toBe('end_turn');
    expect(d.message).toBeNull();
  });

  it('激活且想停 → 拽回继续（stop=false + goal_pending + 注入续跑消息）', () => {
    const st = createGoalState('把 X 做完', 'user');
    const d = decideGoalGate(true, 'end_turn', st);
    expect(d.stop).toBe(false);
    expect(d.stopReason).toBe(GOAL_PENDING_REASON);
    expect(d.message).toContain('把 X 做完');
    expect(d.message).toContain('finish_goal');
  });

  it('已验收通过（goal_achieved）→ 放行，不被拽回', () => {
    const st = createGoalState('把 X 做完', 'user');
    const d = decideGoalGate(true, GOAL_ACHIEVED_REASON, st);
    expect(d.stop).toBe(true);
    expect(d.stopReason).toBe(GOAL_ACHIEVED_REASON);
    expect(d.message).toBeNull();
  });

  it('本轮本来就继续（stop=false）→ 不干预', () => {
    const st = createGoalState('把 X 做完', 'user');
    const d = decideGoalGate(false, undefined, st);
    expect(d.stop).toBe(false);
    expect(d.message).toBeNull();
  });

  it('预算触顶 → 放行 + goal_budget_exceeded（不允许永久锁死）', () => {
    const st: GoalState = { ...createGoalState('把 X 做完', 'agent'), nudges: DEFAULT_GOAL_BUDGET.maxNudges };
    const d = decideGoalGate(true, 'end_turn', st);
    expect(d.stop).toBe(true);
    expect(d.stopReason).toBe(GOAL_BUDGET_EXCEEDED_REASON);
    expect(d.message).toContain('预算触顶');
  });

  it('审查次数触顶 → 同样放行', () => {
    const st: GoalState = { ...createGoalState('把 X 做完', 'agent'), reviewAttempts: DEFAULT_GOAL_BUDGET.maxReviews };
    const d = decideGoalGate(true, 'end_turn', st);
    expect(d.stop).toBe(true);
    expect(d.stopReason).toBe(GOAL_BUDGET_EXCEEDED_REASON);
  });
});

describe('goal 工具管制清单', () => {
  it('禁掉「宣布完成 / 换环境」类', () => {
    for (const name of ['say', 'send_channel_message', 'switch_mode', 'companion_mode',
      'new_session', 'switch_session', 'delete_session', 'session_fork',
      'update_config', 'reset_config', 'switch_provider', 'toggle_tool',
      'create_bundle', 'delete_bundle']) {
      expect(isToolForbiddenInGoal(name), `${name} 应被禁`).toBe(true);
    }
  });

  it('保留「干活 / 自控」类（restart 尤其要留 —— 自我递归改进要它）', () => {
    for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'glob',
      'add_task', 'interrupt', 'restart', 'ask_user', 'trigger_compression',
      'activate_bundle', 'deactivate_bundle', 'list_bundles',
      'flow_start', 'rollback', 'plan_execute']) {
      expect(isToolForbiddenInGoal(name), `${name} 不该被禁`).toBe(false);
    }
  });

  it('finish_goal 强制可见（否则「进得去、出不来」）', () => {
    expect(isToolForcedVisibleInGoal('finish_goal')).toBe(true);
    expect(GOAL_FORCED_VISIBLE_TOOLS).toContain('finish_goal');
    expect(GOAL_FORBIDDEN_TOOLS).not.toContain('finish_goal');
  });
});

describe('goal 状态落盘', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-state-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('save → load 往返保留 objective 与计数', () => {
    const st = createGoalState('目标 A', 'agent');
    st.nudges = 3;
    st.reviewAttempts = 2;
    st.lastRejection = '证据不足';
    saveGoalState(dir, st);
    const back = loadGoalState(dir);
    expect(back?.objective).toBe('目标 A');
    expect(back?.enteredBy).toBe('agent');
    expect(back?.nudges).toBe(3);
    expect(back?.reviewAttempts).toBe(2);
    expect(back?.lastRejection).toBe('证据不足');
  });

  it('无文件 / 已解除 → null', () => {
    expect(loadGoalState(dir)).toBeNull();
    saveGoalState(dir, createGoalState('目标 B', 'user'));
    expect(loadGoalState(dir)).not.toBeNull();
    saveGoalState(dir, null); // 解除 = 删文件
    expect(loadGoalState(dir)).toBeNull();
  });
});
