/**
 * markdown.test.ts — WebUI markdown 渲染器
 *
 * 覆盖两类风险：
 *   ① 功能：交付正文是 markdown，此前按字面显示（`**粗**`、围栏、表格全裸奔）
 *   ② **安全**：模型输出是不可信输入 ⇒ 原始 HTML 必须被转义、危险协议必须被拒、
 *      占位符不可被伪造。这几条是本次修复的红线，必须有测试盯住。
 *
 * 载入方式：markdown.js 是浏览器经典脚本（无 ESM 导出），执行时挂到 globalThis，
 * 故这里用副作用 import + 取 globalThis.HyMarkdown。
 */
import { beforeAll, describe, expect, it } from 'vitest';

let render: (src: string) => string;

beforeAll(async () => {
  // @ts-ignore markdown.js 是浏览器经典脚本，无类型声明
  await import('./markdown.js');
  render = (globalThis as unknown as { HyMarkdown: { render: (s: string) => string } }).HyMarkdown.render;
});

describe('markdown 渲染 — 块级', () => {
  it('标题 1~6 级', () => {
    expect(render('# 标题')).toBe('<h1 class="md-h">标题</h1>');
    expect(render('### 三级')).toBe('<h3 class="md-h">三级</h3>');
    expect(render('###### 六级')).toBe('<h6 class="md-h">六级</h6>');
  });

  it('围栏代码块：保留换行 + 不解释内容', () => {
    const html = render('```js\nconst a = 1;\nif (a < 2) {}\n```');
    expect(html).toContain('<pre class="message-code md-pre" data-lang="js">');
    expect(html).toContain('<code>');
    expect(html).toContain('const a = 1;\nif (a &lt; 2) {}');
  });

  it('围栏代码块：无语言标注也能闭合', () => {
    expect(render('```\nplain\n```')).toContain('plain');
  });

  it('未闭合的围栏块吃到结尾（不吞掉后续内容）', () => {
    const html = render('```\nabc');
    expect(html).toContain('abc');
  });

  it('无序列表 / 有序列表', () => {
    expect(render('- a\n- b')).toBe('<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    expect(render('1. a\n2. b')).toBe('<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it('列表嵌套（缩进 2 空格一层）', () => {
    const html = render('- a\n  - a1\n- b');
    expect(html).toContain('<ul>');
    expect(html.match(/<ul>/g)?.length).toBe(2);
    expect(html).toContain('<li>a1</li>');
  });

  it('表格：表头/分隔/对齐', () => {
    const html = render('| a | b |\n| :-- | --: |\n| 1 | 2 |');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th class="md-left">a</th>');
    expect(html).toContain('<th class="md-right">b</th>');
    expect(html).toContain('<td class="md-left">1</td>');
    expect(html).toContain('<td class="md-right">2</td>');
  });

  it('表格：三列（回归 —— 曾因分隔行正则过严而整表不渲染）', () => {
    // 视觉验收抓出的缺陷：`| :-- | --: | :-: |` 的第三格只有 1 个连字符，
    // 旧实现要求 -{2,} ⇒ 判定为非分隔行 ⇒ 整张表被当成普通段落 ✗
    const html = render('| 模型 | 输入 | 输出 |\n| :-- | --: | :-: |\n| A | 1 | 2 |');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th class="md-left">模型</th>');
    expect(html).toContain('<th class="md-center">输出</th>');
    expect(html).toContain('<td class="md-center">2</td>');
  });

  it('表格：单连字符分隔行（GFM 合法）', () => {
    expect(render('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table class="md-table">');
    expect(render('| a | b |\n| :-: | :-: |\n| 1 | 2 |')).toContain('<table class="md-table">');
  });

  it('表格：只有表头没有分隔行 ⇒ 不误判为表格', () => {
    const html = render('| a | b |\n| 1 | 2 |');
    expect(html).not.toContain('<table');
    expect(html).toContain('md-p');
  });

  it('表格：无外框管道（GFM 允许省略首尾 |）', () => {
    const html = render('a | b\n--- | ---\n1 | 2');
    expect(html).toContain('<table class="md-table">');
  });

  it('引用块（内部再渲染）', () => {
    const html = render('> **粗**');
    expect(html).toContain('<blockquote class="md-quote">');
    expect(html).toContain('<strong>粗</strong>');
  });

  it('分隔线', () => {
    expect(render('---')).toContain('<hr class="md-hr">');
    expect(render('***')).toContain('<hr class="md-hr">');
  });

  it('段落：单换行保留为 <br>（聊天观感，不再压成一整段）', () => {
    expect(render('第一行\n第二行')).toBe('<p class="md-p">第一行<br>第二行</p>');
  });

  it('空行分段', () => {
    expect(render('a\n\nb')).toBe('<p class="md-p">a</p>\n<p class="md-p">b</p>');
  });
});

describe('markdown 渲染 — 行内', () => {
  it('粗体 / 斜体 / 删除线', () => {
    expect(render('**粗**')).toContain('<strong>粗</strong>');
    expect(render('*斜*')).toContain('<em>斜</em>');
    expect(render('~~删~~')).toContain('<del>删</del>');
  });

  it('snake_case 不被误判为斜体', () => {
    expect(render('foo_bar_baz')).not.toContain('<em>');
  });

  it('行内代码：内容字面保留，不参与其它标记', () => {
    expect(render('`**not bold**`')).toContain('<code class="md-code">**not bold**</code>');
  });

  it('链接：http/https 放行且带安全属性', () => {
    const html = render('[站点](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('裸链接自动识别', () => {
    expect(render('见 https://example.com/x 结束')).toContain('<a class="md-link" href="https://example.com/x"');
  });

  it('图片降级为链接（不加载远端图片）', () => {
    const html = render('![图](https://example.com/a.png)');
    expect(html).toContain('<a class="md-link"');
    expect(html).not.toContain('<img');
  });
});

describe('markdown 渲染 — 安全红线（模型输出不可信）', () => {
  it('原始 HTML 一律被转义，绝不解释', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('事件属性注入被转义（img onerror）', () => {
    const html = render('<img src=x onerror=alert(1)>');
    // 判据是「没有元素被创建」——`onerror=` 作为**转义后的纯文本**出现是安全的，
    // 不能要求它消失（那会把"文本里出现该字样"误判成漏洞）。
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('javascript: 协议被拒 → 只留文字，不产生 <a>', () => {
    const html = render('[点我](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('点我');
  });

  it('javascript: 夹控制字符的绕过被拒', () => {
    expect(render('[x](java\tscript:alert(1))')).not.toContain('<a ');
    expect(render('[x](java\nscript:alert(1))')).not.toContain('<a ');
    expect(render('[x](JAVASCRIPT:alert(1))')).not.toContain('<a ');
  });

  it('data: / vbscript: / file: 协议被拒', () => {
    expect(render('[x](data:text/html,<script>alert(1)</script>)')).not.toContain('<a ');
    expect(render('[x](vbscript:msgbox(1))')).not.toContain('<a ');
    expect(render('[x](file:///etc/passwd)')).not.toContain('<a ');
  });

  it('mailto 与相对路径/锚点放行', () => {
    expect(render('[信](mailto:a@b.com)')).toContain('href="mailto:a@b.com"');
    expect(render('[内](#/settings)')).toContain('href="#/settings"');
  });

  it('占位符不可被伪造（输入里的 \\u0000 被剥离）', () => {
    const html = render('a\u00000\u0000b');
    // 既不能凭空造出标签，也不能把占位符残留进产物
    expect(html).not.toContain('\u0000');
    expect(html).not.toContain('<code');
  });

  it('加粗里的 HTML 同样被转义', () => {
    const html = render('**<b>x</b>**');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('代码块里的 HTML 被转义', () => {
    const html = render('```\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('标题里的 HTML 被转义', () => {
    const html = render('# <img src=x onerror=1>');
    expect(html).not.toContain('<img');
  });
});

describe('markdown 渲染 — 健壮性', () => {
  it('空输入 / null 不抛错', () => {
    expect(render('')).toBe('');
    expect(render(null as unknown as string)).toBe('');
    expect(render(undefined as unknown as string)).toBe('');
  });

  it('CRLF 被归一', () => {
    expect(render('a\r\nb')).toBe('<p class="md-p">a<br>b</p>');
  });

  it('纯文本原样成段', () => {
    expect(render('你好')).toBe('<p class="md-p">你好</p>');
  });
});

/**
 * 数学公式（2026-10-23 新增）
 *
 * Node 单测环境没有 vendor 的 KaTeX ⇒ 默认走 `md-math-fallback` 降级。
 * 这里**注入一个假 katex**，验证「调用契约」而不是 KaTeX 自己的排版结果：
 *   - 块级必须 `displayMode: true`，行内必须 false
 *   - **`trust` 必须为 false** ← 红线：true 会放行 \href/\htmlClass，
 *     等于给模型输出开 HTML 透传后门
 *   - 送进 KaTeX 的必须是**原文**（不能被 escapeHtml 先转成 &lt;）
 */
describe('markdown 渲染 — 数学公式', () => {
  type Call = { tex: string; opts: Record<string, unknown> };
  let calls: Call[] = [];
  const g = globalThis as unknown as { katex?: unknown };
  let saved: unknown;

  beforeAll(() => {
    saved = g.katex;
    g.katex = {
      renderToString(tex: string, opts: Record<string, unknown>) {
        calls.push({ tex, opts });
        return '<span class="katex-stub" data-display="' + String(opts.displayMode) + '"></span>';
      },
    };
  });

  afterAll(() => {
    g.katex = saved;
  });

  beforeEach(() => {
    calls = [];
  });

  it('块级 $$…$$ ⇒ md-math-block，displayMode=true', () => {
    const html = render('$$S_t = S_{t-1}(I-\\beta k k^\\top)$$');
    expect(html).toContain('md-math-block');
    expect(html).toContain('katex-stub');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.displayMode).toBe(true);
    expect(calls[0].tex).toBe('S_t = S_{t-1}(I-\\beta k k^\\top)');
  });

  it('行内 $…$ ⇒ 不包 block，displayMode=false', () => {
    const html = render('设 $d \\times d$ 为状态维度');
    expect(html).toContain('katex-stub');
    expect(html).not.toContain('md-math-block');
    expect(calls[0].opts.displayMode).toBe(false);
    expect(calls[0].tex).toBe('d \\times d');
  });

  it('跨行块级公式整段收全（不被拆成两段）', () => {
    const html = render('$$\na = b \\\\\nc = d\n$$');
    expect(html.match(/md-math-block/g)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].tex).toContain('a = b');
    expect(calls[0].tex).toContain('c = d');
  });

  it('安全红线：trust 恒为 false，且不允许 \href 等宏获得信任', () => {
    render('$$\\href{javascript:alert(1)}{click}$$');
    expect(calls[0].opts.trust).toBe(false);
    // 同时确认没有把 errorColor/strict 之类做成可被输入影响的值
    expect(typeof calls[0].opts.strict).toBe('boolean');
  });

  it('公式源码以原文送进 KaTeX（未被 escapeHtml 污染）', () => {
    render('$a < b \\& c$');
    expect(calls[0].tex).toBe('a < b \\& c');
  });

  it('$ 不误伤货币：价格 $5 到 $10 保持纯文本', () => {
    const html = render('价格 $5 到 $10 元');
    expect(html).not.toContain('katex-stub');
    expect(html).toContain('$5 到 $10');
  });

  it('围栏代码块里的 $$ 不被当公式', () => {
    const html = render('```tex\n$$x^2$$\n```');
    expect(html).not.toContain('katex-stub');
    expect(html).toContain('$$x^2$$');
  });

  it('行内代码里的 $ 不被当公式', () => {
    const html = render('价格是 `$5` 而已');
    expect(html).not.toContain('katex-stub');
    expect(html).toContain('<code class="md-code">$5</code>');
  });

  it('未闭合的 $$ 不吞内容', () => {
    const html = render('$$\n没收尾');
    expect(html).toContain('没收尾');
  });

  it('KaTeX 不可用时降级为 code 原文（不丢内容）', () => {
    const keep = g.katex;
    delete g.katex;
    try {
      const html = render('$$a^2+b^2$$');
      expect(html).toContain('md-math-fallback');
      expect(html).toContain('a^2+b^2');
    } finally {
      g.katex = keep;
    }
  });

  it('空公式 $$ $$ 不产生 KaTeX 调用', () => {
    const html = render('$$   $$');
    expect(html).not.toContain('katex-stub');
  });
});
