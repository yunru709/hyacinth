/* ══════════════════════════════════════════════════════════════════════════
   Markdown 渲染器 —— 三套设计语言共用
   ══════════════════════════════════════════════════════════════════════════

   为什么自己写而不是引 marked/markdown-it：
     1. 只要一个子集（加粗/斜体/行内码/代码块/标题/列表/引用/分隔线/表格/链接）
     2. 需要绝对可控的转义顺序（内容来自模型，必须防注入）
     3. 仓库没有前端构建步骤，多一个依赖就多一次打包问题

   ⚠️ 安全模型：**所有文本先 escape，再套 Markdown 规则**。
      顺序反了就是 XSS。行内规则只产出我们自己的标签。

   ⚠️ 谁该用它：
      editorial / classic 用（要排版）
      **tui 不用** —— 终端语境里渲染 Markdown 反而破坏等宽观感，
      那是设计语言的差异，不是遗漏。
   ══════════════════════════════════════════════════════════════════════════ */

/** HTML 转义。任何进入 innerHTML 的原文都必须先过这里。 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 行内规则。入参**必须已经 escape 过**。 */
function inline(s) {
  return s
    /* 行内代码先做，避免内部的 * 被当成强调 */
    .replace(/`([^`\n]+)`/g, (_, code) => `<code class="md-code">${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    /* 单星号斜体：要求两侧不是星号，避免吃掉 ** 的残片 */
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** 把 Markdown 转成 HTML 字符串。 */
export function renderMarkdown(src) {
  let text = String(src ?? '');

  /* ── 1. 先把代码块摘走 ──
     否则块内的 # 、* 、| 会被当成标题/强调/表格规则处理。
     用 \u0000 占位：它不是 HTML 特殊字符，escape 动不到它。 */
  const blocks = [];
  text = text.replace(/```([\w+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: lang.trim(), code: code.replace(/\r?\n$/, '') });
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  /* 没有闭合的 ``` （流式输出的中间态）：从 ``` 到结尾都当代码块 */
  text = text.replace(/```([\w+#.-]*)[ \t]*\r?\n([\s\S]*)$/, (_, lang, code) => {
    blocks.push({ lang: lang.trim(), code });
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const lines = text.split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p class="md-p">${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    /* 空行 = 段落分隔 */
    if (!t) { flushAll(); continue; }

    /* 代码块占位 */
    const bm = /^\u0000B(\d+)\u0000$/.exec(t);
    if (bm) {
      flushAll();
      const { lang, code } = blocks[Number(bm[1])];
      out.push(
        `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(code)}</code></pre>`,
      );
      continue;
    }

    /* 标题 */
    const hm = /^(#{1,4})\s+(.*)$/.exec(t);
    if (hm) {
      flushAll();
      const lv = Math.min(hm[1].length + 1, 5); // # → h2，留出 h1 给页面标题
      out.push(`<h${lv} class="md-h">${inline(escapeHtml(hm[2]))}</h${lv}>`);
      continue;
    }

    /* 分隔线 */
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushAll();
      out.push('<hr class="md-hr">');
      continue;
    }

    /* 引用（支持连续多行合并成一个 blockquote） */
    const qm = /^>\s?(.*)$/.exec(t);
    if (qm) {
      flushAll();
      const buf = [qm[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1].trim())) {
        i++;
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
      }
      out.push(`<blockquote class="md-quote">${inline(escapeHtml(buf.join('\n')))}</blockquote>`);
      continue;
    }

    /* 表格：连续的 | … | 行，第二行是 |---|---| 分隔 */
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushAll();
      const parseRow = (row) =>
        row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = parseRow(t);
      i++; // 跳过分隔行
      const body = [];
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) {
        i++;
        body.push(parseRow(lines[i]));
      }
      const th = head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('');
      const trs = body
        .map((cells) => `<tr>${cells.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    /* 无序列表 */
    const um = /^[-*+]\s+(.*)$/.exec(t);
    if (um) {
      flushPara();
      if (list !== 'ul') { flushList(); out.push('<ul class="md-ul">'); list = 'ul'; }
      out.push(`<li>${inline(escapeHtml(um[1]))}</li>`);
      continue;
    }

    /* 有序列表 */
    const om = /^\d+[.)]\s+(.*)$/.exec(t);
    if (om) {
      flushPara();
      if (list !== 'ol') { flushList(); out.push('<ol class="md-ol">'); list = 'ol'; }
      out.push(`<li>${inline(escapeHtml(om[1]))}</li>`);
      continue;
    }

    /* 普通段落行 */
    flushList();
    para.push(escapeHtml(t));
  }
  flushAll();
  return out.join('');
}
