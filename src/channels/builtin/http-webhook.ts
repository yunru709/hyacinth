// ============================================================
// HttpWebhookChannel — 内建 HTTP REST API 渠道（企业加固版）
// ============================================================
//
// 端点：/api/health, /api/chat, /api/sessions, /api/tools, /api/skills
// 认证：Bearer Token（HYACINTH_API_KEY 环境变量或 --api-key 参数）
// Chat 为同步 request-response 模式。
// ============================================================

import { WEBUI_SESSION_PREFIXES } from '../../session-channel.js';
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
import { LocalModelModule } from '../../local-model/index.js';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { UiWsSessionBackend } from './ui-ws-session.js';
import { switchRouter, getActiveRouterName } from '../../context/profiles.js';
import { clearPromptCache } from '../../prompts/loader.js';

const logger = createLogger('http-webhook');

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
    path === '/favicon.ico' ||
    path.startsWith('/vendor/') ||
    path.startsWith('/assets/')
  );
}

function authHook(apiKey: string | null) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // /api/health、/api/media、/api/companion + WebUI 静态资源 无需认证
    if (isPublicReadRoute(req.url) || isPublicWebUIRoute(req.url)) return;

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
  /** sessionId 前缀（引用 src/session-channel.ts 内置前缀常量，勿写字面量） */
  readonly sessionPrefix = WEBUI_SESSION_PREFIXES;

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
    if (!apiKey) {
      logger.warn('No HYACINTH_API_KEY set — HTTP API will reject all requests except /api/health. Set the environment variable or use --api-key.');
    }

    const fastify = (await import('fastify')).default;
    this.app = fastify({ logger: false });

    // ── 安全加固（全路由）───────────────────────────────────────────
    this.app.addHook('preHandler', authHook(apiKey));

    this.app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
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
        const path = await import('node:path');
        const os = await import('node:os');
        const sessionDir = path.join(os.homedir(), '.agent', 'sessions', id);
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
    const { randomBytes } = await import('node:crypto');
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

    tuiWss.on('connection', (ws) => {
      const sessionId = `tui_${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      logger.info('TUI WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId);
    });

    // ── Desktop GUI WebSocket 端点 ──
    desktopWss.on('connection', (ws) => {
      const now = new Date();
      const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const time = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      const sessionId = `webui_${date}-${time}-${randomBytes(3).toString('hex')}`;
      logger.info('Desktop WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId);
    });

    // ── UI 协议层 WebSocket 端点（/ui，统一 UI 协议层） ─
    uiWss.on('connection', (ws) => {
      // 与 /desktop 同格式的 webui_ 前缀：可被 SessionManager 渠道识别（feishu_/webui_/tui_）
      const now = new Date();
      const date = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
      const time = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
      const sessionId = `webui_${date}-${time}-${randomBytes(3).toString('hex')}`;
      logger.info('UI WS client connected', { sessionId });
      void this.wireUiSession(ws, sessionId);
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
    logger.info(`HTTP API listening on ${host}:${this.actualPort}${apiKey ? ' (auth enabled)' : ' (auth: only /api/health)'}`);
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

  async handleMessage(): Promise<void> {
    throw new Error('HTTP webhook channel does not support handleMessage');
  }

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
  private async wireUiSession(ws: import('ws').WebSocket, sessionId: string): Promise<void> {
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
      const registry = new ModelChannelRegistry(this.cwd);
      try { registry.load(this.provider); } catch { /* 加载失败不阻塞连接 */ }
      const manager = {
        switchProvider: (config: { type: string; apiKey?: string; model?: string; baseUrl?: string; userId?: string }): void => {
          try { registry.setChannelModel('main', config.type, config.model); } catch { /* noop */ }
        },
      };

      // 历史消息真实来源：sessionId → sessionDir → events.jsonl
      // ⚠️ 先聚合再截取：text/thinking 是逐 token 记录的，若先截 N 条再聚合，
      // 400 条原始事件只够两三个回合，「显示更多」会因数据不足而永远不出现。
      // 读足量原始事件 → 聚合还原为完整消息 → 取末尾 limit 条。
      // 目录优先取 loop 实时 sessionDir：陪伴 activate/deactivate 会切换
      // 会话目录，固定用 sessionStore 记录会导致主界面读到陪伴会话历史
      const historyProvider = async (sid: string, limit?: number) => {
        const dir =
          (agentComponents?.loop as { sessionDir?: string } | undefined)?.sessionDir ||
          this.sessionManager.getSessionDir(sid);
        const raw = await readRecentEvents(dir, 5000);
        const events = coalesceEvents(raw).slice(-(limit ?? 50));
        return events.map((e) => ({
          type: e.type,
          content: e.content,
          name: e.name,
          id: e.id,
          input: e.input,
          toolUseId: e.tool_use_id,
          message: e.message,
          reason: e.reason,
          inputTokens: e.input_tokens,
          outputTokens: e.output_tokens,
          timestamp: e.timestamp,
        }));
      };

      // 会话统计真实来源：sessionId → sessionDir → stats.json（StatsManager）
      const statsProvider = async (sid: string) => {
        const { StatsManager } = await import('../../memory/stats.js');
        const dir = this.sessionManager.getSessionDir(sid);
        return new StatsManager(this.cwd).get(dir);
      };

      // kb / process / orchestrator / tool / bundle / mcp 域依赖 agent 组件（initialize 后才就绪）：用可变引用延迟解析
      let agentComponents: {
        knowledgeBase?: unknown;
        backgroundRegistry?: unknown;
        toolRegistry?: unknown;
        bundleRegistry?: unknown;
        mcpSystem?: unknown;
        loop?: { bypassManager?: unknown; sessionDir?: string };
        sessionManager?: unknown;
        sessionDir?: string;
        companionSessionManager?: unknown;
      } | null = null;

      const session = new UiWsSession(ws, sessionId, {
        cwd: this.cwd,
        configCenter: configCenter as unknown as UiWsSessionBackend['configCenter'],
        sessionStore: this.sessionManager,
        registry,
        manager,
        commandRegistry: CommandRegistry.getInstance(this.cwd),
        listProvidersMeta: () => getProviderConfigLoader(this.cwd).getAll(),
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
        getBundleRegistry: () =>
          (agentComponents?.bundleRegistry as import('../../ui-protocol/domains/bundle.js').BundleRegistryLike | undefined) ?? null,
        getMCP: () =>
          (agentComponents?.mcpSystem as import('../../ui-protocol/domains/mcp.js').MCPSystemLike | undefined) ?? null,
        getCompanionMgr: () =>
          ((agentComponents as Record<string, unknown>)?.companionSessionManager as import('../../ui-protocol/domains/companion.js').CompanionMgrLike | undefined) ?? null,
        getRouterSwitcher: () => ({ switchRouter, getActiveRouterName, clearPromptCache }),
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

      if (this.wsAgentFactory) {
        await session.initialize(this.wsAgentFactory);
        // initialize 后 agent 组件就绪：供 kb/process 域延迟解析
        agentComponents = session.getComponents<{
          knowledgeBase?: unknown;
          backgroundRegistry?: unknown;
          loop?: { bypassManager?: unknown };
          sessionManager?: unknown;
          sessionDir?: string;
        }>() ?? null;
      } else {
        logger.warn('UI WS agentFactory not available');
      }
      ws.on('close', () => {
        session.close().catch(() => {});
        logger.info('UI WS client disconnected', { sessionId });
      });
    } catch (err) {
      logger.error('UI WS init failed', err instanceof Error ? err : new Error(String(err)));
      try { ws.close(); } catch { /* ignore */ }
    }
  }
}
