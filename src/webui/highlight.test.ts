/**
 * highlight.test.ts — WebUI 代码块高亮包装层（src/webui/highlight.js）
 *
 * 这里测两件事：
 *   ① 语言名归一化（围栏里的写法千奇百怪：```Python / ```.py / ```python title=x）
 *   ② 着色决策（什么情况下**不**着色 —— 不该上色的别硬上色，比漏上色更影响阅读）
 *
 * 环境是 node（没有 jsdom），所以 DOM 用最小替身：paint() 只碰
 * textContent / innerHTML / dataset / parentNode.getAttribute 四个成员，
 * 假对象足够。这样不用为一层薄包装引入 jsdom 依赖。
 *
 * 另有一条**产物体检**：直接加载 vendor/hljs.min.js 验它能真高亮、别名已注册。
 * 这条的意义是防止"构建脚本改了但产物没重跑"——那种情况下页面静默无高亮，
 * 单看源码一点都看不出来。
 */
import { beforeAll, describe, expect, it } from 'vitest';

interface FakeCode {
  textContent: string;
  innerHTML: string;
  dataset: Record<string, string>;
  parentNode: { getAttribute: (n: string) => string | null };
}

function fakeCode(text: string, lang: string | null): FakeCode {
  return {
    textContent: text,
    innerHTML: '',
    dataset: {},
    parentNode: { getAttribute: (n: string) => (n === 'data-lang' ? lang : null) },
  };
}

let Hy: any;
beforeAll(async () => {
  // @ts-ignore 经典脚本，无类型声明
  await import('./highlight.js');
  Hy = (globalThis as unknown as { HyHighlight: any }).HyHighlight;
});

/** 装一个假引擎；返回"这个 scope 里有哪些 code 节点" */
function scopeWith(nodes: FakeCode[]) {
  return { querySelectorAll: () => nodes };
}

describe('normalizeLang', () => {
  it('大小写 / 前后空格归一', () => {
    expect(Hy.normalizeLang('  Python  ')).toBe('python');
    expect(Hy.normalizeLang('TypeScript')).toBe('typescript');
  });
  it('剥掉前导点（```.py 这种写法）', () => {
    expect(Hy.normalizeLang('.py')).toBe('py');
  });
  it('只取第一段（```python title=demo 的元信息不参与匹配）', () => {
    expect(Hy.normalizeLang('python title=demo')).toBe('python');
  });
  it('空值 → 空串（"没标语言"和"标了不认识的语言"必须可区分）', () => {
    expect(Hy.normalizeLang('')).toBe('');
    expect(Hy.normalizeLang(null)).toBe('');
    expect(Hy.normalizeLang(undefined)).toBe('');
  });
});

describe('着色决策', () => {
  const fakeEngine = (overrides: any = {}) => Object.assign({
    getLanguage: (l: string) => (l === 'python' || l === 'py' ? {} : null),
    highlight: (_t: string, _o: any) => ({ value: '<span class="hljs-keyword">def</span>' }),
    highlightAuto: (_t: string) => ({ value: 'x', relevance: 9, language: 'python' }),
  }, overrides);

  it('认识的语言 → 写入 hljs 的 span 并标记', () => {
    const node = fakeCode('def f(): pass', 'python');
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.innerHTML).toContain('hljs-keyword');
    expect(node.dataset.hl).toBe('python');
  });

  it('已处理过的节点不重复着色（流式重渲染会反复调）', () => {
    const node = fakeCode('def f(): pass', 'python');
    node.dataset.hl = 'python';
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.innerHTML).toBe('');
  });

  it('标了但不认识的语言 → 不动（等引擎扩语言，不要乱猜）', () => {
    const node = fakeCode('some text', 'brainfuck');
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.innerHTML).toBe('');
    expect(node.dataset.hl).toBe('skipped');
  });

  it('没标语言时走自动识别，可信度够就上色', () => {
    const node = fakeCode('def f():\n  return 1', '');
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.dataset.hl).toBe('python');
  });

  it('没标语言且识别可信度太低 → 保持纯文本（一段日志被涂成"疑似 python"更难读）', () => {
    const node = fakeCode('2026-10-23 10:00:01 INFO start', '');
    (globalThis as any).hljs = fakeEngine({ highlightAuto: () => ({ value: 'x', relevance: 1, language: 'bash' }) });
    Hy.highlightIn(scopeWith([node]));
    expect(node.innerHTML).toBe('');
    expect(node.dataset.hl).toBe('skipped');
  });

  it('超大块直接跳过（整文件/长日志着色会卡一下）', () => {
    const node = fakeCode('x'.repeat(Hy.MAX_LEN + 1), 'python');
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.dataset.hl).toBe('toolarge');
    expect(node.innerHTML).toBe('');
  });

  it('引擎自身抛错不影响正文（不能因为高亮失败让消息渲染挂掉）', () => {
    const node = fakeCode('def f(): pass', 'python');
    (globalThis as any).hljs = fakeEngine({ highlight: () => { throw new Error('boom'); } });
    expect(() => Hy.highlightIn(scopeWith([node]))).not.toThrow();
    expect(node.dataset.hl).toBe('skipped');
  });

  it('空代码块不处理', () => {
    const node = fakeCode('   ', 'python');
    (globalThis as any).hljs = fakeEngine();
    Hy.highlightIn(scopeWith([node]));
    expect(node.dataset.hl).toBe('empty');
  });
});

describe('引擎产物体检（vendor/hljs.min.js）', () => {
  it('能加载、别名已注册、输出经过转义', async () => {
    // @ts-ignore 构建期产物，无类型声明
    await import('./vendor/hljs.min.js');
    const hljs = (globalThis as unknown as { hljs: any }).hljs;
    expect(hljs).toBeTruthy();
    // ```py / ```ts / ```sh 必须命中，否则等于没注册
    for (const alias of ['py', 'ts', 'sh', 'yml', 'toml', 'html']) {
      expect(hljs.getLanguage(alias), `别名 ${alias} 未注册`).toBeTruthy();
    }
    const out = hljs.highlight('def f(x):\n  return x < 1 and "a"', { language: 'python' });
    expect(out.value).toContain('hljs-keyword');
    // 安全红线：模型输出里的 < & 必须被转义，绝不能原样进 innerHTML
    expect(out.value).toContain('&lt;');
    expect(out.value).toContain('&quot;');
  });
});
