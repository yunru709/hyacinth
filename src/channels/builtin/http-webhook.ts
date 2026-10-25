// ============================================================
// HttpWebhookChannel — 内建 HTTP REST API 渠道（企业加固版）
// ============================================================
//
// 端点：/api/health, /api/chat, /api/sessions, /api/tools, /api/skills
// 认证：Bearer Token（HYACINTH_API_KEY 环境变量或 --api-key 参数）
// Chat 为同步 request-response 模式。
// ============================================================

/**
 * WebUI 渠道 sessionId 前缀（**渠道自管**：定义在本渠道模块内，核心注册表零渠道知识）。
 * `ui_` 是旧版 `/ui` 前缀，用于兼容存量会话；多前缀通过 sessionPrefix 的数组形态声明。
 */
export const WEBUI_SESSION_PREFIXES = ['webui_', 'ui_'] as const;
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
  AgentFactory,
} from '../interface.js';
import type { Provider } from '../../provider/interface.js';
import type { SessionManager } from '../../memory/session.js';
import type { OutputHandler } from '../../orchestrator/loop.js';
import type { AgentComponents } from '../../gateway/factory.js';
import { createLogger } from '../../logging/logger.js';
import { getModelContextWindow } from '../../setup/model-defaults.js';
import { getDefaultConfig } from '../../runtime/defaults.js';
import { registerMediaRoutes, isPublicReadRoute } from '../../gateway/media-routes.js';
import { registerPreviewRoutes, createPreviewService, type PreviewService } from '../../gateway/preview-routes.js';
import { isLoopbackRemoteAddress } from '../../gateway/preview-service.js';
import { LocalModelModule } from '../../local-model/index.js';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import type { UiWsSessionBackend } from './ui-ws-session.js';
// 只做类型导入（编译后消失）⇒ 不构成「运行时直连业务核心」，符合 verify:layers 规则 5
import type { SessionClaimRegistry } from '../../memory/session-claims.js';
import { getRouterByName } from '../../context/profiles.js';
import { switchToMode } from '../../context/mode-switch.js';
import { clearPromptCache } from '../../prompts/loader.js';

const logger = createLogger('http-webhook');

// ── 会话占用表：依赖注入（2026-10-25）──────────────────────────────
// 为什么本文件不再 `import { getSessionClaims } from memory/session-claims`：
//   verify:layers 规则 5「UI 适配层不得直连业务核心」—— `channels/` 属 UI 侧，
//   `memory/` 是业务核心，运行时相对导入必须 ∈ ui-direct-whitelist，且白名单只减不增。
// 为什么不能改成走 ui-protocol 协议调用：
//   这段判定发生在 **WS upgrade 事件**里（协议层尚未建立），请求发不出去（鸡生蛋）。
// 所以改由装配方注入：gateway/server.ts 与 gateway/tui.ts 都在白名单内允许 memory，
//   它们调 setSessionClaimsProvider(getSessionClaims) 把进程级单例交进来。
// 未注入时用本实例内 Map 兜底：语义等价（claim/release/ownerOf/transfer/snapshot），
//   仅互斥范围限于本实例 —— 单 channel 实例场景与注入行为一致。
let claimsProvider: (() => SessionClaimRegistry) | null = null;
let localClaims: SessionClaimRegistry | null = null;

/** 装配方注入进程级占用表（webui 多标签互斥依赖它） */
export function setSessionClaimsProvider(fn: () => SessionClaimRegistry): void {
  claimsProvider = fn;
}

/** 本地兜底实现：与 memory 的 createSessionClaims 同语义，避免本文件运行时 import */
function createLocalClaims(): SessionClaimRegistry {
  const map = new Map<string, string>();
  return {
    claim(sessionId, owner) {
      const holder = map.get(sessionId);
      if (holder !== undefined && holder !== owner) return false;
      map.set(sessionId, owner);
      return true;
    },
    release(sessionId, owner) {
      if (map.get(sessionId) === owner) map.delete(sessionId);
    },
    ownerOf(sessionId) {
      return map.get(sessionId) ?? null;
    },
    transfer(from, to, owner) {
      if (from !== to) {
        const holder = map.get(to);
        if (holder !== undefined && holder !== owner) return false;
      }
      map.set(to, owner);
      if (from && from !== to && map.get(from) === owner) map.delete(from);
      return true;
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

/** 取当前生效的占用表：已注入用进程级单例，否则用本实例兜底 */
function resolveClaims(): SessionClaimRegistry {
  if (claimsProvider) return claimsProvider();
  localClaims ??= createLocalClaims();
  return localClaims;
}

// ── 认证 ────────────────────────────────────────────────────────────

function getApiKey(config: ChannelConfig): string | null {
  return (config.apiKey as string)
    || process.env.HYACINTH_API_KEY
    || process.env.AGENT_API_KEY
    || null;
}

/** WebUI 静态资源路径（无需认证，浏览器直接加载 index.html/css/js；忽略 query string） */
function isPublicWebUIRoute(url: string): boolean {
  const path = url.split('?')[0];
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/theme.css' ||
    path === '/app.css' ||
    path === '/app.js' ||
    path === '/markdown.js' ||
    path === '/favicon.ico' ||
    // index.html 的 <link>/<script> 引用（浏览器加载它们无法带 Authorization 头，
    // 不进白名单的话配钥匙场景下样式/高亮/公式/主题选择器全 401，实测 shell.css）
    path === '/shell.css' ||
    path === '/code-themes.css' ||
    path === '/math.js' ||
    path === '/highlight.js' ||
    path === '/themes.json' ||
    path.startsWith('/vendor/') ||
    path.startsWith('/assets/')
  );
}

/**
 * 监听地址是否"只对本机"（fail-closed 判定用）。
 * 认 127.x / ::1 / localhost；其余（含 0.0.0.0 与内网地址）都算"对外开放"。
 */
export function isLoopbackHost(host: unknown): boolean {
  // 配置里的值类型是宽松的（ChannelConfig 是索引类型）⇒ 在边界处收成字符串 ✓
  const h = String(host ?? '').trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/**
 * 列出本机**可达**的局域网网址（对外开放时提示用）。
 *
 * 为什么要"全列"而不是猜一个 ✗：多网卡 / VPN 虚拟网卡 / Docker 都会各有一个地址，
 * 猜错比全列更糟（用户会拿着一个连不上的地址反复试 ✓）。
 * 私有网段（192.168 / 10 / 172.16-31）标为"家里网"，其余标为"其它网卡"。
 */
export function listLanUrls(port: number): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      // 链路本地（169.254.*）不是可用地址 ⇒ 列出来只会让用户困惑 ✗（实测本机就有 3 个）
      if (ip.startsWith('169.254.')) continue;
      const isPrivate = ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      out.push('http://' + ip + ':' + port + '/' + (isPrivate ? '  ← 家里网' : '  ← 其它网卡（VPN/Docker 之类）'));
    }
  }
  return out;
}

function authHook(apiKey: string | null) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // /api/health、/api/media、/api/companion + WebUI 静态资源 无需认证
    if (isPublicReadRoute(req.url) || isPublicWebUIRoute(req.url)) return;

    // /api/fs/raw 是唯一额外接受 ?token= 的 HTTP 端点：它被 <img src> 与
    // <iframe> 加载，浏览器这两处**没法设置请求头**，钥匙只能走查询参数
    // （与 WS 升级同一机制，见 checkBearerAuth 的调用方）。
    // 仅限这一个端点 —— 文件列表/文本读取仍必须走 Authorization 头。
    if (apiKey && req.url.startsWith('/api/fs/raw')) {
      const q = new URL(req.url, 'http://localhost').searchParams.get('token');
      if (q && checkBearerAuth(`Bearer ${q}`, apiKey)) return;
    }

    if (!apiKey) {
      return reply.status(401).send({
        error: 'API key not configured. Set HYACINTH_API_KEY environment variable or pass --api-key.',
      });
    }

    if (!checkBearerAuth(req.headers['authorization'] ?? '', apiKey)) {
      return reply.status(401).send({ error: 'Invalid or missing API key. Use Authorization: Bearer <key>' });
    }
  };
}

/**
 * 校验 Authorization: Bearer <token> 是否匹配 apiKey。
 * HTTP（authHook）与 WebSocket upgrade 共用同一校验逻辑，防止 WS 端点绕过认证。
 */
function checkBearerAuth(authorization: string, apiKey: string): boolean {
  const auth = authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return safeEqualSecret(bearer, apiKey);
}

/**
 * WebSocket 握手专用：浏览器原生 WebSocket API 不允许设置 Authorization 头，
 * 因此 /tui /desktop /ui 的 WS 升级额外接受 ?token=<key> 查询参数。
 * 安全说明：仅用于 WS 握手这一跳（连接建立后不再携带）；比较走同一常量时间函数。
 */
function checkWsAuth(request: { url?: string; headers: Record<string, unknown> }, apiKey: string): boolean {
  const headerOk = checkBearerAuth(
    (request.headers['authorization'] as string | undefined) ?? '',
    apiKey,
  );
  if (headerOk) return true;

  try {
    const token = new URL(request.url ?? '', 'http://localhost').searchParams.get('token');
    return token !== null && safeEqualSecret(token, apiKey);
  } catch {
    return false;
  }
}

/** 常量时间密钥比较（参照 Codex safeEqualSecret：防时序侧信道逐字节猜 key） */
function safeEqualSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return a === b;
  }
}

// ── CollectHandler ────────────────────────────────────────────────

/** 收集 agent 输出的 handler */
class CollectHandler implements OutputHandler {
  texts: string[] = [];
  toolCalls: Array<{ name: string; input: unknown; isError: boolean; result: string }> = [];
  statusMessages: string[] = [];

  onText?(content: string): void { this.texts.push(content); }
  onThinking?(_content: string): void { /* 不收集 thinking */ }
  onToolUse?(name: string, inputSummary: string): void {
    this.toolCalls.push({ name, input: inputSummary, isError: false, result: '' });
  }
  onToolResult?(content: string, isError: boolean): void {
    const last = this.toolCalls.length > 0 ? this.toolCalls[this.toolCalls.length - 1] : undefined;
    if (last && !last.result) { last.isError = isError; last.result = content; }
  }
  onStatus?(message: string, _level: 'info' | 'warn' | 'error'): void { this.statusMessages.push(message); }
  onTurnStart?(): void {}
  onFlush?(): void {}
  onInterrupt?(): void {}
  onPermissionRequest?(toolName: string, input: Record<string, unknown>): Promise<'yes' | 'no' | 'always'> {
    // fail-closed（参照 OpenClaw"不能审批就拒绝"）：HTTP/WS 渠道没有交互式
    // 审批 UI，危险工具在此自动放行 = 渠道消息可静默驱动 bash/write。
    // 旧实现返回 true 是"渠道即后门"级别的安全洞。
    this.statusMessages.push(`[security] dangerous tool "${toolName}" denied — HTTP channel has no approval UI`);
    void toolName; void input;
    return Promise.resolve('no');
  }

  getFullText(): string {
    return this.texts.join('\n');
  }
}

// ── HttpWebhookChannel ───────────────────────────────────────────

export class HttpWebhookChannel implements ChannelHandler {
  readonly id = 'http-webhook';
  readonly name = 'HTTP Webhook';
  readonly description = '内建 HTTP REST API 渠道，支持 POST /api/chat webhook 接入（Bearer Token 认证）';
  readonly pluginId = undefined;
  /** sessionId 前缀（引用本模块常量，勿写字面量） */
  readonly sessionPrefix = WEBUI_SESSION_PREFIXES;
  /**
   * 会话归属渠道名：本 handler 的 id 是 `http-webhook`（服务形态命名），
   * 但它承载的是 WebUI，会话记录 / 前端展示 / 按渠道恢复统一用 `webui`。
   * 该值必须与创建 Agent 时传的 `channel: 'webui'` 一致。
   */
  readonly sessionChannel = 'webui';

  private app: FastifyInstance | null = null;
  private status: ChannelStatus = 'registered';
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;
  private provider!: Provider;
  private sessionManager!: SessionManager;
  private cwd!: string;
  private maxTurns!: number;
  private maxContext!: number;
  private activeComponents: AgentComponents | null = null;
  private wsAgentFactory: AgentFactory | null = null;
  /** 实际绑定端口（port 0 自动分配时读回，供调用方/测试获取） */
  private actualPort = 0;
  /**
   * 文件预览服务：HTTP 路由（preview-routes）与 WS 契约域（preview.*）共享
   * 同一实例 —— 根状态只有一份，从任何一条通道换根，另一条立刻可见。
   */
  private previewService: PreviewService | null = null;
  /** 访问钥匙（start 时从 config/env 读取；preview.rawUrl 签发 ?token= 用） */
  private apiKeyValue: string | null = null;

  /** 实际绑定端口（start 后有效；未 start 为 0） */
  get boundPort(): number { return this.actualPort; }

  async start(config: ChannelConfig): Promise<void> {
    // 默认绑定 127.0.0.1（fail-closed）：0.0.0.0 会把无审批 UI 的 agent
    // 暴露到局域网——历史公网暴露事故的根源正是"默认宽绑定"。需要局域网
    // 访问时在渠道配置显式指定 host，并务必配置 apiKey。
    const { port = 3000, host = '127.0.0.1' } = config;
    // 从 config 获取 agentFactory（由 ChannelManager.startChannel 注入）
    this.wsAgentFactory = (config.agentFactory as AgentFactory) ?? null;

    this.provider = config.provider as Provider;
    this.sessionManager = config.sessionManager as SessionManager;
    this.cwd = config.cwd as string;
    this.maxTurns = config.maxTurns as number ?? getDefaultConfig().session.maxTurns;
    this.maxContext = config.maxContext as number ?? getModelContextWindow(this.provider.getProviderType(), this.provider.getModel());

    const apiKey = getApiKey(config);
    this.apiKeyValue = apiKey;
    // 早期测试开关（用户 2026-09-20 要求）：显式声明"我知道风险"才放行 ✓
    const noAuth = config.noAuth === true || config.noAuth === 'true';
    if (!apiKey) {
      logger.warn('No HYACINTH_API_KEY set — HTTP API will reject all requests except /api/health. Set the environment variable or use --api-key.');
    }

    // ── 硬约束（fail-closed）：对外开放**必须**有钥匙 ──────────────────
    // 为什么放在这里而不是命令行 ✗：配置文件同样能改监听地址 ✓ ——
    // 只有放在"真正读取地址"的地方，两条入口才一起管住 ✓。
    // 用户画像是非技术背景、会长期开着不管 ⇒ 宁可启动失败（他立刻能看见），
    // 也不要"门开着、但没人知道该配钥匙" ✗。
    if (noAuth && !isLoopbackHost(host)) {
      logger.warn([
        '⚠️ 已启用 --no-auth：对外监听 ' + host + ' 时**不校验钥匙** —— 同一局域网内任何设备都能进来 ✓',
        '   （早期测试用 ✓；测完去掉 --no-auth 即恢复"要钥匙" ✓）',
      ].join('\n'));
    }
    if (!isLoopbackHost(host) && !apiKey && !noAuth) {
      const msg = [
        '',
        '【拒绝启动】监听地址 ' + host + ' 是对外开放的（局域网可见），但没有配置访问钥匙。',
        '  对外开放必须配钥匙，否则同网任何人都能让这台电脑执行命令、改文件。',
        '  任选一种方式配钥匙：',
        '    · 启动时加：--api-key <一串足够长的钥匙>',
        '    · 或设环境变量：HYACINTH_API_KEY=<同一串钥匙>',
        '  若要只在本机使用，请把监听地址改回 127.0.0.1（默认值）。',
        '',
      ].join('\n');
      logger.error(msg);
      throw new Error('拒绝启动：对外开放但未配置 apiKey（另见启动日志）');
    }
    const fastify = (await import('fastify')).default;
    this.app = fastify({ logger: false });

    // ── 传输压缩（gzip / deflate）────────────────────────────────────
    // 首屏此前要下约 860KB **未压缩**文本（theme.css 70 + app.css 46 + shell.css 46
    // + tailwind 31 + lucide 397 + app.js 238 + markdown 27）。文本类 gzip 后通常只剩
    // 12~20%，这里不改任何业务代码就能拿到最大的一笔。
    //
    // ⚠️ 必须**在注册任何路由与 @fastify/static 之前**注册：Fastify 的 hook 链在
    //   路由注册那一刻就固定了，晚注册的 onSend 压缩钩子对已存在的路由不生效
    //   （@fastify/compress 的 README 也点名了与 static 的顺序）。
    // ⚠️ customTypes 是**白名单**，且传入的是完整 Content-Type（含 `; charset=`），
    //   所以只能前置匹配、不能 `$` 收尾。白名单而不是黑名单的原因是 SSE：
    //   `text/event-stream` 一旦被压缩，zlib 会攒缓冲，逐字流式输出会变成整段延迟
    //   —— 那不是性能问题，是功能坏了。走白名单就从结构上排除了这种可能。
    // ⚠️ 别把 `br` 加进 encodings：Node 的 brotli 默认参数下 CPU 开销明显高于 gzip，
    //   而这套资源的收益差（~2KB）不值得；浏览器仍可协商 gzip。
    const compress = (await import('@fastify/compress')).default;
    await this.app.register(compress, {
      global: true,
      threshold: 1024,
      encodings: ['gzip', 'deflate'],
      customTypes: /^(?:text\/(?:css|html|plain|xml)|application\/(?:javascript|json|xml)|image\/svg\+xml)/,
    });

    // ── 安全加固（全路由）───────────────────────────────────────────
    // --no-auth：早期测试时整个跳过（含 WS，见下）✓
    if (!noAuth) {
      this.app.addHook('preHandler', authHook(apiKey));
    }

    this.app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      /**
       * 同源 iframe 有两种用途，全局 DENY 会把它们都挡成白屏：
       *   1. 预览栏渲染工作区里的 HTML / PDF（/api/fs/raw）；
       *   2. 并行会话标签：每个标签是一个 `/index.html?embed=1&session=…`。
       * 因此对这两类请求放开到 SAMEORIGIN：
       *   · 其它所有路由仍然禁止被任何页面嵌入；
       *   · SAMEORIGIN 只允许本站自己的页面嵌入，外部站点依旧嵌不了。
       */
      let embeddable = false;
      try {
        const u = decodeURIComponent(String(_req.url || '')).toLowerCase();
        const pathOnly = u.split('?')[0];
        embeddable = pathOnly === '/'
          || pathOnly === '/index.html'
          || (u.startsWith('/api/fs/raw') && /\.(?:html?|pdf)(?:$|&)/.test(u));
      } catch { /* 非法编码：按不可嵌入处理 */ }
      reply.header('X-Frame-Options', embeddable ? 'SAMEORIGIN' : 'DENY');
      reply.header('X-XSS-Protection', '1; mode=block');
      reply.header('Access-Control-Allow-Origin', (config.corsOrigin as string) || '*');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    });

    // OPTIONS preflight
    this.app.options('*', async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.status(204).send();
    });

    // ── Health ──────────────────────────────────────────────────
    this.app.get('/api/health', async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ status: 'ok', version: '1.0.0', auth: !!apiKey });
    });

    // ── Media / Scene（WebUI 只读）──────────────────────────────
    registerMediaRoutes(this.app, this.cwd);

    // ── 工作区文件预览（WebUI 右侧「预览」栏，只读）─────────────────
    // 与 media 相反：这组端点**要钥匙**——它能读到工作区里任何文件，而 fetch
    // 能带 Authorization 头，没有豁免的理由。路径越界 fail-closed（preview-service）。
    // 同一服务实例交给 WS 契约域（preview.*）：JSON 数据面走契约层，HTTP 只搬字节。
    this.previewService = createPreviewService(this.cwd);
    registerPreviewRoutes(this.app, this.previewService);

    // 生成语音端点：重放列表 + 音频文件（IndexTTS2 等本地 TTS 产出的陪伴语音）
    {
      const fsSync = await import('node:fs');
      const fsp = await import('node:fs/promises');
      const { getGeneratedVoiceStore } = await import('../../companion/voice-store.js');
      const genStore = getGeneratedVoiceStore();

      this.app.get('/api/companion/voice/list', async (req, reply) => {
        const q = req.query as { character?: string; limit?: string };
        if (!q.character) return reply.status(400).send({ error: 'character query required' });
        const rows = genStore.listByCharacter(q.character, Math.min(Number(q.limit) || 50, 200));
        return reply.send({
          character: q.character,
          voices: rows.map((r) => ({
            id: r.id,
            text: r.textNorm,
            emotion: r.emotionKey,
            tone: r.emotionRaw,
            voiceId: r.voiceId,
            durationMs: r.durationMs,
            byteSize: r.byteSize,
            createdAt: r.createdAt,
            url: `/api/companion/voice/${r.id}/file`,
          })),
        });
      });

      this.app.get('/api/companion/voice/:id/file', async (req, reply) => {
        const { id } = req.params as { id: string };
        const row = genStore.get(id);
        if (!row) return reply.status(404).send({ error: 'voice not found' });
        const abs = genStore.filePathOf(row);
        try {
          const stat = await fsp.stat(abs);
          const etag = `"${stat.size}-${stat.mtimeMs}"`;
          reply.header('etag', etag);
          reply.header('cache-control', 'private, max-age=604800');
          const inm = req.headers['if-none-match'];
          if (inm && inm === etag) return reply.status(304).send();
          reply.type(row.format === 'mp3' ? 'audio/mpeg' : 'audio/wav').header('content-length', stat.size);
          return reply.send(fsSync.createReadStream(abs));
        } catch {
          return reply.status(404).send({ error: 'voice file missing' });
        }
      });
    }

    // ── Chat ────────────────────────────────────────────────────
    // ── Chat ────────────────────────────────────────────────────
    this.app.post('/api/chat', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as {
        message?: string;
        sessionId?: string;
        images?: Array<{ data: string; media_type: string }>;
      };
      if (!body.message) {
        return reply.status(400).send({ error: 'message is required' });
      }

      const handler = new CollectHandler();

      try {
        const { createAgent } = await import('../../gateway/factory.js');
        const { loop, sessionDir } = await createAgent({
          cwd: this.cwd,
          provider: this.provider,
          maxTurns: this.maxTurns,
          maxContext: this.maxContext,
          outputHandler: handler as OutputHandler,
          sessionId: body.sessionId,
          shouldContinue: !body.sessionId,
          // WebUI 渠道标识：会话落 webui_ 前缀，并启用按渠道隔离的恢复。
          // 历史上这里不传 channel → 会话落成裸日期 ID，与 CLI/serve 的裸会话
          // 混在同一命名空间，既分不清来源、也无法按渠道恢复。
          channel: 'webui',
        });

        if (body.images?.length) loop.channelImages = body.images;
        await loop.run(body.message);

        const sessionId = sessionDir.split(/[\\/]/).pop() ?? '';

        if (this.eventHandler) {
          this.eventHandler({
            type: 'message',
            sessionId,
            userId: 'http-user',
            content: body.message,
            channel: this.id,
            metadata: { source: 'http-webhook' },
          }).catch(() => {});
        }

        return reply.send({
          sessionId,
          content: handler.getFullText(),
          turns: handler.toolCalls.length,
          toolCalls: handler.toolCalls.map(t => ({ name: t.name, input: t.input })),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Chat error', undefined, { error: message });
        return reply.status(500).send({ error: message });
      }
    });

    // ── Sessions ────────────────────────────────────────────────
    this.app.get('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
      const sessions = await this.sessionManager.list();
      return reply.send(sessions);
    });

    this.app.post('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
      const session = await this.sessionManager.create('normal', 'http-webhook');
      return reply.send({ id: session.id, createdAt: session.createdAt });
    });

    this.app.get('/api/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        const session = await this.sessionManager.resume(id);
        return reply.send({ id: session.id, createdAt: session.createdAt });
      } catch {
        return reply.status(404).send({ error: 'Session not found' });
      }
    });

    this.app.delete('/api/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        const fs = await import('node:fs/promises');
        // 会话目录走 SessionManager 解析 —— 分桶（sessions/<模式>/<id>）之后
        // 不能再由 id 直接拼路径 ✗（拼错 = 删不掉，或删到什么都没有的地方）
        const sessionDir = this.sessionManager.getSessionDir(id);
        await fs.rm(sessionDir, { recursive: true, force: true });
        return reply.send({ ok: true });
      } catch {
        return reply.status(404).send({ error: 'Session not found' });
      }
    });

    // ── Tools & Skills ──────────────────────────────────────────
    this.app.get('/api/tools', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const tools = components.toolRegistry.getAll().map(t => ({
        name: t.name,
        description: t.description,
      }));
      return reply.send(tools);
    });

    this.app.get('/api/skills', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const skills = components.skillRegistry.getAll().map(s => ({
        name: s.name,
        description: s.description,
        source: s.source,
      }));
      return reply.send(skills);
    });

    // ── WebSocket 端点（/tui /desktop /ui 统一走 ui-protocol 协议层） ─
    // 迁移说明：/tui 与 /desktop 原本走 TuiWsSession 旧协议（chat/stop/
    // permission 简单消息 + WebUIOutputHandler 直发回调），现统一迁移到
    // UiWsSession（与 /ui 完全相同的 7 域协议装配），使 TUI 远程 /
    // 桌面端 / WebUI 共享同一套协议与后端能力。契约测试见
    // ui-ws-contract.test.ts。
    const { WebSocketServer } = await import('ws');
    const { UiWsSession } = await import('./ui-ws-session.js');
    const tuiWss = new WebSocketServer({ noServer: true });
    const desktopWss = new WebSocketServer({ noServer: true });
    const uiWss = new WebSocketServer({ noServer: true });

    this.app.server.on('upgrade', (request, socket, head) => {
      // 端点匹配须容忍查询串（?token= 鉴权参数挂在 URL 上）
      const wsPath = (request.url ?? '').split('?')[0];
      // WS 端点在 Fastify preHandler 之外，需在此独立校验 Bearer token，
      // 否则 /tui /desktop /ui 三个端点可绕过 HTTP 认证直接连接（安全漏洞）
      if (wsPath === '/tui' || wsPath === '/desktop' || wsPath === '/ui') {
        // fail-closed：未配置 apiKey 时拒绝 WS 升级（与 REST 的 401 行为一致）。
        // 旧实现在 apiKey 为空时直接放行 = 无凭据即可驱动完整 agent。
        // 浏览器 WebSocket 无法设置 Authorization 头 → 额外接受 ?token= 查询参数。
        if (!noAuth) {
          if (!apiKey) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          if (!checkWsAuth(request, apiKey)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }
      }

      if (wsPath === '/tui') {
        tuiWss.handleUpgrade(request, socket, head, (ws) => {
          tuiWss.emit('connection', ws, request);
        });
      } else if (wsPath === '/desktop') {
        desktopWss.handleUpgrade(request, socket, head, (ws) => {
          desktopWss.emit('connection', ws, request);
        });
      } else if (wsPath === '/ui') {
        uiWss.handleUpgrade(request, socket, head, (ws) => {
          uiWss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    tuiWss.on('connection', (ws, req) => {
      const sessionId = `tui_${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      logger.info('TUI WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId, req);
    });

    // ── Desktop GUI WebSocket 端点 ──
    desktopWss.on('connection', (ws, req) => {
      const now = new Date();
      const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const time = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      const sessionId = `webui_${date}-${time}-${randomBytes(3).toString('hex')}`;
      logger.info('Desktop WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId, req);
    });

    // ── UI 契约层 WebSocket 端点（/ui，统一 UI 契约层） ─
    uiWss.on('connection', (ws, req) => {
      // 与 /desktop 同格式的 webui_ 前缀：可被 SessionManager 渠道识别（feishu_/webui_/tui_）
      const now = new Date();
      const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const time = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      const sessionId = `webui_${date}-${time}-${randomBytes(3).toString('hex')}`;
      logger.info('UI WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId, req);
    });



    // ── WebUI 静态资源（webui/ 目录，可选；根路径 / 返回 index.html）──
    const webuiRoot = config.webuiRoot as string | undefined;
    if (webuiRoot && existsSync(webuiRoot)) {
      const fastifyStatic = (await import('@fastify/static')).default;
      await this.app.register(fastifyStatic, { root: webuiRoot });
      logger.info(`WebUI static serving from ${webuiRoot}`);
    }

    // ── Start ───────────────────────────────────────────────────
    await this.app.listen({ port: port as number, host: host as string });
    // 读回实际端口（port 0 自动分配场景）
    const addr = this.app.server?.address();
    this.actualPort = (addr && typeof addr === 'object') ? addr.port : (port as number);
    this.status = 'active';
    if (isLoopbackHost(host)) {
      logger.info(`HTTP API listening on ${host}:${this.actualPort}（只对本机）${apiKey ? ' (auth enabled)' : ''}`);
    } else {
      // 对外开放：把**每个**可达网址列出来 —— 用户拿对地址比什么都省事 ✓
      const urls = listLanUrls(this.actualPort);
      if (noAuth) {
        logger.warn('⚠️ 当前 **不校验钥匙**（--no-auth）⇒ 上面这些网址谁拿到都能用 ✓（早期测试用 ✓）');
      }
      logger.info([
        'HTTP API 已**对外开放**（监听 ' + host + ':' + this.actualPort + '）—— 同一局域网内的设备可以访问：',
        ...urls.map((u) => '   ' + u),
        '   钥匙接在网址后面： http://<上面某个地址>/  →  实际填写为  http://<地址>/?token=<你的钥匙>',
        '   提示：钥匙会留在浏览器的历史记录里；建议存成书签，别把带钥匙的网址转发给别人。',
        '   注意：媒体库与陪伴场景图这类"只读图片"端点不需要钥匙（浏览器显示图片时无法携带钥匙），',
        '         所以同网的人可以拉到这些图片；但**执行命令、改文件**仍必须凭钥匙 ✓。',
      ].join('\n'));
    }
  }

  async stop(): Promise<void> {
    if (this.app) { await this.app.close(); this.app = null; }
    this.status = 'stopped';
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    this.eventHandler = handler;
  }

  async reply(_sessionId: string, _reply: ChannelReply): Promise<void> {
    // HTTP webhook 模式下回复已在 POST /api/chat 响应中同步返回
  }

  getStatus(): ChannelStatus { return this.status; }

  private async ensureComponents(): Promise<AgentComponents> {
    if (!this.activeComponents) {
      const { createAgent } = await import('../../gateway/factory.js');
      const handler = new CollectHandler();
      this.activeComponents = await createAgent({
        cwd: this.cwd,
        provider: this.provider,
        maxTurns: this.maxTurns,
        maxContext: this.maxContext,
        outputHandler: handler as OutputHandler,
      });
    }
    return this.activeComponents;
  }

  /**
   * 将一条 WS 连接装配为统一 ui-protocol 会话（/tui /desktop /ui 共用）。
   * 内部：configCenter 兜底初始化 → ModelChannelRegistry + 轻量 manager →
   * historyProvider（events.jsonl）→ UiWsSession.initialize 创建 AgentLoop。
   * 连接断开时自动 close 会话。
   */
  private async wireUiSession(
    ws: import('ws').WebSocket,
    sessionId: string,
    /** 升级请求（回环判定用：preview.browse/setRoot 仅限本机；缺省按非回环 fail-closed） */
    req?: import('node:http').IncomingMessage,
  ): Promise<void> {
    // 回环判定：WS 升级连接的 remoteAddress 即客户端地址（HTTP 路由看
    // req.socket 同源）。拿不到一律按非回环处理 —— 换根/浏览全盘是"扩大
    // 服务端可读范围"的操作，宁可误拒也不能放给局域网 ✗
    const previewLoopback = isLoopbackRemoteAddress(
      (req as { socket?: { remoteAddress?: string } } | undefined)?.socket?.remoteAddress,
    );

    // ── 显式会话绑定与占用（多标签）──────────────────────────────
    // `?session=<id>`：绑定**已存在**的会话（每个并行标签一条 WS、各自一条 loop）。
    // 不带该参数：维持旧行为铸新 id（新建标签 / 普通刷新）。
    // 占用失败时先接受升级、回一条 ui.error 再关闭：浏览器 WebSocket 拿不到
    // HTTP 状态码，只有协议事件能把"为什么连不上"讲给前端。
    const claims = resolveClaims();
    const claimOwner = `ws_${randomBytes(8).toString('hex')}`;
    const requested = parseSessionParam(req);
    let effectiveSessionId = sessionId;
    if (requested) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(requested)) {
        this.rejectWs(ws, 'INVALID_SESSION', '会话 id 非法');
        return;
      }
      if (!existsSync(this.sessionManager.getSessionDir(requested))) {
        this.rejectWs(ws, 'SESSION_NOT_FOUND', `会话 "${requested}" 不存在`);
        return;
      }
      effectiveSessionId = requested;
    }
    if (!claims.claim(effectiveSessionId, claimOwner)) {
      this.rejectWs(ws, 'SESSION_IN_USE', `会话 "${effectiveSessionId}" 已在另一个标签中打开`);
      return;
    }
    // close 兜底必须在 initialize **之前**挂上：初始化期间客户端断开也要释放占用，
    // 否则槽位会泄漏到进程重启（后面的 session.close() 会再做一次，release 幂等）。
    let sessionRef: { close(): Promise<void> } | null = null;
    ws.on('close', () => {
      if (sessionRef) sessionRef.close().catch(() => {});
      else claims.release(effectiveSessionId, claimOwner);
    });

    try {
      // UiWsSession 与 start() 内为同一模块实例（动态 import 保持与 start 一致）
      const { UiWsSession } = await import('./ui-ws-session.js');

      // 兜底初始化 configCenter（serve 模式下可能未初始化，参照 TUI 远程模式）
      const { RuntimeConfigCenter } = await import('../../runtime/config-center.js');
      const { getDefaultConfig } = await import('../../runtime/defaults.js');
      const configCenter = RuntimeConfigCenter.getInstance();
      try {
        configCenter.get<number>('session.maxTurns');
      } catch {
        const { ConfigManager } = await import('../../setup/config.js');
        const cm = new ConfigManager(this.cwd);
        await cm.loadEnvKeys();
        const cfg = await cm.load();
        configCenter.initialize(getDefaultConfig(), cm);
        configCenter.merge(cfg as never);
      }

      // 构建模型通道注册表 + 轻量 manager（model.switch 同步 main 通道）
      const { ModelChannelRegistry } = await import('../../provider/model-channel-registry.js');
      const { CommandRegistry } = await import('../../ui/command-registry.js');
      const { getProviderConfigLoader } = await import('../../provider/config.js');
      const { coalesceEvents, readRecentEvents } = await import('../../memory/events.js');
      // ── 时序锚（2026-10-03 修复）：providers.json 必须先于通道创建就绪 ──
      // 与 tui.ts 同源缺陷：本函数下文的 `session.initialize(wsAgentFactory)`（→ createAgent
      // → agent-assembly 加载 providers.json）在建 registry **之后**才跑 ⇒ 若不在此显式加载，
      // JSON 声明厂商（commandcode 等）的工厂解析不到 ⇒ "Unknown provider type" ⇒ 通道创建
      // 失败、静默回退主 provider（WebUI 侧同样是"配置写了却没生效"）。
      // 单例重复 load() 仅重读一次文件，幂等无害。
      await getProviderConfigLoader(this.cwd).load();
      const registry = new ModelChannelRegistry(this.cwd);
      try { registry.load(this.provider); } catch { /* 加载失败不阻塞连接 */ }
      const manager = {
        switchProvider: (config: { type: string; apiKey?: string; model?: string; baseUrl?: string; userId?: string }): void => {
          try { registry.setChannelModel('chat', config.type, config.model); } catch { /* noop */ }
        },
      };

      // 历史消息真实来源：sessionId → sessionDir → events.jsonl
      // ⚠️ 先聚合再截取：text/thinking 是逐 token 记录的，若先截 N 条再聚合，
      // 400 条原始事件只够两三个回合，「显示更多」会因数据不足而永远不出现。
      // 读足量原始事件 → 聚合还原为完整消息 → 取末尾 limit 条。
      const historyProvider = async (sid: string, limit?: number) => {
        // 目录解析顺序（2026-10-23 修）：
        //   1) 调用方**明确点名**的 sid —— 它能解析到真实目录就用它；
        //   2) 退回 loop 的实时 sessionDir（陪伴 activate/deactivate 会改它）；
        //   3) 最后才是 sessionStore 推算出来的路径。
        //
        // 为什么不能只信 loop.sessionDir：`loop.switchSession()` 只登记 pendingSessionDir，
        // 真正改 sessionDir 要等**下一轮开头的 applyPendingSessionSwitch()**（loop.ts:863）。
        // 于是"切完会话立刻拉历史"这个最常见的动作，读到的仍是**上一个**会话的目录
        // ⇒ 侧栏点会话后正文空白（2026-10-23 用 chrome-devtools MCP 实测：switch 返回 ok，
        //   但 message.history 恒为 0 条）。
        const sidDir = sid ? this.sessionManager.getSessionDir(sid) : undefined;
        const loopDir = (agentComponents?.loop as { sessionDir?: string } | undefined)?.sessionDir;
        const dir = (sidDir && existsSync(sidDir) ? sidDir : undefined) || loopDir || sidDir;
        if (!dir) return [];          // sid 为空且 loop 还没建目录 ⇒ 没有历史可读，别去猜 cwd
        const raw = await readRecentEvents(dir, 5000);
        const events = coalesceEvents(raw).slice(-(limit ?? 50));
        const mapped = events.map((e) => {
          // 同一文件里存在两套 tool_call 形状：
          //   ConversationEvent → { name, id, input }
          //   SessionEvent      → { tool_name, tool_use_id }（无 input）
          // 历史回放统一归一化，否则旧形状的事件在 UI 上退化成无名的「工具」卡片。
          const legacy = e as unknown as { tool_name?: string; tool_use_id?: string };
          return {
            type: e.type,
            content: e.content,
            name: e.name ?? legacy.tool_name,
            id: e.id ?? legacy.tool_use_id,
            input: e.input,
            toolUseId: e.tool_use_id ?? legacy.tool_use_id,
            message: e.message,
            reason: e.reason,
            inputTokens: e.input_tokens,
            outputTokens: e.output_tokens,
            timestamp: e.timestamp,
          };
        });

        // 同一次工具调用会被两条链路各记一遍（loop 的 ConversationEvent 带
        // input，session 事件只有 tool_name）⇒ 旧实现渲染出「空参数 + 有参数」
        // 两张卡。按 tool_use_id 去重，并保留信息更完整的那条。
        const score = (m: (typeof mapped)[number]): number =>
          (m.input && typeof m.input === 'object' && Object.keys(m.input).length ? 2 : 0) +
          (m.name ? 1 : 0) +
          (m.content ? 1 : 0);
        const seen = new Map<string, number>();
        const out: typeof mapped = [];
        for (const m of mapped) {
          if (m.type === 'tool_call' || m.type === 'tool_result') {
            const key = m.type + ':' + (m.toolUseId || m.id || '');
            if (key.endsWith(':')) {
              out.push(m);
              continue;
            }
            const at = seen.get(key);
            if (at !== undefined) {
              if (score(m) > score(out[at])) out[at] = m;
              continue;
            }
            seen.set(key, out.length);
          }
          out.push(m);
        }
        return out;
      };

      // 会话统计真实来源：sessionId → sessionDir → stats.json（StatsManager）
      const statsProvider = async (sid: string) => {
        const { StatsManager } = await import('../../memory/stats.js');
        const dir = this.sessionManager.getSessionDir(sid);
        return new StatsManager(this.cwd).get(dir);
      };

      // kb / process / orchestrator / tool / bundle / mcp / plugin 域依赖 agent 组件（initialize 后才就绪）：用可变引用延迟解析
      let agentComponents: {
        knowledgeBase?: unknown;
        backgroundRegistry?: unknown;
        toolRegistry?: unknown;
        skillRegistry?: unknown;
        bundleRegistry?: unknown;
        mcpSystem?: unknown;
        pluginManager?: unknown;
        loop?: { bypassManager?: unknown; sessionDir?: string; activeRouter?: { name?: string }; syncRouter?(target?: string): Promise<void> };
        sessionManager?: unknown;
        sessionDir?: string;
        companionSessionManager?: unknown;
      } | null = null;

      const session = new UiWsSession(ws, effectiveSessionId, {
        cwd: this.cwd,
        // 连接即登记、**不落盘**：此前这里是"每刷新建一个 0 文件空壳会话"的现场 ✗
        // （首条用户消息到达时由 loop 物化，与 TUI 新建路径一致 ✓）
        // 目录已存在（?session= 绑定旧会话）时 boot 会走 resume，语义不变 ✓
        lazySession: true,
        claims,
        claimOwner,
        configCenter: configCenter as unknown as UiWsSessionBackend['configCenter'],
        sessionStore: this.sessionManager,
        registry,
        manager,
        commandRegistry: CommandRegistry.getInstance(this.cwd),
        listProvidersMeta: () => getProviderConfigLoader(this.cwd).getAll(),
        // 密钥落点与 TUI 统一：写 ~/.agent/.env（ConfigManager.saveApiKey）。
        // 只写 model-channels.json 的话，TUI 与外部环境变量读取方都看不到 WebUI 配的 key。
        persistApiKey: async (provider: string, apiKey: string) => {
          const { ConfigManager } = await import('../../setup/config.js');
          await new ConfigManager(this.cwd).saveApiKey(provider, apiKey);
        },
        // preview 域：与 HTTP 路由共享同一服务实例（换根两边立刻一致）；rawUrl
        // 由服务端签发并嵌入 ?token=（<img>/<iframe> 无法带 Authorization 头）；
        // browse/setRoot 仅限回环连接，与 HTTP 路由同一安全边界。
        previewService: () => this.previewService,
        makePreviewRawUrl: (rel: string) =>
          '/api/fs/raw?path=' + encodeURIComponent(rel)
          + (this.apiKeyValue ? '&token=' + encodeURIComponent(this.apiKeyValue) : ''),
        previewLoopback,
        listLocalModels: () => {
          const localModel = LocalModelModule.getInstance();
          return localModel.list().map((e) => ({
            name: e.name,
            modelFile: e.modelFile,
            backend: e.backend,
            port: e.port,
            host: e.host,
            ctxSize: e.ctxSize,
            nGpuLayers: e.nGpuLayers,
            enabled: e.enabled,
          }));
        },
        statsProvider,
        getKb: () =>
          (agentComponents?.knowledgeBase as import('../../ui-protocol/domains/kb.js').KnowledgeBaseLike | undefined) ?? null,
        getComposerConditions: () =>
          ((agentComponents as Record<string, unknown> | null)?.contextComposer as { activeConditions?: Set<string> } | undefined)?.activeConditions ?? null,
        getRegistry: () =>
          (agentComponents?.backgroundRegistry as import('../../ui-protocol/domains/process.js').BackgroundRegistryLike | undefined) ?? null,
        getBypassManager: () =>
          (agentComponents?.loop?.bypassManager as import('../../ui-protocol/domains/orchestrator.js').BypassManagerLike | undefined) ?? null,
        getToolRegistry: () =>
          (agentComponents?.toolRegistry as import('../../ui-protocol/domains/tool.js').ToolRegistryLike | undefined) ?? null,
        getSkillRegistry: () =>
          (agentComponents?.skillRegistry as import('../../ui-protocol/domains/skill.js').SkillRegistryLike | undefined) ?? null,
        getBundleRegistry: () =>
          (agentComponents?.bundleRegistry as import('../../ui-protocol/domains/bundle.js').BundleRegistryLike | undefined) ?? null,
        getMCP: () =>
          (agentComponents?.mcpSystem as import('../../ui-protocol/domains/mcp.js').MCPSystemLike | undefined) ?? null,
        // 目录插件管理面：把 PluginManager 映射成 plugin 域的窄形状（manifest 拍平 +
        // 管理方法直通）。agentComponents 就绪前（页面连接早于 initialize 完成）为 null
        // ⇒ 前端列表为空 + 写操作报错，属于正常瞬态。
        getDirectoryPlugins: () => {
          const pm = agentComponents?.pluginManager as
            | import('../../plugins/manager.js').PluginManager
            | undefined;
          if (!pm) return null;
          return {
            getAll: () => pm.getAll().map((p) => ({
              id: p.manifest.id,
              name: p.manifest.name,
              description: p.manifest.description,
              status: p.status,
              error: p.error,
              dir: p.dir,
              skillCount: p.manifest.skills?.length ?? 0,
              mcpServerCount: p.mcpServers?.length ?? 0,
            })),
            activate: (id: string) => pm.activate(id),
            deactivate: (id: string) => pm.deactivate(id),
            reloadFromDisk: (id: string) => pm.reloadFromDisk(id),
          };
        },
        getCompanionMgr: () =>
          ((agentComponents as Record<string, unknown>)?.companionSessionManager as import('../../ui-protocol/domains/companion.js').CompanionMgrLike | undefined) ?? null,
        getRouterSwitcher: () => {
          const loop = agentComponents?.loop;
          if (!loop) return null;
          return {
            getRouter: (name: string) => getRouterByName(name),
            getActiveRouterName: () => loop.activeRouter?.name ?? 'normal',
            syncRouter: (name: string) => loop.syncRouter?.(name) ?? Promise.resolve(),
            // mode = null ⇒ 回默认模式（由 mode-switch 统一判定，桥接层不替它做选择）
            switchToMode: async (mode: string | null, params?: Record<string, unknown>) => {
              await switchToMode(loop as never, mode, params);
            },
            clearPromptCache,
          };
        },
        configureLocalModel: (config) => {
          if (config.ollamaUrl) {
            try { configCenter.set('localModel.ollamaUrl', config.ollamaUrl); } catch { /* noop */ }
          }
        },
        localModelOps: {
          start: (name) => LocalModelModule.getInstance().start(name),
          stop: (name) => LocalModelModule.getInstance().stop(name),
          switch: (name) => LocalModelModule.getInstance().switch(name),
          register: (opts) => LocalModelModule.getInstance().registerModel(opts as unknown as Parameters<LocalModelModule['registerModel']>[0]),
          unregister: (name) => LocalModelModule.getInstance().unregisterModel(name),
          scanUnregistered: () => LocalModelModule.getInstance().scanUnregistered(),
        },
        historyProvider,
      });

      // 交给 close 兜底管理（session.close 内释放占用）；放在 initialize 之前，
      // 初始化期间断开同样会被释放。
      sessionRef = session;
      if (this.wsAgentFactory) {
        await session.initialize(this.wsAgentFactory);
        // initialize 后 agent 组件就绪：供 kb/process/plugin 等域延迟解析
        agentComponents = session.getComponents<{
          knowledgeBase?: unknown;
          backgroundRegistry?: unknown;
          toolRegistry?: unknown;
          skillRegistry?: unknown;
          bundleRegistry?: unknown;
          mcpSystem?: unknown;
          pluginManager?: unknown;
          loop?: { bypassManager?: unknown };
          sessionManager?: unknown;
          sessionDir?: string;
        }>() ?? null;
      } else {
        logger.warn('UI WS agentFactory not available');
      }
      ws.on('close', () => {
        logger.info('UI WS client disconnected', { sessionId: effectiveSessionId });
      });
    } catch (err) {
      logger.error('UI WS init failed', err instanceof Error ? err : new Error(String(err)));
      // 初始化失败：会话没建起来 ⇒ 直接归还占用（session.close 未走到时兜底）
      if (!sessionRef) claims.release(effectiveSessionId, claimOwner);
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  /**
   * 拒绝一条 WS 连接：先发协议层 ui.error（浏览器拿不到 HTTP 状态码），
   * 再用 4409 关闭。前端 embed 模式据此停止自动重连并展示原因。
   */
  private rejectWs(ws: import('ws').WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ kind: 'event', type: 'ui.error', payload: { code, message } }));
    } catch { /* socket 可能已断开 */ }
    try { ws.close(4409, code); } catch { /* ignore */ }
  }
}

/** 从升级请求 URL 解析 `?session=`（缺省/空白 → null） */
function parseSessionParam(req?: { url?: string }): string | null {
  if (!req?.url) return null;
  try {
    const value = new URL(req.url, 'http://localhost').searchParams.get('session');
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}
