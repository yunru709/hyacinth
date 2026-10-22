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

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HyMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  // ── 行内渲染 ──────────────────────────────────────────────────────
  // 顺序有讲究：代码段先抽走（其内容不再参与其它标记）→ 链接 → 粗体 → 斜体 → 删除线
  var PH = '\u0000'; // 占位符边界（入口已剥离输入里的 \u0000）

  function protect(store, html) {
    store.push(html);
    return PH + (store.length - 1) + PH;
  }

  function restore(s, store) {
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return store[+i] != null ? store[+i] : m;
    });
  }

  function inline(raw) {
    var store = [];
    var s = escapeHtml(raw);

    // ① 行内代码 `x`（内容已转义，且不再参与后续标记）
    s = s.replace(/`([^`\n]+)`/g, function (_m, code) {
      return protect(store, '<code class="md-code">' + code + '</code>');
    });

    // ② 图片 ![alt](url) —— 不加载远端图片（隐私），降级为链接
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, alt, url) {
      var href = safeUrl(url);
      if (href == null) return alt;
      return '<a class="md-link" href="' + href + '" target="_blank" rel="noopener noreferrer">'
        + (alt || href) + '</a>';
    });

    // ③ 链接 [text](url)
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, function (_m, text, url) {
      var href = safeUrl(url);
      if (href == null) return text; // 协议被拒 ⇒ 只留文字
      return '<a class="md-link" href="' + href + '" target="_blank" rel="noopener noreferrer">'
        + text + '</a>';
    });

    // ④ 裸链接自动识别（http/https）
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<>"）)]+)/g, function (_m, pre, url) {
      return pre + '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer">'
        + url + '</a>';
    });

    // ⑤ 粗体（先于斜体，避免 ** 被当成两个 *）
    s = s.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__([^\n_]+?)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');

    // ⑥ 斜体（_ 加词边界，避免 foo_bar_baz 被误伤）
    s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, '$1<em>$2</em>');

    // ⑦ 删除线
    s = s.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

    return restore(s, store);
  }

  // ── 块级解析 ──────────────────────────────────────────────────────

  var RE_FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.\-]*)\s*$/;
  var RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
  var RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|').map(function (c) { return c.trim(); });
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
      html.push('<li>' + inline(it.text) + '</li>');
    }
    while (stack.length) {
      html.push('</' + stack[stack.length - 1].tag + '>');
      stack.pop();
    }
    return html.join('\n');
  }

  function render(src) {
    var text = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/\u0000/g, ''); // 防伪造占位符
    var lines = text.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      if (!line.trim()) { i++; continue; }

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
        out.push('<pre class="message-code md-pre"'
          + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '')
          + '><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
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
        if (l2.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
        pbuf.push(l2);
        i++;
      }
      out.push('<p class="md-p">' + pbuf.map(inline).join('<br>') + '</p>');
    }

    return out.join('\n');
  }

  return { render: render, escapeHtml: escapeHtml, safeUrl: safeUrl };
});
