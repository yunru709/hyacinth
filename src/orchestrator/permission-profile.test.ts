// ============================================================
// 执行档位闸门单测 —— 四档 × 三类调用的判定矩阵
// ============================================================
// 这张表是「用户看到档位 → 实际发生什么」的唯一映射，改判定前先改这里：
//   plan    写工具/bash 一律 block；其它 allow
//   confirm 敏感或越界 → legacy（走 allowlist/命令白名单/弹窗）；其余 allow
//   auto    只有越界 → ask；其余 allow
//   full    永远 allow
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  decideGate,
  normalizePermissionProfile,
  planBlocksTool,
  planBlockMessage,
  PERMISSION_PROFILES,
} from './permission-profile.js';

const cases = [
  // [profile, toolName, dangerous, outsideWrite, expected]
  ['plan', 'write', true, false, 'block'],
  ['plan', 'edit', true, false, 'block'],
  ['plan', 'bash', true, false, 'block'],
  ['plan', 'read', false, false, 'allow'],
  ['plan', 'grep', false, false, 'allow'],
  ['confirm', 'write', true, false, 'legacy'],
  ['confirm', 'write', true, true, 'legacy'],
  ['confirm', 'read', false, false, 'allow'],
  ['confirm', 'read', false, true, 'legacy'],
  ['auto', 'write', true, false, 'allow'],
  ['auto', 'bash', true, false, 'allow'],
  ['auto', 'write', true, true, 'ask'],
  ['full', 'write', true, true, 'allow'],
  ['full', 'bash', true, false, 'allow'],
] as const;

describe('decideGate 四档矩阵', () => {
  for (const [profile, toolName, dangerous, outsideWrite, expected] of cases) {
    it(`${profile} / ${toolName} / dangerous=${dangerous} / outside=${outsideWrite} → ${expected}`, () => {
      expect(decideGate(profile, { toolName, dangerous, outsideWrite })).toBe(expected);
    });
  }
});

describe('planBlocksTool', () => {
  it('写类（write）与执行类（exec）都拦 —— 只判 write 会放过 bash', () => {
    for (const t of ['write', 'edit', 'multi_edit', 'delete', 'bash', 'git_tool', 'process']) {
      expect(planBlocksTool(t)).toBe(true);
    }
  });
  it('只读工具放行', () => {
    for (const t of ['read', 'glob', 'grep', 'ask_user']) {
      expect(planBlocksTool(t)).toBe(false);
    }
  });
});

describe('档位解析', () => {
  it('认得出四个合法值', () => {
    for (const p of PERMISSION_PROFILES) expect(normalizePermissionProfile(p)).toBe(p);
  });
  it('脏数据一律回 confirm（宁可收紧）', () => {
    for (const v of [undefined, null, '', 'yolo', 1, {}, []]) {
      expect(normalizePermissionProfile(v)).toBe('confirm');
    }
  });
});

describe('planBlockMessage', () => {
  it('文案里带工具名，并且明确要求先出计划', () => {
    const msg = planBlockMessage('write');
    expect(msg).toContain('write');
    expect(msg).toMatch(/plan mode/i);
    expect(msg).toMatch(/read-only/i);
  });
});
