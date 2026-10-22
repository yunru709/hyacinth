// ════════════════════════════════════════════════════════════════════
// latex-unicode.ts — TUI 的 LaTeX → Unicode 近似降级
// ════════════════════════════════════════════════════════════════════
// 为什么需要：TUI 是**字符网格**（等宽格子 + 固定行高），二维排版在它的模型里
//   没有位置 —— 分式横线要画在字符中间、根号要跨行包裹、矩阵括号要纵向拉伸，
//   这些在 terminal 里物理上不可表达。pi-tui 的 Markdown 组件也不认公式语法。
//   ⇒ 唯一可行的是把常见 LaTeX 折成 Unicode 近似：让公式「读得懂」，不追求「好看」。
//
// 能力边界（必须诚实，别让人以为 TUI 也能渲公式）：
//   ✓ 希腊字母 / 运算符 / 上下标 / \frac → (a)/(b) / \sqrt → √(x) / \mathbb → ℝ
//   ✗ 矩阵、多行对齐、根号长横线、真分数 —— 只能折成线性形式，形似而神不似
//   ⇒ **要真正好看只有 WebUI/GUI**（那里用 KaTeX，见 src/webui/markdown.js）
//
// 安全（不破坏既有渲染）：
//   ① **只在文本含 `$` 时才处理** ⇒ 普通中文/英文/路径/代码完全不受影响
//   ② 围栏代码块（``` / ~~~）与行内代码（`…`）内的内容**原样保留**
//      （模型经常在代码块里写 LaTeX 示例，折了会让人以为源码被改）
//   ③ 未知命令 `\foo` 原样保留（绝不猜），避免把 `C:\Users` 这类文本吃掉
//
// 调用点：src/ui/markdown-message.ts —— 送进 pi-tui 的 Markdown 组件**之前**。
// ════════════════════════════════════════════════════════════════════

/** 希腊字母（大小写分开；LaTeX 里同名不同 case 是两个宏） */
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'ϕ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** 运算符 / 关系符 / 箭头 / 定界符 */
const SYMBOLS: Record<string, string> = {
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', propto: '∝', cong: '≅',
  ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇',
  sum: 'Σ', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆',
  supset: '⊃', supseteq: '⊇', setminus: '∖',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬',
  land: '∧', lor: '∨', wedge: '∧', vee: '∨',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  implies: '⇒', iff: '⇔', mapsto: '↦',
  angle: '∠', perp: '⊥', parallel: '∥',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  // ⚠️ \top 是"转置"，用修饰符大写 T（U+1D40）。若终端字体缺失会显示方框 ——
  //    Windows Terminal 的 Cascadia / Consolas 支持，可接受。
  top: 'ᵀ', bot: '⊥',
  triangle: '△', square: '□', checkmark: '✓',
  degree: '°', prime: '′',
};

/** \mathbb{X} 的黑板粗体 */
const MATHBB: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ',
};

/** 下标映射（缺 q 等少数几个 ⇒ 遇到不可映射字符整体退化为 `_x`） */
const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ',
  n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/** 上标映射 */
const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ',
  i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ',
  r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

/**
 * 逐字符映射到上/下标。
 *
 * ⚠️ **映射不了的原样保留，不整体退化** —— Unicode 缺下标 c/q 等字符，
 *   若"有一个转不了就整串退回 `_x`"，`d×d` 会变成 `^{d×d}`，比部分转换更不可读。
 *   空格在上下标里没有意义，直接丢弃。
 */
function mapChars(s: string, table: Record<string, string>): string {
  const out: string[] = [];
  for (const ch of s) {
    if (ch === ' ') continue;
    out.push(table[ch] ?? ch);
  }
  return out.join('');
}

/** 分式里若是复合表达式才加括号：`\frac{a}{b}` → a/b，`\frac{a+b}{c}` → (a+b)/c */
function paren(x: string): string {
  return /[+\-*/=<> ]/.test(x.trim()) ? '(' + x.trim() + ')' : x.trim();
}

/**
 * 把一段 TeX 源码折成 Unicode 近似。
 * 顺序有讲究：带花括号的宏（\frac、\sqrt、\mathbb、\text）先处理，
 * 否则命令替换会把 `\frac` 拆成 `f r a c` 的一部分。
 */
export function texToUnicode(tex: string): string {
  if (!tex) return '';
  let s = tex;

  // ① 黑板粗体 / 文本类宏 —— 直接取内容
  s = s.replace(/\\mathbb\s*\{([A-Za-z])\}/g, (_m, c: string) => MATHBB[c] ?? c);
  s = s.replace(/\\[a-zA-Z]*(?:text|mathrm|mathbf|mathit|operatorname|mathcal)\s*\{([^{}]*)\}/g, '$1');

  // ② \frac{a}{b} —— 只支持一层嵌套（再深在字符网格里也没意义）
  s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
    (_m, a: string, b: string) => paren(a) + '/' + paren(b));

  // ③ \sqrt{x} → √(x)
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, x: string) => '√(' + x + ')');

  // ④ 命令 → 符号（未知命令原样保留，绝不猜）
  s = s.replace(/\\([a-zA-Z]+)/g, (m, name: string) => GREEK[name] ?? SYMBOLS[name] ?? m);

  // ⑤ 间距类转义：\, \; \: \! \quad 之类
  s = s.replace(/\\([,;:!>])/g, ' ');
  s = s.replace(/\\quad\b/g, '  ');
  s = s.replace(/\\qquad\b/g, '    ');

  // ⑥ 上下标（花括号版优先，再处理单字符版）
  s = s.replace(/_\{([^{}]*)\}/g, (_m, x: string) => mapChars(x, SUB, '_'));
  s = s.replace(/\^\{([^{}]*)\}/g, (_m, x: string) => mapChars(x, SUP, '^'));
  s = s.replace(/_([A-Za-z0-9+\-=()])/g, (_m, x: string) => mapChars(x, SUB, '_'));
  s = s.replace(/\^([A-Za-z0-9+\-=()])/g, (_m, x: string) => mapChars(x, SUP, '^'));

  // ⑦ `^ᵀ` 这类：上标位置已经是 Unicode 符号了，^ 反而多余
  s = s.replace(/\^([^\x00-\x7F])/g, '$1');
  s = s.replace(/_([^\x00-\x7F])/g, '$1');

  // ⑧ 转义字符 + 残留结构清理
  s = s.replace(/\\([{}$%&#_])/g, '$1');
  s = s.replace(/\\\s/g, ' ');
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\\\/g, ' ');

  return s.replace(/\s+/g, ' ').trim();
}

/** 处理一段**非代码**文本里的公式（块级 $$…$$ 与行内 $…$） */
function convertMath(text: string): string {
  // 块级：独占一段，前后留空行（TUI 里段落间距靠空行）
  let s = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    const u = texToUnicode(tex.trim());
    return u ? '\n' + u + '\n' : '';
  });

  // 行内：与 WebUI 同一条判据（开 $ 后非空白、闭 $ 前非空白且后不接数字）
  s = s.replace(/(^|[^\\$])\$(?!\s)([^$\n]*?[^\s\\])\$(?!\d)/g,
    (_m, pre: string, tex: string) => pre + (texToUnicode(tex) || tex));

  return s;
}

const RE_FENCE_LINE = /^\s*(`{3,}|~{3,})\s*[\w+#.\-]*\s*$/;

/**
 * TUI 入口：把文本里的 LaTeX 折成 Unicode 可读形式。
 *
 * ⚠️ 只处理 `$…$` 包裹的公式；**不含 `$` 的文本按原样返回**（连遍历都省了）。
 *    这条是硬约束：TUI 里所有消息都会过这个函数，任何多余改动都是全量风险。
 */
export function latexToUnicode(src: string): string {
  if (!src || src.indexOf('$') < 0) return src;

  const lines = src.split('\n');
  const out: string[] = [];
  let buf: string[] = []; // 非代码区：攒着，出块时统一转换
  let fence: string[] | null = null; // 非 null = 正在围栏里，只攒不转

  const flush = () => {
    if (!buf.length) return;
    out.push(convertMath(buf.join('\n')));
    buf = [];
  };

  for (const line of lines) {
    const isFence = RE_FENCE_LINE.test(line);

    if (fence) {
      // 围栏内：**逐字原样**，连 convertMath 都不碰
      fence.push(line);
      if (isFence) { out.push(fence.join('\n')); fence = null; }
      continue;
    }

    if (isFence) {
      flush(); // 先把前面的正文转换掉
      fence = [line];
      continue;
    }

    buf.push(line);
  }

  // 未闭合的围栏：剩余部分当代码，原样输出（不做任何转换）
  if (fence) { flush(); out.push(fence.join('\n')); }
  else flush();

  return out.join('\n');
}
