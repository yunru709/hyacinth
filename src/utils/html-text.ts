/**
 * html-text.ts — HTML → 可读正文提取（纯函数，无 IO）
 *
 * 为什么需要它（别退回正则替换）：
 *   `html.replace(/<[^>]+>/g, '')` 这一类写法有两个致命坑，都真实踩过：
 *     1. 代码块里出现裸 `<`（如 `a < b`、`x-oss` 之类的比较/JSX 片段）会被当成标签开头，
 *        一路吞到下一个 `>`，把大段正文吃掉；
 *     2. 非贪婪匹配 `<article>[\s\S]*?</article>` 遇到嵌套/多个同名元素时只取第一段，
 *        正文被腰斩。
 *   所以这里用**单趟状态机**做真分词：正确识别注释、CDATA、带引号的属性、
 *   自闭合标签，并维护元素栈以支持"跳过整棵子树"。
 *
 * 面向"反 AI 网页"的两条主动防御（与项目的路线 A 同思路：在边界上设卡）：
 *   - **不可见文本剥离**：`display:none` / `visibility:hidden` / `opacity:0` /
 *     `font-size:0` / 负缩进 / `aria-hidden` / `hidden` 属性，以及零宽字符
 *     （U+200B..U+200D、U+2060、U+FEFF）—— 这些是往上下文里"塞东西"的主要载体。
 *     剥离后**计数并回报**，让调用方知道"这页试图藏东西"，而不是默默扔掉。
 *   - **注释里的指令痕迹**：HTML 注释会被丢弃，但若注释里出现明显的指令式措辞
 *     （ignore previous / system prompt / instruction 等），单独记一笔。
 *
 * 设计取舍：先剥离、后计量。截断预算只花在真实正文上，而不是花在 nav/script/style 上。
 */

/** 整棵子树都不产出文本的标签 */
const SKIP_SUBTREE = new Set([
  'script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe',
  'object', 'embed', 'audio', 'video', 'map', 'picture', 'source',
  // 站点 chrome：导航 / 侧栏 / 页脚几乎全是菜单与版权，属于"无用标签"的主体。
  // 需要完整原始内容时走 http_request 的 format:"raw"。
  // 注意 header 不在此列 —— 文章标题与导语常落在 article/header 里。
  'nav', 'aside', 'footer', 'form', 'button', 'select', 'option',
]);

/** 块级标签：进入/离开时补换行，保证段落不粘成一行 */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
  'br', 'hr', 'li', 'tr', 'table', 'thead', 'tbody', 'tfoot', 'ul', 'ol', 'dl',
  'dd', 'dt', 'blockquote', 'pre', 'figure', 'figcaption', 'form', 'fieldset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'summary',
]);

/** 常见命名实体（够用即可，其余走数值解码） */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', laquo: '«', raquo: '»',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0',
  times: '\u00d7', divide: '\u00f7', bull: '\u2022', dagger: '\u2020',
  larr: '\u2190', rarr: '\u2192', harr: '\u2194', le: '\u2264', ge: '\u2265',
  ne: '\u2260', infin: '\u221e', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  sect: '\u00a7', para: '\u00b6', permil: '\u2030', prime: '\u2032',
};

/** 零宽 / 双向控制字符：反 AI 塞东西的经典载体 */
const INVISIBLE = /[\u200b\u200c\u200d\u2060\ufeff\u00ad\u202a-\u202e\u2066-\u2069]/g;

/** 隐藏元素判定 */
const HIDDEN_STYLE = /(?:display\s*:\s*none)|(?:visibility\s*:\s*hidden)|(?:opacity\s*:\s*0(?![\d.]))|(?:font-size\s*:\s*0(?![\d.]))|(?:text-indent\s*:\s*-\d{3,})|(?:left\s*:\s*-\d{3,})|(?:clip\s*:\s*rect\(\s*0)/i;

/** 注释里的指令式措辞（不是硬判定，只做提示） */
const SUSPICIOUS_COMMENT = /(ignore\s+(?:all\s+)?previous|system\s*prompt|you\s+are\s+an?\s+ai|instruction[s]?\s*:|忽略(?:之前|以上)|系统提示词)/i;

/** 反爬 / 拦截页特征 */
const BOT_WALL: Array<[RegExp, string]> = [
  [/just\s+a\s+moment/i, 'cloudflare-js-challenge'],
  [/(checking\s+your\s+browser|cf-browser-verification|cf_chl_opt)/i, 'cloudflare-checking'],
  [/(enable\s+javascript|javascript\s+is\s+(?:disabled|required))/i, 'requires-javascript'],
  [/(attention\s+required\s*[!|]|cloudflare)/i, 'cloudflare-block'],
  [/(请开启\s*JavaScript|需要启用\s*JavaScript)/i, 'requires-javascript'],
  [/(人机验证|访问验证|安全验证|验证你是真人)/, 'captcha-wall'],
  [/(captcha|recaptcha|hcaptcha|turnstile)/i, 'captcha'],
  [/access\s+denied|403\s+forbidden/i, 'access-denied'],
];

export interface ExtractStats {
  htmlChars: number;
  textChars: number;
  /** 被判定为隐藏而整棵跳过的元素数 */
  strippedHiddenElements: number;
  /** 剥离的零宽/控制字符数 */
  strippedInvisibleChars: number;
  /** 注释里的指令式措辞命中数（提示用，不等于攻击） */
  suspiciousComments: number;
  /** 反爬/拦截页特征（命中即为该特征名，未命中为 null） */
  botWall: string | null;
  truncated: boolean;
}

export interface ExtractResult {
  title: string;
  text: string;
  stats: ExtractStats;
}

/** 解码数值实体与命名实体 */
function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/**
 * 解析开标签：返回标签名、属性串、是否自闭合。
 * 关键：必须按引号状态扫描，否则 `style="a>b"` 里的 `>` 会被误判为标签结束。
 */
function parseOpenTag(html: string, start: number): { name: string; attrs: string; end: number; selfClosing: boolean } {
  let i = start + 1;
  let name = '';
  while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i]!)) { name += html[i]; i++; }
  const attrStart = i;
  let quote: string | null = null;
  let selfClosing = false;
  for (; i < html.length; i++) {
    const c = html[i]!;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') { selfClosing = html[i - 1] === '/'; break; }
  }
  return { name: name.toLowerCase(), attrs: html.slice(attrStart, i), end: Math.min(i + 1, html.length), selfClosing };
}

function isHiddenTag(name: string, attrs: string): boolean {
  // hidden 属性（html5）
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
  const style = /style\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const styleVal = style ? (style[2] ?? style[3] ?? style[4] ?? '') : '';
  if (styleVal && HIDDEN_STYLE.test(styleVal)) return true;
  // 常见工具类（sr-only 是 a11y 用的视觉隐藏，同样不进正文）
  const cls = /\b(?:class|id)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const clsVal = cls ? (cls[2] ?? cls[3] ?? '') : '';
  if (clsVal && /(?:^|[\s_-])(?:hidden|visually-hidden|sr-only|d-none|hide)(?:$|[\s_-])/i.test(clsVal)) return true;
  return false;
}

/**
 * 从提取出的正文里切出某一节（按标题匹配）。
 *
 * 与 extractReadableText 配套：后者把 <h1..h6> 渲染成 `#`*n 开头的行，故这里按同一格式解析。
 * 区间 = 命中标题 → 下一个"同级或更高级"标题之前（子标题会被包含进来）。
 *
 * @param needle 用于匹配标题的子串（大小写不敏感）
 * @returns 命中信息与正文；**无标题或未命中时返回 null**，由调用方给出引导（例如提示先取全文）。
 */
export function sliceSection(
  text: string,
  needle: string,
): { body: string; matched: string; headingCount: number } | null {
  const lines = text.split('\n');
  const heads: Array<{ i: number; level: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (m) heads.push({ i, level: m[1]!.length, title: m[2]!.trim() });
  }
  if (heads.length === 0) return null;

  const key = needle.trim().toLowerCase();
  const hits = heads.filter((h) => h.title.toLowerCase().includes(key));
  if (hits.length === 0) return null;

  const first = hits[0]!;
  let end = lines.length;
  for (const h of heads) {
    if (h.i <= first.i) continue;
    if (h.level <= first.level) { end = h.i; break; }
  }
  return { body: lines.slice(first.i, end).join('\n'), matched: first.title, headingCount: hits.length };
}

export function extractReadableText(html: string, opts: { maxChars?: number; keepLinks?: boolean } = {}): ExtractResult {
  const keepLinks = opts.keepLinks === true;
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : Infinity;

  let out = '';
  let strippedHiddenElements = 0;
  let strippedInvisibleChars = 0;
  let suspiciousComments = 0;
  let title = '';

  // 元素栈：每项 { name, hidden }；hidden 为真时其子树文本全部丢弃
  const stack: Array<{ name: string; hidden: boolean }> = [];
  const inHidden = () => stack.some((s) => s.hidden);
  const inSkip = () => stack.some((s) => SKIP_SUBTREE.has(s.name));

  const push = (s: string) => {
    if (s) out += s;
  };
  const newline = (n = 1) => {
    if (out.length === 0) return;
    // 避免连续空行堆积
    if (/\n$/.test(out)) return;
    out += '\n'.repeat(n);
  };

  let i = 0;
  let pendingLinkHref: string | null = null;

  while (i < html.length) {
    const lt = html.indexOf('<', i);

    // ── 纯文本段 ──
    if (lt === -1 || lt > i) {
      const seg = html.slice(i, lt === -1 ? undefined : lt);
      if (!inHidden() && !inSkip()) {
        // <pre> 内保留原空白；其余折叠
        const inPre = stack.some((s) => s.name === 'pre');
        let t = decodeEntities(seg);
        // 必须先剥零宽、再折叠空白：U+FEFF 等属于 JS 的 \s 类，
        // 若先折叠会被替换成普通空格，之后就再也剥不掉了（实测踩过）。
        const beforeInvisible = t.length;
        t = t.replace(INVISIBLE, '');
        strippedInvisibleChars += beforeInvisible - t.length;
        if (!inPre) t = t.replace(/\s+/g, ' ');
        push(t);
      }
      if (lt === -1) break;
      i = lt;
      continue;
    }

    // ── 注释 / CDATA / DOCTYPE ──
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      const body = html.slice(i + 4, close === -1 ? undefined : close);
      if (SUSPICIOUS_COMMENT.test(body)) suspiciousComments++;
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', i)) {
      const close = html.indexOf(']]>', i + 9);
      const body = html.slice(i + 9, close === -1 ? undefined : close);
      if (!inHidden() && !inSkip()) push(body);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      const close = html.indexOf('>', i);
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    // ── 闭标签 ──
    if (html[i + 1] === '/') {
      const close = html.indexOf('>', i);
      const name = html.slice(i + 2, close === -1 ? undefined : close).trim().toLowerCase();
      // 弹出到匹配项（容错：脏 HTML 常有未闭合标签）
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.name === name) { stack.length = k; break; }
      }
      // 闭合围栏前必须先换行，否则会与末行粘连（实测出现 `}``` `，破坏 markdown 代码块）
      if (name === 'pre') { newline(); push('```'); newline(); }
      else if (name === 'code') { if (!stack.some((s) => s.name === 'pre')) push('`'); }
      else if (BLOCK.has(name)) newline();
      if (name === 'a' && keepLinks && pendingLinkHref) { push(` (${pendingLinkHref})`); pendingLinkHref = null; }
      i = close === -1 ? html.length : close + 1;
      continue;
    }

    // ── 开标签 ──
    const tag = parseOpenTag(html, i);
    if (!tag.name) { i++; continue; }

    if (tag.name === 'title' && !inSkip()) {
      const close = html.toLowerCase().indexOf('</title>', tag.end);
      title = decodeEntities(html.slice(tag.end, close === -1 ? undefined : close)).replace(/\s+/g, ' ').trim();
    }

    if (tag.selfClosing) {
      if (BLOCK.has(tag.name)) newline();
      i = tag.end;
      continue;
    }

    const hidden = isHiddenTag(tag.name, tag.attrs);
    if (hidden) strippedHiddenElements++;

    if (!hidden && !inHidden() && !inSkip()) {
      if (tag.name === 'a' && keepLinks) {
        const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag.attrs);
        const hv = href ? (href[2] ?? href[3] ?? href[4] ?? '') : '';
        pendingLinkHref = /^https?:/i.test(hv) ? hv : null;
      }
      if (/^h[1-6]$/.test(tag.name)) {
        newline();
        push('#'.repeat(Number(tag.name[1])) + ' ');
      } else if (tag.name === 'li') {
        newline();
        push('- ');
      } else if (tag.name === 'pre') {
        newline();
        push('```\n');
      } else if (tag.name === 'code') {
        // 行内 code 只加反引号、**不换行** —— 换行会把句子切断
        // （实测："顺手看一眼 ~/.zcode 为什么占了 700MB" 被拆成三行）。
        if (!stack.some((s) => s.name === 'pre')) push('`');
      } else if (BLOCK.has(tag.name)) {
        newline();
      }
    }

    stack.push({ name: tag.name, hidden });
    i = tag.end;
  }

  // ── 收尾清理 ──
  let text = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const botWall = BOT_WALL.find(([re]) => re.test(text) || re.test(html.slice(0, 20000)))?.[1] ?? null;

  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  return {
    title,
    text,
    stats: {
      htmlChars: html.length,
      textChars: text.length,
      strippedHiddenElements,
      strippedInvisibleChars,
      suspiciousComments,
      botWall,
      truncated,
    },
  };
}
