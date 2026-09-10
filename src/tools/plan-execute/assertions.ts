/**
 * plan-execute/assertions.ts —— 结构化断言评估器（纯函数，零 LLM）。
 *
 * evaluatePrediction(prediction, results) 对一步内全部命令的聚合结果求值，
 * 返回 { ok, reason? }。组合语义：all（全真）/ any（任一真）/ not（取反）。
 * 独立可测、跨项目可移植（不依赖运行时）。
 */
import fs from 'node:fs';
import type { CommandResult, Prediction, AssertionPrimitive } from './types.js';

export interface AssertionVerdict {
  ok: boolean;
  /** 失败原因（供失败报告 / 交回主循环） */
  reason?: string;
}

function isPrimitive(p: Prediction): p is AssertionPrimitive {
  return !('all' in p) && !('any' in p) && !('not' in p);
}

/** 对一步内命令的聚合结果求值断言 */
export function evaluatePrediction(
  prediction: Prediction,
  results: CommandResult[],
): AssertionVerdict {
  if (isPrimitive(prediction)) return evaluatePrimitive(prediction, results);

  if ('all' in prediction) {
    for (const sub of prediction.all) {
      const v = evaluatePrediction(sub, results);
      if (!v.ok) return { ok: false, reason: `all 未满足: ${v.reason ?? '断言为假'}` };
    }
    return { ok: true };
  }
  if ('any' in prediction) {
    const failures: string[] = [];
    for (const sub of prediction.any) {
      const v = evaluatePrediction(sub, results);
      if (v.ok) return { ok: true };
      failures.push(v.reason ?? '断言为假');
    }
    return { ok: false, reason: `any 全部未满足: ${failures.join('; ')}` };
  }
  // not
  const inner = evaluatePrediction(prediction.not, results);
  return inner.ok
    ? { ok: false, reason: 'not 包裹的断言意外为真' }
    : { ok: true };
}

function evaluatePrimitive(p: AssertionPrimitive, results: CommandResult[]): AssertionVerdict {
  if ('success' in p) {
    // success: true = 全部命令无错；success: false = 至少一条命令失败
    const pass = p.success
      ? results.length > 0 && results.every((r) => !r.is_error)
      : results.some((r) => r.is_error);
    return pass
      ? { ok: true }
      : { ok: false, reason: `success=${p.success} 不成立（${results.length} 条命令）` };
  }
  if ('outputContains' in p) {
    const hit = results.some((r) => r.content.includes(p.outputContains));
    return hit ? { ok: true } : { ok: false, reason: `任一输出未包含 "${p.outputContains}"` };
  }
  if ('outputMatches' in p) {
    const hit = results.some((r) => new RegExp(p.outputMatches).test(r.content));
    return hit ? { ok: true } : { ok: false, reason: `任一输出未匹配 /${p.outputMatches}/` };
  }
  if ('stdoutEmpty' in p) {
    const allEmpty = results.every((r) => r.content.trim() === '');
    return allEmpty === p.stdoutEmpty
      ? { ok: true }
      : { ok: false, reason: `stdoutEmpty=${p.stdoutEmpty} 不成立` };
  }
  if ('fileExists' in p) {
    const exists = fs.existsSync(p.fileExists);
    return exists ? { ok: true } : { ok: false, reason: `文件不存在: ${p.fileExists}` };
  }
  if ('fileContains' in p) {
    try {
      const content = fs.readFileSync(p.fileContains.path, 'utf-8');
      const found = new RegExp(p.fileContains.pattern).test(content);
      return found ? { ok: true } : { ok: false, reason: `文件 ${p.fileContains.path} 未包含 /${p.fileContains.pattern}/` };
    } catch {
      return { ok: false, reason: `文件读取失败: ${p.fileContains.path}` };
    }
  }
  // jsonField
  if ('jsonField' in p) {
    const json = results
      .map((r) => r.content.trim())
      .filter((c) => c.length > 0)
      .find((c) => { try { JSON.parse(c); return true; } catch { return false; } });
    if (!json) return { ok: false, reason: '无 JSON 输出可解析' };
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      const val = obj[p.jsonField.field];
      if (p.jsonField.exists === false) {
        return val === undefined
          ? { ok: true }
          : { ok: false, reason: `字段 ${p.jsonField.field} 存在（期望不存在）` };
      }
      if (p.jsonField.exists === true && val === undefined) {
        return { ok: false, reason: `字段 ${p.jsonField.field} 不存在` };
      }
      if (p.jsonField.equals !== undefined) {
        return val === p.jsonField.equals
          ? { ok: true }
          : { ok: false, reason: `字段 ${p.jsonField.field}=${JSON.stringify(val)}，期望 ${JSON.stringify(p.jsonField.equals)}` };
      }
      if (p.jsonField.contains !== undefined) {
        const ok = typeof val === 'string' && val.includes(p.jsonField.contains);
        return ok ? { ok: true } : { ok: false, reason: `字段 ${p.jsonField.field} 未包含 "${p.jsonField.contains}"` };
      }
      if (p.jsonField.exists !== undefined) return { ok: true }; // exists:true 且字段存在
      return { ok: false, reason: `jsonField 需提供 equals/exists/contains 之一` };
    } catch {
      return { ok: false, reason: `JSON 解析失败` };
    }
  }
  return { ok: false, reason: '未知断言原语' };
}
