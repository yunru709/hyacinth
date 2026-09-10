// plan-execute/assertions 断言评估器单测（纯函数）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluatePrediction } from './assertions.js';
import type { CommandResult, Prediction } from './types.js';

const okRes: CommandResult = { tool: 'bash', content: 'done\n42', is_error: false };
const errRes: CommandResult = { tool: 'bash', content: 'boom', is_error: true };
const emptyRes: CommandResult = { tool: 'bash', content: '', is_error: false };

describe('断言原语（结构化，零 LLM）', () => {
  it('success: 全部命令无错（true）/ 有错（false）', () => {
    expect(evaluatePrediction({ success: true }, [okRes, okRes]).ok).toBe(true);
    expect(evaluatePrediction({ success: true }, [okRes, errRes]).ok).toBe(false);
    expect(evaluatePrediction({ success: false }, [okRes, errRes]).ok).toBe(true);
    // 空结果集视为不成立
    expect(evaluatePrediction({ success: true }, []).ok).toBe(false);
  });

  it('outputContains: 任一输出包含子串', () => {
    expect(evaluatePrediction({ outputContains: 'done' }, [okRes]).ok).toBe(true);
    expect(evaluatePrediction({ outputContains: 'nope' }, [okRes]).ok).toBe(false);
  });

  it('outputMatches: 任一输出匹配正则', () => {
    expect(evaluatePrediction({ outputMatches: 'done' }, [okRes]).ok).toBe(true);
    expect(evaluatePrediction({ outputMatches: '^done' }, [okRes]).ok).toBe(true); // 开头匹配
    expect(evaluatePrediction({ outputMatches: '\\d+' }, [okRes]).ok).toBe(true); // 'done\n42' 含 42
    expect(evaluatePrediction({ outputMatches: 'zzz' }, [okRes]).ok).toBe(false);
  });

  it('stdoutEmpty: 所有输出为空（true）/ 至少一条非空（false）', () => {
    expect(evaluatePrediction({ stdoutEmpty: true }, [emptyRes, emptyRes]).ok).toBe(true);
    expect(evaluatePrediction({ stdoutEmpty: true }, [emptyRes, okRes]).ok).toBe(false);
    expect(evaluatePrediction({ stdoutEmpty: false }, [emptyRes, okRes]).ok).toBe(true);
  });

  it('fileExists / fileContains', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-assert-'));
    const f = path.join(dir, 'out.json');
    fs.writeFileSync(f, '{"ok":true}');
    try {
      expect(evaluatePrediction({ fileExists: f }, []).ok).toBe(true);
      expect(evaluatePrediction({ fileExists: path.join(dir, 'nope') }, []).ok).toBe(false);
      expect(evaluatePrediction({ fileContains: { path: f, pattern: '"ok":true' } }, []).ok).toBe(true);
      expect(evaluatePrediction({ fileContains: { path: f, pattern: 'nope' } }, []).ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('jsonField: equals / exists / contains', () => {
    const jsonRes: CommandResult = { tool: 'bash', content: '{"ok":true,"name":"alice","count":3}', is_error: false };
    expect(evaluatePrediction({ jsonField: { field: 'ok', equals: true } }, [jsonRes]).ok).toBe(true);
    expect(evaluatePrediction({ jsonField: { field: 'ok', equals: false } }, [jsonRes]).ok).toBe(false);
    expect(evaluatePrediction({ jsonField: { field: 'name', contains: 'ali' } }, [jsonRes]).ok).toBe(true);
    expect(evaluatePrediction({ jsonField: { field: 'missing', exists: true } }, [jsonRes]).ok).toBe(false);
    expect(evaluatePrediction({ jsonField: { field: 'missing', exists: false } }, [jsonRes]).ok).toBe(true);
    // 无 JSON 输出
    expect(evaluatePrediction({ jsonField: { field: 'ok', exists: true } }, [okRes]).ok).toBe(false);
  });
});

describe('断言组合（all/any/not）', () => {
  it('all: 全部子断言满足', () => {
    const pred: Prediction = { all: [{ success: true }, { outputContains: 'done' }] };
    expect(evaluatePrediction(pred, [okRes]).ok).toBe(true);
    const pred2: Prediction = { all: [{ success: true }, { outputContains: 'nope' }] };
    expect(evaluatePrediction(pred2, [okRes]).ok).toBe(false);
  });

  it('any: 任一子断言满足', () => {
    const pred: Prediction = { any: [{ outputContains: 'nope' }, { stdoutEmpty: true }] };
    expect(evaluatePrediction(pred, [emptyRes]).ok).toBe(true);
    const pred2: Prediction = { any: [{ outputContains: 'nope' }, { stdoutEmpty: true }] };
    expect(evaluatePrediction(pred2, [okRes]).ok).toBe(false);
  });

  it('not: 取反', () => {
    expect(evaluatePrediction({ not: { success: false } }, [okRes]).ok).toBe(true);
    expect(evaluatePrediction({ not: { success: true } }, [okRes]).ok).toBe(false);
  });

  it('嵌套组合：all[success, any[outputContains, stdoutEmpty]]', () => {
    const pred: Prediction = {
      all: [
        { success: true },
        { any: [{ outputContains: 'zzz' }, { stdoutEmpty: true }] },
      ],
    };
    expect(evaluatePrediction(pred, [okRes]).ok).toBe(false); // any 两个都不满足
    expect(evaluatePrediction(pred, [emptyRes]).ok).toBe(true); // stdoutEmpty 满足
  });
});
