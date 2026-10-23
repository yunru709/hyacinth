// ════════════════════════════════════════════════════════════════════
// markdown.js — WebUI 的 markdown → HTML 渲染器
// ════════════════════════════════════════════════════════════════════
// 背景（本次修复的根因）：
//   交付正文（say 的 content）本来就是 markdown，而 WebUI 此前只有 esc()，
//   于是 `**加粗**`、``` 围栏 ```、`| 表格 |`、`# 标题` 全部**按字面显示** ✗
//   TUI 有渲染器（src/ui/markdown-message.ts）、WebUI 没有 ⇒ 两端观感不一致。
//
// 安全红线（模型输出 = 不可信输入）：
//   ① 任何文本进 HTML 前**先转义**，原文永不作为 HTML 解释（无原始 HTML 透传）
//   ② 链接协议白名单：只放行 http/https/mailto 与相对路径/锚点，
//      `javascript:` / `data:` / `vbscript:` 一律降级为纯文本
//   ③ 占位符用的 \u0000 在入口处被剥掉 ⇒ 模型无法伪造占位符注入 HTML
//
// 刻意不依赖 DOM（Node 下可直接单测；app.js 的 esc() 依赖 document，故不复用）。
//
// 载入方式：`<script src="/markdown.js">`（经典脚本，挂在 root.HyMarkdown）
//   同时在 Node/ESM 下挂到 globalThis ⇒ 测试可 `await import('./markdown.js')` 后取用。
// ════════════════════════════════════════════════════════════════════
//
// ── 数学公式（2026-10-23 新增）──────────────────────────────────────
// 为什么加：聊天里出现 LaTeX（`$$S_t = S_{t-1}(I-\beta k k^\top)+\dots$$`）时，
//   此前原样显示成一串反斜杠 ⇒ 完全不可读。WebUI 是浏览器，没有理由不渲。
//
// 为什么选 KaTeX 而不是 MathJax：
//   KaTeX 的 `renderToString()` 是**同步**的，与本文件"字符串进 → 字符串出"的
//   纯函数架构天然契合；MathJax 3（tex-svg）是**异步** typeset，要改造整个
//   app.js 的渲染时序。代价是 KaTeX 需要 60 个 woff2 字体文件（已 vendor 到
//   src/webui/vendor/katex/fonts/，共 ~1MB，桌面应用完全可接受）。
//
// ⚠️ 安全：**绝不设 `trust: true`**。KaTeX 的 trust 会放行 \href / \htmlClass /
//   \includegraphics 等可注入 HTML 属性的宏 ⇒ 等于给模型输出开了 HTML 透传后门，
//   直接击穿本文件第 ① 条红线。保持默认 trust:false。
//
// ⚠️ 占位符索引冲突（踩过）：inline() 内部有自己的局部 store（`\u0000N\u0000`），
//   如果块级公式也用 `\u0000N\u0000`，两套编号会从 0 同时开始 ⇒ **撞号**，
//   局部 restore 会把"公式占位符"误还原成"行内代码 HTML"。
//   ⇒ 数学占位符用**独立边界** `\u0001N\u0001`，并在入口同时剥掉两种字符。
//
// ⚠️ `$` 误伤：中文语境里"价格 $5 到 $10"不能被当公式。判据用 Pandoc 的规则：
//   开 `$` 后必须紧跟非空白，闭 `$` 前必须是非空白、后不能紧跟数字。
//   这样 `$5 到 $10`（闭 $ 前是空格）不会命中，`$S_t$` 正常命中。
//
// ⚠️ 提取顺序：**行内代码 (`) 先于行内公式 ($)**。反过来会把 `` `cost$` `` 里的
//   内容当公式。代码块（``` 围栏）在块级解析时就整段吃掉，天然不受影响。
//
// ── 2026-10-23 补充：兼容 LaTeX 的 `\(…\)` / `\[…\]` 分隔符 ──────────
// 模型常按 LaTeX 习惯输出 `\(a^2\)`、`\[E=mc^2\]`（OpenAI/Anthropic 的
// system prompt 里就是这套写法），只认 `$` 时它们会原样露出反斜杠。
// 两者等价：`\(…\)` = 行内、`\[…\]` = 块级。未闭合一律保留原文（同 `$$`）。
//
// ── 2026-10-23 补充：GFM 任务列表 `- [ ]` / `- [x]` ──────────────────
// 之前按字面渲染成 `[ ] 待办`；agent 的计划/清单几乎都用这个语法。

(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HyMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ── 基础转义 ──────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 链接协议白名单。返回 null = 拒绝（调用方降级为纯文本）。
   * 判定时先剥掉控制字符与空白，挡 `java\tscript:` 这类绕过。
   */
  function safeUrl(raw) {
    var u = String(raw == null ? '' : raw).trim();
    if (!u) return null;
    var probe = u.replace(/[\u0000-\u0020\u007F]+/g, '').toLowerCase();
    if (/^(https?:|mailto:)/.test(probe)) return u;
    // 任何其它 scheme（javascript:/data:/vbscript:/file:…）一律拒
    if (/^[a-z][a-z0-9+.\-]*:/.test(probe)) return null;
    return u; // 相对路径 / 锚点
  }

  // ── 数学公式渲染 ──────────────────────────────────────────────────
  /**
   * 把 TeX 源码渲染成 HTML 片段。
   *
   * 降级链（三级，任一失败都不抛、不吞内容）：
   *   ① KaTeX 可用 → renderToString（throwOnError:false ⇒ 非法公式由 KaTeX 自己
   *      输出红色原文，用户仍能看见他写了什么）
   *   ② KaTeX 不可用（Node 单测 / vendor 加载失败）→ `<code>` 原文
   *   ③ 连 escapeHtml 都异常 → 不可能，兜底返回空串
   *
   * @param {string} tex  TeX 源码（未转义原文）
   * @param {boolean} displayMode true = 块级（$$…$$），false = 行内（$…$）
   */
  function renderMath(tex, displayMode) {
    var src = String(tex == null ? '' : tex);
    var K = root && root.katex;
    if (K && typeof K.renderToString === 'function') {
      try {
        return K.renderToString(src, {
          displayMode: !!displayMode,
          throwOnError: false, // 非法公式 ⇒ 红色原文，不抛
          errorColor: '#e05252',
          strict: false, // 未知命令只降级不报错（模型常写非标准宏）
          trust: false, // ⚠️ 红线：不放行 \href/\htmlClass/\includegraphics
          output: 'htmlAndMathml', // MathML 附带 ⇒ 屏幕阅读器可用
        });
      } catch (e) {
        /* 落到 ② */
      }
    }
    return '<code class="md-math-fallback">' + escapeHtml(src) + '</code>';
  }

  /**
   * 这段文本里有没有**会被渲染成公式**的东西？
   *
   * 用途：KaTeX 是 272KB JS + 25KB CSS 的常驻重量级资源，整场对话没有公式时不该下。
   * 于是渲染方在渲染前先问一句，只有真有公式才去加载引擎（见 math.js）。
   *
   * ⚠️ 必须先剔除代码：``` 围栏和行内 `…` 里的 `$` **不会**被当公式，
   *   若据此加载就是白下 300KB —— 而代码块在对话里比公式常见得多。
   *   剔除规则与块级解析保持一致（RE_FENCE / 行内代码的定界符）。
   *
   * ⚠️ 宁可**误报**也不能漏报：漏报 = 公式永远停在 fallback 的 `<code>` 原文，
   *   用户看到的是一串反斜杠；误报只是多下一次脚本。所以这里不追求精确。
   */
  var RE_MATH_HINT = /(?:\$\$|\\\(|\\\[)|(?:^|[^\\$])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?!\d)/;

  /**
   * 按行剔除围栏代码块（逻辑与块级解析的 ① 完全一致：开闭必须是同一种符号）。
   *
   * ⚠️ 不能用一条 `/^```[\s\S]*?^```$/gm` 正则偷懒：`[\s\S]*?` 是惰性的，
   *    而 `m` 标志下的 `$` 能匹配**任意行尾**，于是它在开围栏后第一个换行处就
   *    判定"已到结尾"，匹配到的只有 ``` 这三个字符 —— 围栏**内容没被剔除**，
   *    等于这个防误报措施完全失效（实测 ` ```\n$x$\n``` ` 仍被判成有公式）。
   */
  function stripFences(s) {
    var lines = String(s).split('\n');
    var out = [];
    var marker = null;
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].match(RE_FENCE);
      if (f) {
        var ch = f[1].charAt(0);
        if (!marker) { marker = ch; out.push(' '); continue; }
        if (ch === marker) { marker = null; out.push(' '); continue; }
      }
      out.push(marker ? ' ' : lines[i]); // 未闭合 ⇒ 吃到结尾（与渲染器一致）
    }
    return out.join('\n');
  }

  function needsMath(text) {
    var s = String(text == null ? '' : text);
    if (!s) return false;
    // 行内代码同理：`` `cost$price` `` 里的 $ 不是公式定界符
    s = stripFences(s).replace(/`[^`\n]*`/g, ' ');
    return RE_MATH_HINT.test(s);
  }

  // ── 行内渲染 ──────────────────────────────────────────────────────
  // 顺序有讲究：代码段先抽走（其内容不再参与其它标记）→ 公式 → 链接 → 粗体 → 斜体 → 删除线
  var PH = '\u0000'; // 行内代码占位符边界（入口已剥离输入里的 \u0000）
  var MPH = '\u0001'; // 数学占位符边界（独立于 PH，避免索引撞号）

  function protect(store, html) {
    store.push(html);
    return PH + (store.length - 1) + PH;
  }

  function restore(s, store) {
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return store[+i] != null ? store[+i] : m;
    });
  }

  /**
   * 行内公式正则。分组：1=前缀字符（须回填） 2=TeX 源码。
   *
   * 为什么带前缀分组：`(^|[^\\$])` 用来吃掉 `$` 前面的那个字符，否则
   * `replace` 会把"前一个字"一起吞掉（`a $x$ b` → `a <span>… b`，少了空格）。
   *
   * 为什么排除 `\\$`：`\$` 是转义的字面美元符，不该开启公式。
   */
  var RE_INLINE_MATH = /(^|[^\\$])\$(?![\s$])([^$\n]*?[^\s\\$])\$(?!\d)/g;

  function inline(raw) {
    var store = [];
    var s = String(raw == null ? '' : raw);

    // ① 行内代码 `x` —— **在转义之前**提取，内容单独转义后入 store。
    //    （必须最先做：代码里的 $ 和 * 都不能参与后续解析）
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
      store.push('<code class="md-code">' + escapeHtml(code) + '</code>');
      return PH + (store.length - 1) + PH;
    });

    // ② 行内公式 $…$ —— 同样在转义之前，KaTeX 要吃**原文**。
    //    ⚠️ 若放在 escapeHtml 之后，`a < b` 已被转成 `a &lt; b`，KaTeX 会渲染错。
    s = s.replace(RE_INLINE_MATH, function (_m, pre, tex) {
      store.push(renderMath(tex, false));
      return pre + PH + (store.length - 1) + PH;
    });

    // ②b 行内公式 \(…\)（LaTeX 习惯写法，与 $…$ 等价）
    //     不能跨行：跨行的 \( 多半是正文里的字面反斜杠，渲染成公式反而更糟。
    //     前缀分组同理用来回填被正则吃掉的第一个字符。
    s = s.replace(/(^|[^\\])\\\(([^\n]*?[^\s\\])\\\)/g, function (_m, pre, tex) {
      store.push(renderMath(tex, false));
      return pre + PH + (store.length - 1) + PH;
    });

    // ③ 其余全部转义（占位符 \u0000N\u0000 不在转义表里，安全穿过）
    s = escapeHtml(s);

    // ④ 图片 ![alt](url) —— 不加载远端图片（隐私），降级为链接
    //    URL 允许成对括号：`https://en.wikipedia.org/wiki/A_(b)` 里的 `)` 不是定界符。
    //    旧写法 `[^)\s]+` 会在第一个 `)` 处截断，于是危险协议被拒后还会残留一个 `)`。
    s = s.replace(/!\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, alt, url) {
      var href = safeUrl(url);
      if (href == null) return alt;
      return '<a class="md-link" href="' + href + '" target="_blank" rel="noopener noreferrer">'
        + (alt || href) + '</a>';
    });

    // ⑤ 链接 [text](url)
    s = s.replace(/\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, text, url) {
      var href = safeUrl(url);
      if (href == null) return text; // 协议被拒 ⇒ 只留文字
      return '<a class="md-link" href="' + href + '" target="_blank" rel="noopener noreferrer">'
        + text + '</a>';
    });

    // ⑥ 裸链接自动识别（http/https）
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, function (_m, pre, url) {
      return pre + '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer">'
        + url + '</a>';
    });

    // ⑦ 粗体（先于斜体，避免 ** 被当成两个 *）
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^\n_]+?)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');

    // ⑧ 斜体（_ 加词边界，避免 foo_bar_baz 被误伤）
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, '$1<em>$2</em>');

    // ⑨ 删除线
    s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

    // ⑩ 转义美元符还原：`\$5` 要显示成 `$5`，否则公式功能一上线，
    //    所有想写"字面美元"的地方都会多出一条反斜杠。
    //    （store 里的代码/公式内容不在此列，它们已经是占位符了）
    s = s.replace(/\\\$/g, '$');

    return restore(s, store);
  }

  // ── 块级解析 ──────────────────────────────────────────────────────

  var RE_FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.\-]*)\s*$/;
  var RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
  var RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var RE_MATH_LINE = /^\u0001(\d+)\u0001$/; // 独占一行的块级公式占位符

  /**
   * 切表格行。
   *
   * 不能直接 `split('|')`：单元格内容里的 `\|` 是**转义的竖线**（GFM 合法写法，
   * 例如 `| a \| b |` 想表达单元格内容 `a | b`），直接切会把一列劈成两列。
   * 手写扫描：遇到 `\|` 收成一个字面 `|`，只对未转义的 `|` 断列。
   *
   * 首尾的 `|` 可省略（GFM 允许），所以断出来的空首/空尾片段要丢掉。
   */
  function splitRow(line) {
    var src = String(line == null ? '' : line).trim();
    var cells = [];
    var cur = '';
    var sawPipe = false;
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i);
      if (ch === '\\' && src.charAt(i + 1) === '|') { cur += '|'; i++; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; sawPipe = true; continue; }
      cur += ch;
    }
    cells.push(cur);
    // 行首/行尾的管道会切出一个空片段，按 GFM 丢掉（中间的空列要保留）
    var startsPipe = src.charAt(0) === '|';
    var endsPipe = src.charAt(src.length - 1) === '|'
      && !(src.length >= 2 && src.charAt(src.length - 2) === '\\');
    if (sawPipe && startsPipe && !cells[0].trim()) cells.shift();
    if (sawPipe && endsPipe && !cells[cells.length - 1].trim()) cells.pop();
    return cells.map(function (c) { return c.trim(); });
  }

  /**
   * 分隔行判定（GFM：每格是 `:?-+:?`，即**1 个以上**连字符）。
   *
   * ⚠️ 曾写成单条大正则且要求 `-{2,}` ⇒ `| :-- | --: | :-: |` 的第三格（只有 1 个连字符）
   *    被判非法，**整张表被拒**（视觉验收截图抓出；当时单测只有两列、每格 2 个连字符，
   *    恰好绕过）。现改为按单元格判定，对齐 GFM 的 1+ 连字符。
   */
  function isTableSep(line) {
    if (line.indexOf('-') < 0) return false;
    var cells = splitRow(line);
    if (!cells.length) return false;
    return cells.every(function (c) { return /^:?-+:?$/.test(c); });
  }

  function alignOf(sep) {
    var out = splitRow(sep).map(function (c) {
      var l = c.charAt(0) === ':';
      var r = c.charAt(c.length - 1) === ':';
      if (l && r) return 'center';
      if (r) return 'right';
      if (l) return 'left';
      return '';
    });
    return out;
  }

  /** 收集连续列表项 → 用缩进栈生成嵌套 ul/ol */
  function renderList(items) {
    var html = [];
    var stack = []; // { tag, indent }

    function open(tag, indent) {
      stack.push({ tag: tag, indent: indent });
      html.push(tag === 'ol' ? '<ol>' : '<ul>');
    }
    function closeTo(indent) {
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
        html.push('</' + stack[stack.length - 1].tag + '>');
        stack.pop();
      }
    }

    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var tag = it.ordered ? 'ol' : 'ul';
      var indent = it.indent;
      if (!stack.length) {
        open(tag, indent);
      } else if (indent > stack[stack.length - 1].indent) {
        open(tag, indent); // 更深 ⇒ 起嵌套
      } else {
        closeTo(indent);
        if (tag !== stack[stack.length - 1].tag) {
          // 同层换类型（ul↔ol）⇒ 关掉重开
          html.push('</' + stack[stack.length - 1].tag + '>');
          stack.pop();
          open(tag, indent);
        }
      }
      // GFM 任务列表：`- [ ] 待办` / `- [x] 已完成`。
      // 渲染成真 checkbox（disabled：聊天里的勾选状态只反映 agent 的声明，不该可点）。
      // 安全：只写死 type="checkbox"，勾选态来自 `[x]` 的布尔判断，不拼接原文。
      var task = /^\[([ xX])\](?:\s+([\s\S]*))?$/.exec(it.text);
      if (task) {
        var done = task[1] !== ' ';
        html.push('<li class="md-task' + (done ? ' is-done' : '') + '">'
          + '<input type="checkbox" disabled' + (done ? ' checked' : '') + '>'
          + '<span>' + inline(task[2] || '') + '</span></li>');
      } else {
        html.push('<li>' + inline(it.text) + '</li>');
      }
    }
    while (stack.length) {
      html.push('</' + stack[stack.length - 1].tag + '>');
      stack.pop();
    }
    return html.join('\n');
  }

  /**
   * 块级公式提取 —— **必须在按行切分之前**做，因为 `$$…$$` 可以跨行。
   *
   * 替换成「一行仅含 \u0001N\u0001」⇒ 后续块解析会把它识别成独占一段的公式块，
   * 而不会混进段落/列表/表格里去。
   *
   * ⚠️ 围栏代码块里的 `$$` 不能被当公式。故先按围栏分段，跳过的段原样保留。
   */
  function extractDisplayMath(text, store) {
    var out = [];
    var lines = text.split('\n');
    var i = 0;
    var inFence = false;

    for (var n = 0; n < lines.length; n++) {
      var line = lines[n];
      if (RE_FENCE.test(line)) {
        inFence = !inFence;
        out.push(line);
        continue;
      }
      if (inFence) { out.push(line); continue; }

      // 单行完整公式：$$ x $$ 或 \[ x \]
      // ⚠️ 空公式（`$$   $$`）必须原样保留：若渲染就会留下一个**空的 md-math-block**，
      //    在聊天气泡里表现为莫名多出一行空白。用户多半是笔误，看得见原文更好。
      var one = line.match(/^\s*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])\s*$/);
      if (one) {
        var texOne = (one[1] != null ? one[1] : (one[2] || '')).trim();
        if (texOne) {
          store.push('<div class="md-math-block">' + renderMath(texOne, true) + '</div>');
          out.push(MPH + (store.length - 1) + MPH);
        } else {
          out.push(line);
        }
        continue;
      }

      // 跨行公式：本行以 $$ / \[ 开头但没在本行闭合 ⇒ 吃到闭合行
      var openIdx = n;
      var open = line.match(/^\s*(?:\$\$(.*)|\\\[(.*))$/);
      if (open) {
        var isBracket = open[2] !== undefined; // \[ … \] 形式
        var closer = isBracket ? '\\]' : '$$';
        var buf = [isBracket ? open[2] : open[1]];
        var closed = false;
        var tail = '';
        for (var j = n + 1; j < lines.length; j++) {
          var closeAt = lines[j].indexOf(closer);
          if (closeAt >= 0) {
            buf.push(lines[j].slice(0, closeAt));
            // 闭合行后面若还跟着正文，别丢掉（`$$ x $$ 后面还有字` 这种）
            tail = lines[j].slice(closeAt + closer.length);
            n = j;
            closed = true;
            break;
          }
          buf.push(lines[j]);
        }
        var texMulti = buf.join('\n').trim();
        if (closed && texMulti) {
          store.push('<div class="md-math-block">' + renderMath(texMulti, true) + '</div>');
          out.push(MPH + (store.length - 1) + MPH);
          if (tail.trim()) out.push(tail);
          continue;
        }
        if (closed) {
          // 跨行的空公式（$$⏎⏎$$）：与单行空公式一致 ⇒ 原文照登，不产空块
          for (var q = openIdx; q <= n; q++) out.push(lines[q]);
          continue;
        }
        // 未闭合 ⇒ 只剩本行原样输出，**不推进 n**，后续行仍由主循环各自处理。
        // （buf 里那些行是"预读"的，closed=false 时等于白读，交回主循环才不会重复/丢弃）
        out.push(line);
        continue;
      }

      out.push(line);
    }
    return out.join('\n');
  }

  function restoreMath(html, store) {
    return html.replace(/\u0001(\d+)\u0001/g, function (m, i) {
      return store[+i] != null ? store[+i] : m;
    });
  }

  function render(src) {
    var text = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000\u0001]/g, ''); // 防伪造占位符（两种边界一起剥）

    // ① 先在**整段文本**上提取块级公式（可跨行），替换为独占一行的占位符
    var mathStore = [];
    text = extractDisplayMath(text, mathStore);

    var lines = text.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

      // ⓪ 块级公式（已在上面提取，此处只认「整行就是一个占位符」）
      var mline = line.match(RE_MATH_LINE);
      if (mline) {
        out.push(mathStore[+mline[1]] != null ? mathStore[+mline[1]] : '');
        i++;
        continue;
      }

      // ① 围栏代码块
      var fence = line.match(RE_FENCE);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = fence[2] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var close = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
          if (close && close[1].charAt(0) === marker) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        // 包一层 .md-code-block：头行放语言名 + 复制按钮。
        // 为什么语言名要显示出来：同一条回复里常有 python/bash/json 混排，
        // 只有底色没有标签时读者得靠语法猜这是哪种语言。未知语言写 "code"（不硬猜）。
        var langLabel = lang ? escapeHtml(lang) : 'code';
        out.push('<div class="md-code-block">'
          + '<div class="md-code-head">'
          + '<span class="md-code-lang">' + langLabel + '</span>'
          + '<button class="md-code-copy" type="button" aria-label="复制代码">复制</button>'
          + '</div>'
          + '<pre class="message-code md-pre"'
          + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '')
          + '><code>' + escapeHtml(buf.join('\n')) + '</code></pre>'
          + '</div>');
        continue;
      }

      // ② 标题
      var hd = line.match(RE_HEADING);
      if (hd) {
        var lvl = hd[1].length;
        out.push('<h' + lvl + ' class="md-h">' + inline(hd[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // ③ 分隔线（须在列表之前判，避免 --- 被当列表）
      if (RE_HR.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }

      // ④ 表格（表头 + 分隔行）
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = splitRow(line);
        var aligns = alignOf(lines[i + 1]);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var th = head.map(function (c, idx) {
          var a = aligns[idx] || '';
          return '<th' + (a ? ' class="md-' + a + '"' : '') + '>' + inline(c) + '</th>';
        }).join('');
        var tb = rows.map(function (r) {
          return '<tr>' + head.map(function (_c, idx) {
            var a = aligns[idx] || '';
            return '<td' + (a ? ' class="md-' + a + '"' : '') + '>'
              + inline(r[idx] == null ? '' : r[idx]) + '</td>';
          }).join('') + '</tr>';
        }).join('');
        out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>'
          + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>');
        continue;
      }

      // ⑤ 引用块（连续 > 行，内部递归渲染）
      if (RE_QUOTE.test(line)) {
        var qbuf = [];
        while (i < lines.length && RE_QUOTE.test(lines[i])) {
          qbuf.push(lines[i].match(RE_QUOTE)[1]);
          i++;
        }
        out.push('<blockquote class="md-quote">' + render(qbuf.join('\n')) + '</blockquote>');
        continue;
      }

      // ⑥ 列表（连续项；含缩进嵌套）
      if (RE_ITEM.test(line)) {
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(RE_ITEM);
          if (!m) break;
          items.push({
            indent: Math.floor(m[1].replace(/\t/g, '  ').length / 2),
            ordered: /^\d/.test(m[2]),
            text: m[3],
          });
          i++;
        }
        out.push(renderList(items));
        continue;
      }

      // ⑦ 段落（连续非块级行；单换行 ⇒ <br>，聊天场景更贴近原文观感）
      var pbuf = [line];
      i++;
      while (i < lines.length) {
        var l2 = lines[i];
        if (!l2.trim()) break;
        if (RE_FENCE.test(l2) || RE_HEADING.test(l2) || RE_HR.test(l2)
          || RE_QUOTE.test(l2) || RE_ITEM.test(l2)) break;
        if (RE_MATH_LINE.test(l2)) break; // 块级公式独占一段
        if (l2.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
        pbuf.push(l2);
        i++;
      }
      out.push('<p class="md-p">' + pbuf.map(inline).join('<br>') + '</p>');
    }

    // 兜底：万一还有块级占位符漏在段落里（不该发生），这里统一还原
    return restoreMath(out.join('\n'), mathStore);
  }

  return {
    render: render,
    escapeHtml: escapeHtml,
    safeUrl: safeUrl,
    renderMath: renderMath,
    needsMath: needsMath,
  };
});
