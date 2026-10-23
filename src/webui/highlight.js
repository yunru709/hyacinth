// ============================================================
// highlight.js — WebUI 代码块语法高亮（前端包装层）
// ============================================================
//
// 职责边界：
//   - 引擎本体是 `vendor/hljs.min.js`（highlight.js 裁剪版，构建期产物，
//     由 scripts/gen-highlight.cjs 生成），**按需加载**：整场对话没有代码块
//     就一个字节都不下（katex 就是常驻加载的，没必要再添一个）。
//   - 本文件只做三件事：① 按需注入引擎 ② 把 `pre.md-pre > code` 着色
//     ③ 语言名归一化。它是经典脚本，挂在 window.HyHighlight。
//
// 安全：高亮输入取的是 DOM 的 textContent（浏览器已反转义），hljs 输出
// 时会对 `<`/`&` 再转义一次 ⇒ 不存在把模型输出当 HTML 执行的路径。
// 引擎侧还配了 ignoreUnescapedHTML，避免对合法代码刷警告。
// ============================================================

(function (global) {
  'use strict';

  var ENGINE_SRC = '/vendor/hljs.min.js';
  /** 超过这个长度就不高亮：超大输出（日志/整文件）着色会明显卡一下 */
  var MAX_LEN = 60000;
  /** 自动识别的最低可信度；低于它多半是日志/纯文本，硬上色反而更难读 */
  var AUTO_MIN_RELEVANCE = 3;

  var loading = null;

  function engine() {
    return global.hljs || null;
  }

  /** 注入引擎脚本（幂等；失败可重试） */
  function ensureEngine() {
    var hl = engine();
    if (hl) return Promise.resolve(hl);
    if (loading) return loading;

    loading = new Promise(function (resolve, reject) {
      if (typeof document === 'undefined') { reject(new Error('no document')); return; }
      var s = document.createElement('script');
      s.src = ENGINE_SRC;
      s.async = true;
      s.onload = function () {
        var got = engine();
        got ? resolve(got) : reject(new Error('高亮引擎已加载但未注册 hljs'));
      };
      s.onerror = function () { reject(new Error('高亮引擎加载失败')); };
      document.head.appendChild(s);
    });

    // 失败要清掉 loading，否则下一次永远复用这个 rejected promise，无法重试
    return loading.catch(function (e) { loading = null; throw e; });
  }

  /**
   * 归一化围栏语言串。
   * 只处理"写法差异"（大小写、前导点、带提示符），**不做别名表** ——
   * 别名全在引擎里注册过，由 hljs.getLanguage() 现查，避免两处维护。
   */
  function normalizeLang(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    if (s.charAt(0) === '.') s = s.slice(1);            // ```.py
    var sp = s.indexOf(' ');
    if (sp > 0) s = s.slice(0, sp);                      // ```python title=xxx
    return s;
  }

  /** 单个 <code> 着色；返回是否成功 */
  function paint(codeEl, hl) {
    if (codeEl.dataset.hl) return false;                 // 已处理过（含"跳过"）
    var text = codeEl.textContent || '';
    if (!text.trim()) { codeEl.dataset.hl = 'empty'; return false; }
    if (text.length > MAX_LEN) { codeEl.dataset.hl = 'toolarge'; return false; }

    var pre = codeEl.parentNode;
    var lang = normalizeLang(pre && pre.getAttribute ? pre.getAttribute('data-lang') : '');
    var html = null;

    try {
      if (lang && hl.getLanguage(lang)) {
        html = hl.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } else if (!lang) {
        // 没标语言 ⇒ 只做一次自动识别。可信度太低就保持纯文本：
        // 把一段日志涂成"疑似 python"比不涂更难读。
        var auto = hl.highlightAuto(text);
        if (auto && auto.relevance >= AUTO_MIN_RELEVANCE) {
          html = auto.value;
          lang = auto.language || '';
        }
      }
      // 标了但不认识的语言 ⇒ 不动，等引擎扩语言
    } catch (e) {
      html = null;
    }

    if (!html) { codeEl.dataset.hl = 'skipped'; return false; }
    codeEl.innerHTML = html;
    codeEl.dataset.hl = lang || 'auto';
    return true;
  }

  /**
   * 给 root 下所有未处理的代码块着色。
   * 引擎尚未就绪 ⇒ 后台加载，加载完自动补扫全文档（此时首屏那些块也会被补上）。
   */
  function highlightIn(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll('pre.md-pre > code');
    if (!nodes.length) return;

    var hl = engine();
    if (!hl) {
      ensureEngine().then(function () { highlightIn(document); }).catch(function () { /* 引擎没来就算了，纯文本照样能看 */ });
      return;
    }
    for (var i = 0; i < nodes.length; i++) paint(nodes[i], hl);
  }

  global.HyHighlight = {
    normalizeLang: normalizeLang,
    ensureEngine: ensureEngine,
    highlightIn: highlightIn,
    MAX_LEN: MAX_LEN,
    AUTO_MIN_RELEVANCE: AUTO_MIN_RELEVANCE,
  };
})(typeof window !== 'undefined' ? window : globalThis);
