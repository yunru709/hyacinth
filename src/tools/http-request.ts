import type { Tool } from './interface.js';
import { getToolConfig } from './tool-config.js';
import { checkNetwork } from '../kernel/security/index.js';
import { extractReadableText, sliceSection } from '../utils/html-text.js';

/**
 * HttpRequestTool — HTTP 客户端，支持 GET/POST/PUT/DELETE。
 * 轻量爬虫 + API 调试。
 *
 * 关于 HTML 处理（2026-09-18 升级）：
 *   此前直接把响应体原样返回，HTML 里的 nav/script/style/隐藏文本全部灌进上下文，
 *   既费 token 又给"反 AI 网页塞垃圾"留了门。现在：
 *     - 默认对 HTML/XML 响应做**正文提取**（`src/utils/html-text.ts`），
 *       并可剥离 display:none / 零宽字符等**不可见文本**（会计数上报）；
 *     - `format: "raw"` 可拿回未经处理的原始响应体（调试用）；
 *     - 截断**先剥离后计量**，预算只花在真实正文上；截断提示带上真实阈值
 *       （此前硬编码 "50KB"，与可配置阈值脱节，误导排查）。
 *   JSON 等非 HTML 响应体不受影响。
 *
 * 2026-09-18 第二批（按需深挖）：
 *   - `keepLinks: true`  → 链接渲染为 `文本 (https://...)`，便于顺着链接继续查；
 *   - `section: "小标题"` → **只取该节**（按提取出的 `#` 标题切分），不必把整页读完；
 *   - `urls: [...]`      → 一次抓多个（上限 MAX_URLS，串行、逐个标注来源），
 *                          避免为看几页文档来回 N 次调用。
 */
export class HttpRequestTool implements Tool {
  readonly name = 'http_request';
  readonly description =
    '发起 HTTP 请求。支持 GET / POST / PUT / DELETE / PATCH / HEAD / OPTIONS，自定义 headers、body、超时和 cookies。默认 User-Agent 模拟浏览器。适用于轻量网页抓取、API 调试和数据获取。' +
    'HTML/XML 响应默认做正文提取（剥离 nav/script/style 与不可见文本，附统计），可用 format="raw" 取原始响应体；' +
    'keepLinks=true 把链接渲染成「文本 (url)」；section="小标题" 只取该节；urls=[...] 一次抓多个（最多 5 个）。' +
    'json=true 时自动设置 Content-Type 为 application/json。' +
    '若某页抽取近乎为空（会附 [hint]）——多为 JS 渲染的搜索页/壳页，优先改抓该站的 RSS/JSON/API 端点（如搜索引擎的 "&format=rss"），别硬刮 HTML。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要请求的 URL（http:// 或 https://）。提供此项或 urls。' },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: '一次调用抓取多个 URL（串行，最多 5 个，每个结果都标注其 URL）。提供此项或 url。',
      },
      method: {
        type: 'string',
        description: 'HTTP 方法。默认：GET',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      },
      headers: {
        type: 'string',
        description: '自定义 headers 的 JSON 字符串。覆盖默认值。',
      },
      body: {
        type: 'string',
        description: '请求体字符串。若为 JSON，请设置 Content-Type header 或使用 json 标志。',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒）。默认：30000（30 秒）。上限：120000（2 分钟）。',
      },
      json: {
        type: 'boolean',
        description: '为 true 时，body 被视为 JSON，且 Content-Type 设为 application/json。默认：false。',
      },
      format: {
        type: 'string',
        enum: ['auto', 'text', 'raw'],
        description:
          '响应体处理方式。"auto"（默认）= 对 HTML/XML 提取可读正文，其他类型保持原样。"text" = 强制提取。"raw" = 返回未经处理的响应体。',
      },
      keepLinks: {
        type: 'boolean',
        description: '在提取出的正文中把链接渲染为 "文本 (https://…)"。默认：false。',
      },
      section: {
        type: 'string',
        description:
          '只返回标题包含该字符串的章节（大小写不敏感）。需要开启提取（format auto/text）。可用于避免拉取整篇长页面。',
      },
      select: {
        type: 'string',
        description:
          '对 **JSON** 响应做字段投影，只回你要的字段 —— 避免大 JSON 撑爆工具结果被截断。'
          + '语法：点号路径分隔层级，`[]` 表示"对该数组逐元素应用后续段"，末尾 `{a,b,c}` 表示"只留这几个字段"。'
          + '例：select="results[].{title,publication_year,doi}" · select="data.items[].name" · select="meta.count"。'
          + '另：值为「词 → 位置数组」形状的对象（如 OpenAlex 的 abstract_inverted_index）会自动还原成正文字符串。',
      },
    },
    required: [],
  };

  private static readonly DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  /** 一次调用最多抓几个 URL */
  private static readonly MAX_URLS = 5;

  async execute(args: Record<string, unknown>): Promise<string> {
    const single = typeof args.url === 'string' && args.url ? args.url : undefined;
    const rawList = Array.isArray(args.urls)
      ? (args.urls as unknown[]).filter((u): u is string => typeof u === 'string' && !!u)
      : [];
    if (!single && rawList.length === 0) {
      // 措辞里必须保留历史子串 "url is required"（既有契约测试断言它）。
      // 曾写成 'url (or urls) is required.' 直接把那条测试撞红 —— 是契约先于措辞。
      return 'Error: url is required (or provide urls).';
    }
    const maxUrls = HttpRequestTool.MAX_URLS;
    const targets = single ? [single] : rawList.slice(0, maxUrls);
    const skipped = single ? 0 : Math.max(0, rawList.length - maxUrls);

    const method = ((args.method as string) ?? 'GET').toUpperCase();
    const body = args.body as string | undefined;
    const isJson = args.json === true;
    const format = ((args.format as string) ?? 'auto').toLowerCase();
    const keepLinks = args.keepLinks === true;
    const section = typeof args.section === 'string' && args.section.trim() ? args.section.trim() : undefined;
    // ★ select：JSON 字段投影表达式（语法见 schema 里的描述与文末 projectJson 的注释）
    const select = typeof args.select === 'string' && args.select.trim() ? args.select.trim() : undefined;
    // tools.http.timeoutMs（默认 30000）；硬上限 120000 保留为安全边界
    const timeoutMs = Math.min(
      (args.timeout as number) ?? getToolConfig('http.timeoutMs', 30000),
      120000,
    );
    const maxBytes = getToolConfig('http.maxResponseBytes', 512 * 1024);

    // Parse custom headers
    let customHeaders: Record<string, string> = {};
    if (typeof args.headers === 'string' && args.headers.trim()) {
      try {
        customHeaders = JSON.parse(args.headers);
      } catch {
        return 'Error: headers must be a valid JSON string.';
      }
    }

    // Build final headers
    const headers: Record<string, string> = {
      'User-Agent': HttpRequestTool.DEFAULT_UA,
      Accept: '*/*',
    };
    if (isJson) {
      headers['Content-Type'] = 'application/json';
    } else if (body !== undefined && !customHeaders['Content-Type']) {
      headers['Content-Type'] = 'text/plain';
    }
    Object.assign(headers, customHeaders);

    const ctx: FetchCtx = { method, headers, body, timeoutMs, maxBytes, format, keepLinks, section, select };

    if (targets.length === 1) return this.fetchOne(targets[0]!, ctx);

    // 多 URL：串行（对目标站更友好），逐个标注来源，便于事后归因
    const parts: string[] = [];
    for (const t of targets) {
      parts.push(`########## ${t}\n${await this.fetchOne(t, ctx)}`);
    }
    if (skipped > 0) parts.push(`(${skipped} more url(s) skipped — this tool fetches at most ${maxUrls} per call)`);
    return parts.join('\n\n');
  }

  /** 取一个 URL 并格式化输出（提取 / 原样 / 错误三种形态） */
  private async fetchOne(url: string, ctx: FetchCtx): Promise<string> {
    const { method, headers, body, timeoutMs, format, keepLinks, section } = ctx;
    // ★ 有 select 时放宽**接收**上限 —— 这是投影能成立的前提。
    //   投影的意义正是"把大 JSON 收窄"，但**截断发生在投影之前**（见下方 reader 循环）：
    //   若仍按 ctx.maxBytes 截断，超限的 JSON 会变成半截 ⇒ JSON.parse 失败 ⇒ 投影恒定失效、白给。
    //   实测踩过：npm 包文档 58KB、而配置 tools.http.maxResponseBytes=51200
    //     ⇒ select 永远回 "[select] ignored"，偏偏小 JSON 正常 ⇒ 极易误判成"表达式写错"。
    //   放宽到 8MB 并保留硬上限，避免 select 变成"无视任何上限地拉大文件"。
    //   注：HTML 抽取路径不受影响（select 只对非 markup 响应生效）。
    const maxBytes = ctx.select ? Math.max(ctx.maxBytes, 8 * 1024 * 1024) : ctx.maxBytes;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // 双保险：内核已在 fetch 边界拦私网（LLM 归因），此处按 URL 再查一次，
    // 保证即使 fetch 守卫失效（degraded/off）工具层仍有 SSRF 防线
    const netDecision = checkNetwork(url);
    if (!netDecision.allowed) {
      clearTimeout(timer);
      return `Error: ${netDecision.reason}`;
    }

    try {
      const fetchInit: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        fetchInit.body = body;
      }

      const response = await fetch(url, fetchInit);
      clearTimeout(timer);

      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });
      const contentType = respHeaders['content-type'] ?? '';

      // 收字节而不是边收边解码：字符集要等拿到 header / meta 才能定，
      // 否则 GBK 页面会被当 UTF-8 解成乱码（中文站点常见）。
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let rawTruncated = false;
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            const keep = value.length - (totalBytes - maxBytes);
            if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
            rawTruncated = true;
            reader.cancel();
            break;
          }
          chunks.push(Buffer.from(value));
        }
      }
      const bytes = Buffer.concat(chunks);

      const charset = sniffCharset(bytes, contentType);
      let decoded: string;
      let usedCharset = charset;
      try {
        decoded = new TextDecoder(charset).decode(bytes);
      } catch {
        decoded = new TextDecoder('utf-8').decode(bytes);
        usedCharset = 'utf-8 (fallback: unsupported charset label)';
      }

      const isMarkup = /(?:text\/html|application\/xhtml\+xml|application\/xml|text\/xml|\+xml)/i.test(contentType)
        || /^\s*<(?:!doctype|html)\b/i.test(decoded);
      const wantExtract = isMarkup && format !== 'raw';

      const lines: string[] = [
        `HTTP ${response.status} ${response.statusText}`,
        `URL: ${url}`,
        contentType ? `Content-Type: ${contentType}` : '',
        `Body: ${totalBytes} bytes (charset ${usedCharset})`,
      ];

      let payload: string;
      if (wantExtract) {
        const r = extractReadableText(decoded, { maxChars: maxBytes, keepLinks });
        const s = r.stats;
        const notes = [
          `html ${s.htmlChars} → text ${s.textChars} chars`,
          keepLinks ? 'links on' : '',
          s.strippedHiddenElements > 0 ? `hidden stripped: ${s.strippedHiddenElements}` : '',
          s.strippedInvisibleChars > 0 ? `zero-width stripped: ${s.strippedInvisibleChars}` : '',
          s.suspiciousComments > 0 ? `suspicious comments: ${s.suspiciousComments}` : '',
        ].filter(Boolean).join(' | ');
        lines.push(`[extract] ${notes}`);
        lines.push(`[extract] pass format:"raw" for the untouched body`);
        if (s.botWall) {
          lines.push(`[WARN] looks like an anti-bot / challenge page: ${s.botWall} — content may be a placeholder, not the real page`);
        }
        if (rawTruncated) lines.push(`[WARN] raw body hit the ${Math.round(maxBytes / 1024)}KB cap before extraction`);
        if (r.title) lines.push(`[title] ${r.title}`);

        // 抽取近乎为空、但响应体不小 ⇒ 多半是 JS 渲染页 / 壳页，而不是"这页没有正文"。
        // 旧行为只留一句 "pass format:raw"，而 raw 常被 50KB 截断、且整页往往只有一整行，
        // 等于把调用方晾在原地（实测：Bing 搜索页 html 50904 → text 29 chars）。
        // 这里把真正的出路（换机器口）说清楚，再附 300 字符原始头，
        // 让调用方一眼分辨：JS 壳 / 反爬墙 / 还是正文被内嵌进了 JSON。
        if (!section && s.textChars < 200 && totalBytes >= 4096) {
          lines.push(
            `[WARN] extraction nearly empty (${s.textChars} chars from ${totalBytes} bytes)`
            + ' — page is likely JS-rendered or a shell page, not a static-HTML extraction defect',
          );
          lines.push(
            "[hint] prefer the site's machine endpoint over scraping HTML:"
            + ' search engines often honour "&format=rss", docs/APIs expose JSON endpoints,'
            + ' repos have raw/"…json" URLs. Only then fall back to format:"raw"'
            + ' (capped, often one very long line) or a headless browser.',
          );
          lines.push(`[raw head] ${decoded.replace(/\s+/g, ' ').slice(0, 300)}`);
        }

        let text = r.text || '(no readable text extracted)';
        if (section) {
          const sliced = sliceSection(text, section);
          if (sliced) {
            text = sliced.body;
            lines.push(
              `[section] matched "${sliced.matched}"`
              + (sliced.headingCount > 1 ? ` (${sliced.headingCount} headings contained "${section}"; showing the first)` : '')
              + ` — ${text.length} chars`,
            );
          } else {
            const hasHeadings = /^#{1,6}\s/m.test(text);
            lines.push(
              hasHeadings
                ? `[section] no heading contained "${section}" — retry without section, or pick a heading from the full text`
                : '[section] this page yielded no headings, so section slicing is unavailable — omit section to get the full text',
            );
          }
        }
        payload = text;
        if (s.truncated) payload += `\n\n... (extracted text truncated at ${Math.round(maxBytes / 1024)}KB)`;
      } else {
        payload = decoded || '(empty response)';
        if (section) lines.push('[section] ignored — section only applies to extracted HTML/XML text (omit format:"raw")');

        // ★ select：JSON 字段投影。必须在这里做（**在截断与返回之前**）——
        //   它的目的正是"别让大 JSON 撑爆工具结果"，放到截断之后就失去意义了。
        //   只对非 markup 响应生效；format:"raw" 时跳过（raw 的语义就是"原样"）。
        //   投影失败（非 JSON / 路径不匹配）只是加一行提示并回退原响应体，不报错 ——
        //   select 写错时调用方仍能拿到数据自己看。
        const sel = ctx.select;
        if (sel && format !== 'raw') {
          const projected = tryProject(decoded, sel);
          if (projected) {
            payload = projected.text;
            lines.push(`[select] ${projected.note}`);
          } else {
            lines.push(`[select] ignored — response is not JSON, or the path did not match (expr: ${sel})`);
          }
        }

        if (rawTruncated) {
          payload += `\n\n... (response truncated at ${Math.round(maxBytes / 1024)}KB)`;
        }
      }

      return [...lines.filter(l => l !== ''), '', payload].join('\n');
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return `Error: Request timed out after ${timeoutMs}ms`;
      }
      return `Error: ${(err as Error).message}`;
    }
  }
}

/** 单次抓取的公共上下文（多 URL 时复用，避免每个 URL 重复解析参数） */
interface FetchCtx {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  format: string;
  keepLinks: boolean;
  section?: string;
  /** JSON 字段投影表达式（见 projectJson） */
  select?: string;
}

/**
 * 字段投影（select 参数）—— 把大 JSON 收窄成调用方真正要的字段。
 *
 * **动机**（真实痛点）：OpenAlex 一次查 5 个就 18–57KB，超出工具结果的缓冲阈值，
 * 于是只能落盘再写脚本解析，每批检索白花 1–2 个往返。
 *
 * **语法**（够用即止，保持 LLM 好写）：
 *   results[].{title,publication_year,doi}   遍历 results 数组，每元素只留这三个字段
 *   data.items[].name                        点号路径 + 数组遍历
 *   meta.count                               普通路径
 * 语义：`[]` = "对该数组逐元素应用后续路径段"；`{a,b,c}` = "只留这些字段"。
 *
 * **倒排索引自动还原**：形如 `{"word":[0,5,9]}` 的对象（OpenAlex 的
 * `abstract_inverted_index`）会按位置还原成正文字符串 —— 否则调用方拿到的是位置表，
 * 还得自己写还原脚本（本项目为此专门写过 oa_show.py）。
 *
 * 不引入 jq 依赖：只覆盖"路径 + 数组 + 字段选择"三件事，更复杂的转换交调用方脚本处理。
 */
type SelectSeg = { kind: 'key'; key: string; each: boolean } | { kind: 'fields'; fields: string[] };

function parseSelect(expr: string): SelectSeg[] {
  const segs: SelectSeg[] = [];
  for (const raw of expr.split('.')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('{') && part.endsWith('}')) {
      const fields = part.slice(1, -1).split(',')
        .map((f) => f.trim().replace(/\[\]$/, ''))
        .filter(Boolean);
      if (fields.length) segs.push({ kind: 'fields', fields });
      continue;
    }
    const each = part.endsWith('[]');
    segs.push({ kind: 'key', key: each ? part.slice(0, -2) : part, each });
  }
  return segs;
}

/** 形如 {"w":[0,2],...} 的倒排索引 → 按位置还原的正文字符串；不像则返回 null */
function invertIndexToString(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20000) return null;
  const slots: string[] = [];
  for (const [word, pos] of entries) {
    if (!Array.isArray(pos) || pos.length === 0 || !pos.every((n) => typeof n === 'number')) return null;
    for (const n of pos as number[]) slots[n] = word;
  }
  if (slots.length === 0 || slots.some((s) => s === undefined)) return null;
  return slots.join(' ');
}

function projectJson(value: unknown, segs: SelectSeg[], depth = 0): unknown {
  if (depth > 24 || segs.length === 0) return value;
  const head = segs[0]!;
  const rest = segs.slice(1);
  if (head.kind === 'fields') {
    const pick = (obj: unknown): unknown => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
      const src = obj as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of head.fields) if (f in src) out[f] = src[f];
      return rest.length ? projectJson(out, rest, depth + 1) : out;
    };
    return Array.isArray(value) ? value.map(pick) : pick(value);
  }
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return value.map((v) => projectJson(v, segs, depth + 1));
  const next = (value as Record<string, unknown>)[head.key];
  if (next === undefined) return undefined;
  if (head.each && Array.isArray(next)) {
    return rest.length ? next.map((v) => projectJson(v, rest, depth + 1)) : next;
  }
  return projectJson(next, rest, depth + 1);
}

/** 把结果里的倒排索引逐层还原成文本 */
function reviveInverted(v: unknown, depth = 0): unknown {
  if (depth > 24) return v;
  const inv = invertIndexToString(v);
  if (inv !== null) return inv;
  if (Array.isArray(v)) return v.map((x) => reviveInverted(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = reviveInverted(val, depth + 1);
    return o;
  }
  return v;
}

/** 执行投影。解析失败 / 非 JSON / 路径不匹配 ⇒ null（调用方回退到原响应体，不报错） */
function tryProject(body: string, expr: string): { text: string; note: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const segs = parseSelect(expr);
  if (segs.length === 0) return null;
  const out = projectJson(parsed, segs);
  if (out === undefined) return null;
  const before = body.length;
  const text = JSON.stringify(reviveInverted(out), null, 2);
  return { text, note: `${before} → ${text.length} chars (projection: ${expr})` };
}

/**
 * 猜字符集：header 优先，其次文档前 4KB 的 <meta charset>，最后 UTF-8。
 * gb2312 / gb18030 统一走 'gbk'（TextDecoder 的标签是 gbk，gbk 是 gb2312 的超集）。
 */
function sniffCharset(bytes: Buffer, contentType: string): string {
  const norm = (raw: string): string => {
    const c = raw.trim().toLowerCase().replace(/["']/g, '');
    if (c === 'gb2312' || c === 'gb-2312' || c === 'gb18030') return 'gbk';
    if (c === 'utf8') return 'utf-8';
    return c;
  };
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return norm(fromHeader);
  const head = bytes.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  if (meta) return norm(meta);
  return 'utf-8';
}
