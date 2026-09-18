/**
 * auto-reference-check.test.ts — 特征化测试（characterization tests）
 *
 * （原名 symbol-references.test.ts；2026-09-19 该模块按方案 A 内联进 write.ts / edit.ts，
 *   文件随之改名。断言未变 —— 它们锁的是**行为**，不是文件位置。）
 *
 * 为什么先写这个：`symbol-references` 支撑「编辑后自动引用搜索」——**每次 edit/write
 * 都会触发**，却一直没有直接单测。任何改动它都等于在无安全网下改变既有行为。
 * 所以本文件**锁定它当前的实际行为**（含那些看起来"不完美但既成事实"的地方），
 * 作为后续重构（与 utils/code-structure 分享引擎）的前置护栏。
 *
 * 已知/既成事实（测试据此断言，不要"顺手改好"）：
 *   - 依赖**显式项目标记**（.git / package.json …）确定扫描根；测试里放 `.git` 目录
 *     既模拟真实项目，也用于**隔离**（否则会向上找到 %TEMP% 之上的目录去扫）。
 *   - **Windows 上 `path.relative()` 返回反斜杠**，故输出形如 `src\b.ts`（不是 `src/b.ts`）。
 *     统一成正斜杠属独立的行为变更，需单独决定；此处用 hasPath() 做分隔符无关断言。
 *   - `total` 统计**含该符号的文件数**（每文件只计一次），不是出现次数。
 *   - 每个符号最多列 8 个文件，超出附「… (N 个引用中还有 M 个未列出…)」。
 *   - 最多取 3 个符号；被编辑文件自身被排除；只在**同语言后缀**里找引用。
 *   - 任何异常都吞掉并返回空（不抛错）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 内联后（方案 A）：实现在 write.ts 的标记块里 —— 用**仅测试用**的导出取回，
// 别名回 autoReferenceCheck，故本文件其余断言无需改动。
// （edit.ts 另有一份**逐字节相同**的副本，由 inlined-copies-sync.test.ts 守住一致性。）
import { __autoReferenceCheckForTest as autoReferenceCheck } from './write.js';

/** 造一个带 .git 标记的临时"项目"，保证扫描根就是它（既真实又隔离） */
function makeProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symref-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

/**
 * 分隔符无关的路径断言：把期望路径里的 `/` 视作 `[\\/]`。
 * ⚠️ 特征化事实：Windows 上 path.relative() 给反斜杠，故实际输出是 `src\b.ts`。
 */
function hasPath(text: string, p: string): boolean {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]');
  return new RegExp(escaped).test(text);
}

const TS_DECL = 'export function targetFn(a: number): number {\n  return a + 1;\n}\n';

describe('autoReferenceCheck（特征化：锁定当前行为）', () => {
  it('未知后缀 → 空结果（不抛错）', () => {
    const root = makeProject({ 'a.zzz': 'targetFn();\n' });
    const r = autoReferenceCheck(path.join(root, 'a.zzz'), 'targetFn', 'targetFn', 'targetFn');
    expect(r.text).toBe('');
  });

  it('符号未被任何其他文件引用 → 空结果', () => {
    const root = makeProject({ 'src/a.ts': TS_DECL });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), TS_DECL, TS_DECL, TS_DECL);
    expect(r.text).toBe('');
  });

  it('被引用时输出 [References] 块，且列出的是相对路径', () => {
    const root = makeProject({
      'src/a.ts': TS_DECL,
      'src/b.ts': 'import { targetFn } from "./a.js";\ntargetFn(1);\n',
      'src/c.ts': 'targetFn(2);\n',
    });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), TS_DECL, TS_DECL, TS_DECL);
    expect(r.text.startsWith('[References]')).toBe(true);
    expect(r.text).toContain('targetFn → ');
    expect(hasPath(r.text, 'src/b.ts')).toBe(true);
    expect(hasPath(r.text, 'src/c.ts')).toBe(true);
    // 相对路径：不该出现绝对根路径
    expect(r.text).not.toContain(root);
  });

  it('被编辑文件自身被排除（即便它含该符号）', () => {
    const root = makeProject({
      'src/a.ts': TS_DECL,
      'src/b.ts': 'targetFn(1);\n',
    });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), TS_DECL, TS_DECL, TS_DECL);
    expect(hasPath(r.text, 'src/b.ts')).toBe(true);
    expect(hasPath(r.text, 'src/a.ts')).toBe(false);
  });

  it('只在同语言后缀里找引用（.py 里出现同名字符串不算）', () => {
    const root = makeProject({
      'src/a.ts': TS_DECL,
      'src/b.ts': 'targetFn(1);\n',
      'src/c.py': '# targetFn mentioned here\ntargetFn = 1\n',
    });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), TS_DECL, TS_DECL, TS_DECL);
    expect(hasPath(r.text, 'src/b.ts')).toBe(true);
    expect(hasPath(r.text, 'src/c.py')).toBe(false);
  });

  it('超过 8 个文件时截断并附「还有 N 个未列出」提示', () => {
    const files: Record<string, string> = { 'src/a.ts': TS_DECL };
    for (let i = 0; i < 12; i++) files[`src/r${i}.ts`] = 'targetFn(1);\n';
    const root = makeProject(files);
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), TS_DECL, TS_DECL, TS_DECL);
    expect(r.text).toContain('个引用中还有');
    // 12 个文件 → 列出 8 个，提示剩 4 个
    expect(r.text).toContain('4 个未列出');
  });

  it('改动文本里没有可提取符号时，回退到"最近的具名外层符号"', () => {
    // 改动只涉及单字符变量 x（长度 < 2 被过滤）→ 应回退到 fileContent 里最近的外层函数
    const content = [
      'export function outerFn(): number {',
      '  const x = 1;',
      '  return x;',
      '}',
      '',
    ].join('\n');
    const root = makeProject({ 'src/a.ts': content, 'src/b.ts': 'outerFn();\n' });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), content, 'const x = 1;', 'const x = 2;');
    expect(r.text).toContain('outerFn → ');
  });

  it('最多取 3 个符号', () => {
    const content = [
      'export function fnOne(): void {}',
      'export function fnTwo(): void {}',
      'export function fnThree(): void {}',
      'export function fnFour(): void {}',
      '',
    ].join('\n');
    const root = makeProject({
      'src/a.ts': content,
      'src/b.ts': 'fnOne();fnTwo();fnThree();fnFour();\n',
    });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), content, content, content);
    const symLines = r.text.split('\n').filter((l) => l.includes(' → '));
    expect(symLines.length).toBeLessThanOrEqual(3);
  });

  it('通用忽略名（如 if）不会被当成符号', () => {
    const content = 'if (x) { y(); }\n';
    const root = makeProject({ 'src/a.ts': content, 'src/b.ts': 'if (1) {}\n' });
    const r = autoReferenceCheck(path.join(root, 'src/a.ts'), content, 'if (x) { y(); }', 'if (z) { y(); }');
    expect(r.text).toBe('');
  });
});
