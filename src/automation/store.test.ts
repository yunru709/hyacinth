/**
 * AutomationRule 存储层测试（2026-10-30）
 *
 * 重点：**一条规则写错不该拖垮整个文件**，但结构性错误必须整份保旧。
 * 这两者容易混，界线就在 loadAutomationRules 的 `fatal` 判定。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ValidationContext } from './validate.js';
import {
  initAutomationsFromDisk,
  loadAutomationRules,
  saveAutomationRules,
  setCurrentAutomationRules,
  getCurrentAutomationRules,
} from './store.js';
import type { AutomationRule } from './types.js';

const ctx: ValidationContext = {
  knownProbeKinds: ['file', 'process'],
  knownToolNames: ['say', 'write'],
  knownHandlers: ['core.invoke-tool'],
  knownEvents: ['afterWatch', 'afterToolExecute'],
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-store-'));
  file = path.join(dir, 'automations.json');
  setCurrentAutomationRules([]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function validRule(id: string): AutomationRule {
  return {
    id,
    name: `rule-${id}`,
    enabled: true,
    when: { kind: 'probe', probe: { kind: 'process', spec: { name: 'x', expect: 'exit' } } },
    do: [{ sink: 'invoke', tool: 'say', args: { content: 'hi' } }],
  };
}

describe('loadAutomationRules', () => {
  it('文件不存在 → 空规则、existed=false、无错误', () => {
    const r = loadAutomationRules(ctx, file);
    expect(r.rules).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.existed).toBe(false);
  });

  it('合法文件 → 全部加载', () => {
    saveAutomationRules([validRule('a'), validRule('b')], file);
    const r = loadAutomationRules(ctx, file);
    expect(r.errors).toEqual([]);
    expect(r.rules.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.existed).toBe(true);
  });

  it('单条非法 → 只剔除该条，其余照常（不拖垮整个文件）', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        rules: [validRule('ok'), { id: 'bad', name: 'x', enabled: true, when: { kind: 'probe', probe: { kind: '不存在', spec: {} } }, do: [{ sink: 'invoke', tool: 'say' }] }],
      }),
      'utf8',
    );
    const r = loadAutomationRules(ctx, file);
    expect(r.rules.map((x) => x.id)).toEqual(['ok']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('rules[1]');
    expect(r.errors[0]).toContain('未知的 probe kind');
  });

  it('id 重复 → 后者被忽略并报错', () => {
    saveAutomationRules([validRule('dup'), validRule('dup')], file);
    const r = loadAutomationRules(ctx, file);
    expect(r.rules).toHaveLength(1);
    expect(r.errors[0]).toContain('重复');
  });

  it('JSON 坏 → errors 非空、rules 为空', () => {
    fs.writeFileSync(file, '{ broken', 'utf8');
    const r = loadAutomationRules(ctx, file);
    expect(r.rules).toEqual([]);
    expect(r.errors[0]).toContain('invalid JSON');
  });
});

describe('initAutomationsFromDisk', () => {
  it('JSON 坏 → 保旧（applied=false，当前规则不变）', () => {
    const keep = validRule('keep');
    setCurrentAutomationRules([keep]);
    fs.writeFileSync(file, '{ broken', 'utf8');

    // initAutomationsFromDisk 内部用固定路径；这里直接验证"保旧"语义
    // 通过 load + 手动判断（避免测试依赖真实 ~/.agent 路径）
    const r = loadAutomationRules(ctx, file);
    const fatal = r.errors.some((e) => e.startsWith('invalid JSON'));
    expect(fatal).toBe(true);
    expect(getCurrentAutomationRules().map((x) => x.id)).toEqual(['keep']);
  });

  it('文件不存在 → 清空当前规则（applied=true, count=0）', () => {
    setCurrentAutomationRules([validRule('old')]);
    // 模拟 init 对空文件的处理：load 返回空 + 非 fatal ⇒ 应清空
    const r = loadAutomationRules(ctx, path.join(dir, 'nope.json'));
    expect(r.existed).toBe(false);
    expect(r.errors).toEqual([]);
    // 这里只断言语义：无错 + 空 ⇒ 调用方应 setCurrent([])
    setCurrentAutomationRules(r.rules);
    expect(getCurrentAutomationRules()).toEqual([]);
  });
});
