/**
 * latex-unicode.test.ts — TUI 的 LaTeX → Unicode 降级
 *
 * 风险面：这个函数会经过 **TUI 的每一条消息**，所以测试重点不是"能转多少"，
 * 而是 **"不该动的东西一律没动"**：
 *   ① 不含 `$` 的文本必须逐字节原样返回（连遍历都省了）
 *   ② 代码块 / 行内代码里的 LaTeX 必须原样保留
 *   ③ 未知命令不能被吃掉（`C:\Users` 这类路径不能变样）
 *   ④ 货币 `$5 到 $10` 不能被当公式
 */
import { describe, expect, it } from 'vitest';
import { latexToUnicode, texToUnicode } from './latex-unicode.js';

describe('texToUnicode — 转换', () => {
  it('希腊字母', () => {
    expect(texToUnicode('\\alpha + \\beta + \\Omega')).toBe('α + β + Ω');
  });

  it('上下标（花括号与单字符两种）', () => {
    expect(texToUnicode('S_{t-1}')).toBe('Sₜ₋₁');
    expect(texToUnicode('k_t')).toBe('kₜ');
    expect(texToUnicode('d^{2}')).toBe('d²');
  });

  it('\\top 转置：k_t^\\top ⇒ kₜᵀ（^ 上是 Unicode 符号时去掉 ^）', () => {
    expect(texToUnicode('k_t^\\top')).toBe('kₜᵀ');
  });

  it('\\frac 单层 ⇒ a/b，复合分子加括号', () => {
    expect(texToUnicode('\\frac{a}{b}')).toBe('a/b');
    expect(texToUnicode('\\frac{a+b}{c}')).toBe('(a+b)/c');
  });

  it('\\sqrt ⇒ √(…)', () => {
    expect(texToUnicode('\\sqrt{x}')).toBe('√(x)');
  });

  it('\\mathbb ⇒ 黑板粗体', () => {
    expect(texToUnicode('\\mathbb{R}^{d\\times d}')).toBe('ℝᵈ×ᵈ');
  });

  it('关系符与箭头', () => {
    expect(texToUnicode('a \\le b \\ne c')).toBe('a ≤ b ≠ c');
    expect(texToUnicode('x \\to y')).toBe('x → y');
  });

  it('未知命令原样保留（不猜）', () => {
    expect(texToUnicode('\\unknowncmd{x}')).toBe('\\unknowncmdx');
  });
});

describe('latexToUnicode — 整体行为', () => {
  it('不含 $ 的文本逐字节原样返回', () => {
    const plain = '# 标题\n正文 **粗体**\n路径 C:\\Users\\x\n```js\nconst a=1;\n```';
    expect(latexToUnicode(plain)).toBe(plain);
  });

  it('空 / null 安全', () => {
    expect(latexToUnicode('')).toBe('');
    expect(latexToUnicode(null as unknown as string)).toBe(null);
  });

  it('用户截图里那条公式 ⇒ 可读的 Unicode 行', () => {
    const src = '$$S_t = S_{t-1}(I - \\beta_t k_t k_t^\\top) + \\beta_t v_t k_t^\\top$$';
    const out = latexToUnicode(src);
    expect(out).toContain('Sₜ = Sₜ₋₁(I - βₜ kₜ kₜᵀ) + βₜ vₜ kₜᵀ');
    expect(out).not.toContain('$$');
    expect(out).not.toContain('\\beta');
  });

  it('行内公式就地折叠，$ 消失', () => {
    const out = latexToUnicode('状态矩阵 $S \\in \\mathbb{R}^{d\\times d}$ 每步更新');
    expect(out).toBe('状态矩阵 S ∈ ℝᵈ×ᵈ 每步更新');
  });

  it('围栏代码块里的公式原样保留', () => {
    const src = '```tex\n$$x^2$$\n```';
    expect(latexToUnicode(src)).toBe(src);
  });

  it('未闭合围栏里的内容不被转换', () => {
    const src = '```tex\n$$\\beta$$\n';
    expect(latexToUnicode(src)).toContain('$$\\beta$$');
  });

  it('货币不被误伤', () => {
    const src = '价格 $5 到 $10 元';
    expect(latexToUnicode(src)).toBe(src);
  });

  it('跨行块级公式能被收全', () => {
    const src = '$$\na = b\nc = d\n$$';
    const out = latexToUnicode(src);
    expect(out).toContain('a = b c = d');
    expect(out).not.toContain('$$');
  });
});
