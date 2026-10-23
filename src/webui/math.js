// ============================================================
// math.js — WebUI 公式渲染（KaTeX 的按需加载层）
// ============================================================
//
// 为什么要有这一层：
//   KaTeX 是 vendor 里最重的常驻资源（katex.min.js 267KB + katex.min.css 25KB）。
//   原先 index.html 里 `<script src="/vendor/katex/katex.min.js">` 是**无条件同步加载**的
//   —— 也就是说，一场从头到尾没有公式的对话，也要先下 267KB 才能出首屏。
//   实测首屏被 ~178KB 渲染阻塞 CSS 卡住，再叠 267KB 脚本解析，意义不大。
//
// 改法：与本项目的语法高亮（highlight.js）同构 —— **只有正文里真出现公式时才加载**：
//   ① 渲染前用 `HyMarkdown.needsMath(text)` 问一句（它会先剔除代码块，避免误报）
//   ② 没公式 ⇒ 一个字节都不下；公式此时按降级样式显示为 `<code>` 原文（可读、可复制）
//   ③ 有公式 ⇒ 注入 CSS + JS，加载完成后**重新渲染**那些节点（公式从原文变成排版）
//
// 代价：第一条含公式的消息会有一帧"原文 → 公式"的跳变（本地加载 ~10ms，几乎不可见）。
//   换来的是无公式场景省掉 292KB。取舍是明确的。
//
// 职责边界：本文件只管"把 window.katex 准备好"。渲染仍是 markdown.js 的
//   renderMath() 干的（它每帧读 root.katex，引擎一到就自动生效，无需通知）。
// ============================================================

(function (global) {
  'use strict';

  var JS_SRC = '/vendor/katex/katex.min.js';
  var CSS_SRC = '/vendor/katex/katex.min.css';

  var loading = null;   // 进行中的加载 Promise（幂等）
  var queue = [];       // 引擎就绪后要执行的回调

  function ready() {
    var K = global.katex;
    return !!(K && typeof K.renderToString === 'function');
  }

  /** 降级判据：markdown.js 不在时用最粗糙的启发式（宁可多下，不可漏下） */
  function needs(text) {
    var M = global.HyMarkdown;
    if (M && typeof M.needsMath === 'function') return M.needsMath(text);
    return /\$\$|\\\(|\\\[|\$/.test(String(text == null ? '' : text));
  }

  /**
   * 插入 KaTeX 样式表（幂等）。
   * 插在**第一个样式表之前**，而不是追加到末尾：原 index.html 里
   * `/vendor/katex/katex.min.css` 就排在 app.css 前面，靠的是"后来者覆盖"；
   * 动态注入若追加到末尾，KaTeX 的 `.katex{font-size:1.21em}` 会翻到
   * app.css 的 `.msg-rich .katex{font-size:1.06em}` 之后（虽然靠特异性仍能赢，
   * 但没必要把顺序这个保险也丢掉）。
   */
  function ensureCss() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('link[data-hy-katex="css"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_SRC;
    link.setAttribute('data-hy-katex', 'css');
    var first = document.head.querySelector('link[rel="stylesheet"]');
    if (first && first.parentNode) document.head.insertBefore(link, first);
    else document.head.appendChild(link);
  }

  /** 加载引擎（幂等；失败可重试） */
  function ensure() {
    if (ready()) return Promise.resolve(true);
    if (loading) return loading;

    ensureCss();
    loading = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { reject(new Error('no document')); return; }
      var s = document.createElement('script');
      s.src = JS_SRC;
      s.async = true;
      s.onload = function () {
        ready() ? resolve(true) : reject(new Error('KaTeX 已加载但未注册 window.katex'));
      };
      s.onerror = function () { reject(new Error('KaTeX 加载失败')); };
      document.head.appendChild(s);
    });

    return loading.then(function (ok) {
      flush();
      return ok;
    }).catch(function (e) {
      // 失败也清掉缓存，否则下一次永远复用这个 rejected promise，无法重试
      loading = null;
      // 加载失败 ⇒ 公式停在 fallback 原文，队列里的回调整体放弃（不该无限等）
      queue.length = 0;
      throw e;
    });
  }

  function flush() {
    var pending = queue.slice();
    queue.length = 0;
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](); } catch (e) { /* 单个节点渲染失败不影响其它 */ }
    }
  }

  /**
   * 引擎就绪后执行 fn。
   * ⚠️ 已就绪时是**同步**调用 —— 调用方必须保证 fn 内部不会再次走到这里，
   *    否则会无限递归（app.js 里的判据因此写成 `needs(text) && !ready()`）。
   */
  function whenReady(fn) {
    if (ready()) { try { fn(); } catch (e) { /* 忽略 */ } return; }
    queue.push(fn);
    ensure().catch(function () { /* 已清空队列，不再抛 */ });
  }

  global.HyMath = {
    ready: ready,
    needs: needs,
    ensure: ensure,
    whenReady: whenReady,
    JS_SRC: JS_SRC,
    CSS_SRC: CSS_SRC,
  };
})(typeof window !== 'undefined' ? window : globalThis);
