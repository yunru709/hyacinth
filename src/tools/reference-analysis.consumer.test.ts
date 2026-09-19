/**
 * reference-analysis.consumer.test.ts — Phase 6 第 1 步的消费者契约
 *
 * 三条判据（对着行为，不看文档）：
 *  ① **兜底等价**：未注册能力时，analyzeReferences 的输出与"从前工具内直接调
 *     autoReferenceCheck"**逐字相同** —— 这是"xref 未挂载时行为与从前一致"的机器化证据，
 *     也是本次搬迁的验收底线（否则搬了个行为变化出来还没人发现）。
 *  ② **能力优先**：已注册能力时用能力的输出（xref 挂载 = 精确调用方 + 标注）。
 *  ③ **降级诚实**：能力返回空或抛错时**退兜底**，不把"能力没结论"当成"没有引用"
 *     （否则模型会拿到假阴性）。
 *
 * ⚠️ 夹具教训（首版踩过）：临时项目**必须带 .git 标记** —— findProjectRoot 靠它停住，
 * 扫描根才等于这个临时项目。缺了它，findProjectRoot 会一路向上到系统临时目录/盘根，
 * 扫描面失控（实测：单例耗时 6.2s，且扫不出预期结果）。此法与
 * src/tools/auto-reference-check.test.ts 的 makeProject 一致。
 */
import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeReferences,
  autoReferenceCheck,
  normalizeReferenceInput,
  type ReferenceAnalysisCapability,
} from './reference-analysis.js';

/** 本文件建过的临时项目 —— afterAll 自清（测试不留垃圾） */
const created: string[] = [];

const TS_DECL = 'export function targetFn(): number {\n  return 1;\n}\n';
const TS_CALLER = "import { targetFn } from './a.js';\n\nexport const x = targetFn();\n";

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refanalysis-'));
  created.push(root);
  // .git 标记：让 findProjectRoot 停在这里（扫描面受控 + 隔离）
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), TS_DECL, 'utf-8');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), TS_CALLER, 'utf-8');
  return root;
}

afterAll(() => {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('analyzeReferences（Phase 6 消费者入口）', () => {
  it('① 兜底等价（write 分支）：未注册能力时，与旧调用点 autoReferenceCheck(file,before,before,after) 逐字相同', async () => {
    const root = tmpProject();
    const file = path.join(root, 'src', 'a.ts');
    const before = TS_DECL;
    const after = 'export function targetFnRenamed(): number {\n  return 1;\n}\n';

    const viaConsumer = await analyzeReferences(null, {
      toolName: 'write',
      filePath: file,
      before,
      after,
      args: { file_path: file, content: after },
    });
    const legacy = autoReferenceCheck(file, before, before, after).text;

    expect(viaConsumer).toBe(legacy);
    // 防"两边都空"的假等价（首版正是这条守卫起了作用）
    expect(viaConsumer).toContain('[References]');
    expect(viaConsumer).toContain('targetFn');
  });

  it('① 兜底等价（edit 分支）：old_string 直接用；line_replace 时按 line_start/line_count 从改动前内容切片', async () => {
    const root = tmpProject();
    const file = path.join(root, 'src', 'a.ts');
    const before = TS_DECL;
    const after = 'export function targetFn2(): number {\n  return 1;\n}\n';

    // string_replace：old_string 直接用
    const viaConsumer = await analyzeReferences(null, {
      toolName: 'edit',
      filePath: file,
      before,
      after,
      args: { file_path: file, old_string: 'targetFn', new_string: 'targetFn2' },
    });
    expect(viaConsumer).toBe(autoReferenceCheck(file, before, 'targetFn', 'targetFn2').text);

    // line_replace：无 old_string ⇒ 切片（默认 line_start=1, line_count=1）
    const normalized = normalizeReferenceInput({
      toolName: 'edit',
      filePath: file,
      before,
      after,
      args: { line_start: 1, line_count: 1 },
    });
    expect(normalized.oldText).toBe('export function targetFn(): number {');

    const viaLines = await analyzeReferences(null, {
      toolName: 'edit',
      filePath: file,
      before,
      after,
      args: { file_path: file, line_start: 1, line_count: 1, new_string: 'export function targetFn2(): number {' },
    });
    expect(viaLines).toBe(
      autoReferenceCheck(file, before, 'export function targetFn(): number {', 'export function targetFn2(): number {').text,
    );
  });

  it('② 能力优先：注册了能力就用能力的输出（精确 + 标注由能力方提供）', async () => {
    const root = tmpProject();
    const file = path.join(root, 'src', 'a.ts');
    const cap: ReferenceAnalysisCapability = {
      analyze: () => '[References]\n  targetFn → src/b.ts [precise]',
    };
    const out = await analyzeReferences(cap, { toolName: 'write', filePath: file, before: '', after: 'x' });
    expect(out).toContain('[precise]');
    expect(out).toContain('src/b.ts');
  });

  it('③ 降级诚实：能力返回空 / 抛错 → 退兜底（不把"没结论"当"没有引用"）', async () => {
    const root = tmpProject();
    const file = path.join(root, 'src', 'a.ts');
    const before = TS_DECL;
    const after = 'export function targetFn3(): number {\n  return 1;\n}\n';
    const legacy = autoReferenceCheck(file, before, before, after).text;
    expect(legacy).not.toBe(''); // 前提：兜底确实有内容（靠 .git 标记保证扫描面）

    const emptyCap: ReferenceAnalysisCapability = { analyze: () => null };
    expect(await analyzeReferences(emptyCap, { toolName: 'write', filePath: file, before, after })).toBe(legacy);

    const throwingCap: ReferenceAnalysisCapability = {
      analyze: () => { throw new Error('索引陈旧'); },
    };
    expect(await analyzeReferences(throwingCap, { toolName: 'write', filePath: file, before, after })).toBe(legacy);
  });
});
