import type { Tool } from './interface.js';

/**
 * HttpRequestTool — HTTP 客户端，支持 GET/POST/PUT/DELETE。
 * 轻量爬虫 + API 调试。
 */
export class HttpRequestTool implements Tool {
  readonly name = 'http_request';
  readonly description =
    'Make HTTP requests. Supports GET, POST, PUT, DELETE with custom headers, body, timeout, and cookies. ' +
    'Default User-Agent mimics a browser. Use for light web scraping, API debugging, and data fetching. ' +
    'Returns status code, headers, and response body (truncated at 50KB).';
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to request (http:// or https://)' },
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
    },
    required: ['url'],
  };

  private static readonly DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  private static readonly MAX_RESPONSE_BYTES = 50 * 1024; // 50KB

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) return 'Error: url is required.';

    const method = ((args.method as string) ?? 'GET').toUpperCase();
    const body = args.body as string | undefined;
    const isJson = args.json === true;
    const timeoutMs = Math.min(
      (args.timeout as number) ?? 30000,
      120000,
    );

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchInit: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        fetchInit.body = body;
      }

      const response = await fetch(url, fetchInit);
      clearTimeout(timer);

      const respHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { respHeaders[k] = v; });

      let respBody = '';
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let totalBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          respBody += decoder.decode(value, { stream: true });
          if (totalBytes > HttpRequestTool.MAX_RESPONSE_BYTES) {
            respBody += '\n... (response truncated at 50KB)';
            reader.cancel();
            break;
          }
        }
      }

      const summary = [
        `HTTP ${response.status} ${response.statusText}`,
        `URL: ${url}`,
        respHeaders['content-type']
          ? `Content-Type: ${respHeaders['content-type']}`
          : '',
        respHeaders['content-length']
          ? `Content-Length: ${respHeaders['content-length']} bytes`
          : `Body: ${respBody.length} bytes`,
        '',
        respBody || '(empty response)',
      ].filter(l => l !== '').join('\n');

      return summary;
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === 'AbortError') {
        return `Error: Request timed out after ${timeoutMs}ms`;
      }
      return `Error: ${(err as Error).message}`;
    }
  }
}
