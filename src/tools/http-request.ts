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
    'json=true 时自动设置 Content-Type 为 application/json。';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request (http:// or https://). Provide this or urls.' },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fetch several URLs in one call (sequential, max 5, each result labelled with its URL). Provide this or url.',
      },
      method: {
        type: 'string',
        description: 'HTTP method. Default: GET',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      },
      headers: {
        type: 'string',
        description: 'JSON string of custom headers. Overrides defaults.',
      },
      body: {
        type: 'string',
        description: 'Request body as string. For JSON, set Content-Type header or use the json flag.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds. Default: 30000 (30s). Max: 120000 (2 min).',
      },
      json: {
        type: 'boolean',
        description: 'If true, body is treated as JSON and Content-Type is set to application/json. Default: false.',
      },
      format: {
        type: 'string',
        enum: ['auto', 'text', 'raw'],
        description:
          'Response body handling. "auto" (default) = extract readable text from HTML/XML, leave other types untouched. "text" = force extraction. "raw" = return the untouched body.',
      },
      keepLinks: {
        type: 'boolean',
        description: 'Render anchors as "text (https://…)" in the extracted text. Default: false.',
      },
      section: {
        type: 'string',
        description:
          'Return only the section whose heading contains this string (case-insensitive). Requires extraction (format auto/text). Useful to avoid pulling an entire long page.',
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
      return 'Error: url (or urls) is required.';
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

    const ctx: FetchCtx = { method, headers, body, timeoutMs, maxBytes, format, keepLinks, section };

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
    const { method, headers, body, timeoutMs, maxBytes, format, keepLinks, section } = ctx;

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
