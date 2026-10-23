/**
 * math.test.ts — WebUI 公式渲染的按需加载层（src/webui/math.js + markdown.needsMath）
 *
 * 背景：KaTeX 是 267KB JS + 25KB CSS 的常驻资源，原先无条件同步加载 ——
 * 一场没有公式的对话也要先下 267KB 才能出首屏。改成"正文里真有公式才加载"。
 *
 * 这条改动的风险**全在判据上**：
 *   - 漏报 ⇒ 公式永远停在降级原文（用户看到一串反斜杠），且**不会有任何报错**；
 *   - 误报 ⇒ 白下 292KB，等于改动白做。
 * 所以这里把两类边界都钉住：该认的四种分隔符、不该认的代码块与货币金额。
 *
 * 环境是 node（无 jsdom）。math.js 的 ensure() 需要 document，不在测试范围；
 * 测的是判据与"就绪时回调同步执行"这条契约（app.js 依赖它不递归）。
 */
import { beforeAll, describe, expect, it } from 'vitest';

let needsMath: (src: string) => boolean;
let HyMath: {
  needs: (s: string) => boolean;
  ready: () => boolean;
  whenReady: (fn: () => void) => void;
};

beforeAll(async () => {
  // @ts-ignore 浏览器经典脚本，无类型声明
  await import('./markdown.js');
  // @ts-ignore 同上
  await import('./math.js');
  const md = (globalThis as unknown as { HyMarkdown: { needsMath: (s: string) => boolean } }).HyMarkdown;
  needsMath = md.needsMath;
  HyMath = (globalThis as unknown as { HyMath: typeof HyMath }).HyMath;
});

describe('needsMath — 该认的分隔符', () => {
  it('行内 $…$', () => {
    expect(needsMath('递推式 $S_t = S_{t-1}$ 成立')).toBe(true);
  });

  it('块级 $$…$$（单行与跨行）', () => {
    expect(needsMath('$$E = mc^2$$')).toBe(true);
    expect(needsMath('$$\n\\int_0^1 x^2 dx\n$$')).toBe(true);
  });

  it('LaTeX 括号形式 \\(…\\) / \\[…\\]', () => {
    expect(needsMath('行内 \\(a^2+b^2\\) 与块级')).toBe(true);
    expect(needsMath('\\[E=mc^2\\]')).toBe(true);
  });

  it('落单的 $ 不认（渲染器同样要求成对，认了才是纯浪费）', () => {
    // 流式输出的中间态可能出现落单 $，但最后一次渲染必然是完整文本，
    // 不受影响；认了反而让"价格是 5$"这类文本也去下 292KB。
    expect(needsMath('设 $x 为变量')).toBe(false);
  });
});

describe('needsMath — 不该认的（误报等于白下 292KB）', () => {
  it('纯文本', () => {
    expect(needsMath('今天天气不错。')).toBe(false);
    expect(needsMath('')).toBe(false);
  });

  it('货币金额（Pandoc 规则：闭 $ 前是空白 ⇒ 不是公式）', () => {
    expect(needsMath('价格 $5 到 $10 之间是正常的')).toBe(false);
  });

  it('围栏代码块里的 $（代码块比公式常见得多，是最容易误报的地方）', () => {
    expect(needsMath('```bash\necho $HOME\n```')).toBe(false);
    expect(needsMath('```\ncost = price$ * 2\n```')).toBe(false);
  });

  it('波浪号围栏同样剔除', () => {
    expect(needsMath('~~~sh\nexport PATH=$PATH\n~~~')).toBe(false);
  });

  it('行内代码里的 $', () => {
    expect(needsMath('用 `cost$price` 这种写法')).toBe(false);
  });

  it('代码块之外的 $ 仍然要认（剔除只会削掉代码部分）', () => {
    expect(needsMath('```sh\necho $HOME\n```\n\n但公式 $x^2$ 要渲染')).toBe(true);
  });
});

describe('HyMath — 判据委托与回调契约', () => {
  it('needs() 委托给 markdown.needsMath（避免两处维护判据）', () => {
    expect(HyMath.needs('$x$')).toBe(true);
    expect(HyMath.needs('```\n$x$\n```')).toBe(false);
  });

  it('引擎未就绪时 ready() 为假', () => {
    const saved = (globalThis as Record<string, unknown>).katex;
    delete (globalThis as Record<string, unknown>).katex;
    expect(HyMath.ready()).toBe(false);
    if (saved) (globalThis as Record<string, unknown>).katex = saved;
  });

  it('引擎就绪时 whenReady 是**同步**执行（app.js 靠这条不递归）', () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.katex;
    g.katex = { renderToString: () => '<span>k</span>' };
    try {
      let called = false;
      HyMath.whenReady(() => { called = true; });
      expect(called).toBe(true);
    } finally {
      if (saved) g.katex = saved;
      else delete g.katex;
    }
  });
});
