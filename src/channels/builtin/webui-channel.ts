// ============================================================
// WebUIChannel — 内建 Web 前端渠道
// ============================================================
//
// 实现 ChannelHandler，提供：
//   - WebSocket (/ws) — 双向流式通信，主力传输层
//   - REST API (/api/*) — 数据查询（sessions, tools, skills, config...）
//   - 静态文件服务 — 前端 SPA 构建产物
//
// 与 TUI、HTTP Webhook 平级——通过 ChannelManager 管理生命周期。
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
  AgentFactory,
  ReplyFn,
  ChannelMessageEvent,
} from '../interface.js';
import type { Provider } from '../../provider/interface.js';
import type { SessionManager } from '../../memory/session.js';
import type { OutputHandler } from '../../orchestrator/loop.js';
import type { AgentComponents } from '../../gateway/factory.js';
import { WebUIWsSession } from './webui-ws-session.js';
import type { WebUISessionConfig } from './webui-types.js';
import { createLogger } from '../../logging/logger.js';
import { getDefaultConfig } from '../../runtime/defaults.js';
import { RuntimeConfigCenter } from '../../runtime/config-center.js';
import { LocalModelModule } from '../../local-model/index.js';
import { ModelChannelRegistry } from '../../provider/model-channel-registry.js';
import { detectLocalBackend } from '../../provider/local-config.js';
import { HeartbeatScheduler } from '../../schedule/scheduler.js';
import type { ScheduledTask, TaskAction, ScheduleConfig } from '../../schedule/types.js';
import { CommandRegistry } from '../../ui/command-registry.js';
import type { SlashCommandDef } from '../../ui/command-registry.js';

const logger = createLogger('webui-channel');

// ── WebUIChannel ─────────────────────────────────────────────

export class WebUIChannel implements ChannelHandler {
  readonly id = 'webui';
  readonly name = 'Web UI';
  readonly description =
    '内建 Web 前端，通过浏览器访问，支持 WebSocket 实时流式输出';
  readonly pluginId = undefined;

  private app: FastifyInstance | null = null;
  // WebSocketServer — 动态导入 ws 模块，这里用 any 避免静态依赖
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wss: any = null;
  private httpServer: HttpServer | null = null;
  private status: ChannelStatus = 'registered';
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;

  // 依赖注入
  private provider!: Provider;
  private sessionManager!: SessionManager;
  private cwd!: string;
  private maxTurns!: number;
  private maxContext!: number;
  private personaDir!: string;
  private agentFactory: AgentFactory | null = null;

  // WebSocket 连接管理
  private sessions = new Map<string, WebUIWsSession>();
  /** clientId → sessionId 映射，用于重连时复用 session */
  private clientSessionMap = new Map<string, string>();
  private activeComponents: AgentComponents | null = null;

  // 本地模型与通道路由管理
  private localModelModule = LocalModelModule.getInstance();
  private channelRegistry: ModelChannelRegistry | null = null;

  async start(config: ChannelConfig): Promise<void> {
    const { port = 3100, host = '0.0.0.0', devMode = false, devServerUrl } = config;

    this.provider = config.provider as Provider;
    this.sessionManager = config.sessionManager as SessionManager;
    this.cwd = (config.cwd as string) ?? process.cwd();
    this.maxTurns =
      (config.maxTurns as number) ?? getDefaultConfig().session.maxTurns;
    this.maxContext = config.maxContext as number ?? 200000;
    this.personaDir = (config.personaDir as string) ?? 'default';
    // 从 config 中获取 agentFactory（由 ChannelManager.startChannel 注入）
    this.agentFactory = (config.agentFactory as AgentFactory) ?? null;

    // 初始化本地模型模块（若未初始化则使用当前项目根目录）
    if (!this.localModelModule.isInitialized()) {
      this.localModelModule.initialize(this.cwd);
    }
    // 初始化模型通道路由注册表
    this.channelRegistry = new ModelChannelRegistry(this.cwd);
    this.channelRegistry.load();

    const fastify = (await import('fastify')).default;
    this.app = fastify({ logger: false });

    // ── 安全加固 ──────────────────────────────────────────
    this.app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('X-XSS-Protection', '1; mode=block');
    });

    // ── WebSocket 升级 ────────────────────────────────────
    // 动态导入 ws 库（避免静态依赖）
    const { WebSocketServer: WSServer } = await import('ws');

    this.app.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws' && this.wss) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.wss.handleUpgrade(request, socket, head, (ws: any) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // 创建 WebSocket Server（绑定到 Fastify 的 HTTP server）
    this.wss = new WSServer({ noServer: true });

    this.wss.on('connection', (ws: import('./webui-ws-session.js').WsLike, request?: any) => {
      // 从 URL 中提取 clientId
      let clientId: string | undefined;
      try {
        if (request?.url) {
          const url = new URL(request.url, `http://${request.headers?.host ?? 'localhost'}`);
          clientId = url.searchParams.get('clientId') ?? undefined;
        }
      } catch { /* ignore */ }

      // 如果 clientId 已有映射，复用旧 sessionId；否则创建新 sessionId
      let sessionId: string;
      if (clientId && this.clientSessionMap.has(clientId)) {
        sessionId = this.clientSessionMap.get(clientId)!;
        logger.info('WebUI reusing session for clientId', { clientId, sessionId });
      } else {
        sessionId = this.generateSessionId();
        if (clientId) {
          this.clientSessionMap.set(clientId, sessionId);
          logger.info('WebUI new session for clientId', { clientId, sessionId });
        }
      }

      // 同一 clientId 重连时，如果旧 session 仍在管理中，先关闭旧连接
      const existingSession = this.sessions.get(sessionId);
      if (existingSession) {
        logger.info('WebUI closing stale session for clientId', { clientId, sessionId });
        existingSession.close().catch(() => {});
      }

      const session = new WebUIWsSession(ws, sessionId, this.sessionManager);

      session.onClose((sid) => {
        // 只有当前存活的 session 实例匹配时才删除（避免复用/覆盖时误删新 session）
        if (this.sessions.get(sid) === session) {
          this.sessions.delete(sid);
        }
        logger.info('WebUI client disconnected', {
          sessionId: sid,
          remaining: this.sessions.size,
        });
      });

      this.sessions.set(sessionId, session);

      // 异步初始化 AgentLoop
      if (this.agentFactory) {
        const sessionConfig: WebUISessionConfig = {
          cwd: this.cwd,
          provider: this.provider.getProviderType(),
          model: this.provider.getModel(),
          maxTurns: this.maxTurns,
          maxContext: this.maxContext,
          personaDir: this.personaDir,
        };
        session.initialize(this.agentFactory, sessionConfig).catch((err) => {
          logger.error('WebUI session init failed', err instanceof Error ? err : new Error(String(err)));
        });
      }

      // 消息处理
      ws.on('message', (data: Buffer) => {
        session.handleMessage(data).catch((err: unknown) => {
          logger.error('WebUI message handling error', err instanceof Error ? err : new Error(String(err)));
        });
      });

      // 连接关闭
      ws.on('close', () => {
        session.close().catch((err: unknown) => {
          logger.error('WebUI session close error', err instanceof Error ? err : new Error(String(err)));
        });
      });

      // 错误处理
      ws.on('error', (err: Error) => {
        logger.error('WebSocket error', err instanceof Error ? err : new Error(String(err)));
      });

      logger.info('WebUI client connected', {
        sessionId,
        total: this.sessions.size,
      });
    });

    // ── REST API 路由 ─────────────────────────────────────

    // Health
    this.app.get('/api/health', async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        status: 'ok',
        version: '1.0.0',
        channel: 'webui',
        sessions: this.sessions.size,
      });
    });

    // Sessions
    this.registerSessionRoutes();
    // Tools & Skills
    this.registerCapabilityRoutes();
    // Config
    this.registerConfigRoutes();
    // Rollback
    this.registerRollbackRoutes();
    // Knowledge Base
    this.registerKbRoutes();
    // Processes
    this.registerProcessRoutes();
    // Local Models
    this.registerLocalModelRoutes();
    // Model Channels
    this.registerChannelRoutes();
    // Scheduler
    this.registerSchedulerRoutes();
    // Command palette
    this.registerCommandRoutes();

    // ── 静态文件服务 ──────────────────────────────────────
    await this.registerStaticFiles(devMode as boolean, devServerUrl as string | undefined);

    // ── 启动服务器 ────────────────────────────────────────
    await this.app.listen({ port: port as number, host: host as string });
    this.httpServer = this.app.server;
    this.status = 'active';
    logger.info(`WebUI listening on http://${host}:${port}`);
  }

  async stop(): Promise<void> {
    // 关闭所有 WebSocket 连接
    for (const [sessionId, session] of this.sessions) {
      try {
        await session.close();
      } catch {
        // 忽略关闭错误
      }
      this.sessions.delete(sessionId);
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.app) {
      await this.app.close();
      this.app = null;
    }

    this.status = 'stopped';
    logger.info('WebUI stopped');
  }

  onEvent(handler: (event: ChannelEvent) => Promise<void>): void {
    this.eventHandler = handler;
  }

  async reply(_sessionId: string, _reply: ChannelReply): Promise<void> {
    // WebUI 模式下回复已通过 WebSocket 实时发送
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  async handleMessage(
    event: ChannelMessageEvent,
    replyFn: ReplyFn,
    agentFactory: AgentFactory,
  ): Promise<void> {
    // WebUI 不使用统一的 handleMessage——每个 WebSocket 连接独立处理
    // 但需要保存 agentFactory 用于新连接初始化
    this.agentFactory = agentFactory;

    // 触发事件（可选，用于日志/监控）
    if (this.eventHandler) {
      this.eventHandler(event).catch(() => {});
    }
  }

  updateConfig(newConfig: Record<string, unknown>): Promise<void> {
    // 热更新配置（部分参数运行时生效）
    if (typeof newConfig.maxTurns === 'number') {
      this.maxTurns = newConfig.maxTurns as number;
    }
    if (typeof newConfig.maxContext === 'number') {
      this.maxContext = newConfig.maxContext as number;
    }
    return Promise.resolve();
  }

  // ── 私有方法 ──────────────────────────────────────────────

  /** 生成唯一的 session ID */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `webui-${timestamp}-${random}`;
  }

  /** 注册 Session REST API */
  private registerSessionRoutes(): void {
    if (!this.app) return;

    // 列出 sessions
    this.app.get('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const sessions = await this.sessionManager.list();
        return reply.send(sessions);
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // 创建 session
    this.app.post('/api/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = req.body as { type?: 'normal' | 'precise' } | undefined;
        const type = body?.type === 'precise' ? 'precise' : 'normal';
        const session = await this.sessionManager.create(type, 'webui');
        return reply.send({
          id: session.id,
          createdAt: session.createdAt,
          type: session.type,
          channel: session.channel,
        });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // 获取 session 详情
    this.app.get(
      '/api/sessions/:id',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const session = await this.sessionManager.resume(id);
          return reply.send({
            id: session.id,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            type: session.type,
            channel: session.channel,
          });
        } catch {
          return reply.status(404).send({ error: 'Session not found' });
        }
      },
    );

    // 删除 session
    this.app.delete(
      '/api/sessions/:id',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          const sessionDir = this.sessionManager.getSessionDir(id);
          await fs.promises.rm(sessionDir, { recursive: true, force: true });
          return reply.send({ ok: true });
        } catch {
          return reply.status(404).send({ error: 'Session not found' });
        }
      },
    );

    // 批量删除 "其他" 渠道的 session（不匹配 webui-/tui-/feishu_ 前缀）
    this.app.delete('/api/sessions/channel/legacy', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const sessions = await this.sessionManager.list();
        const legacySessions = sessions.filter(s => {
          const id = s.id;
          return !id.startsWith('webui-') && !id.startsWith('tui-') && !id.startsWith('feishu_');
        });
        let deleted = 0;
        for (const s of legacySessions) {
          try {
            const sessionDir = this.sessionManager.getSessionDir(s.id);
            await fs.promises.rm(sessionDir, { recursive: true, force: true });
            deleted++;
          } catch { /* skip */ }
        }
        return reply.send({ ok: true, deleted, total: legacySessions.length });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 获取 session 历史事件（重放用）
    this.app.get(
      '/api/sessions/:id/events',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        const { limit } = req.query as { limit?: string };
        const eventLimit = limit ? parseInt(limit, 10) || 50 : 50;
        try {
          const sessionDir = this.sessionManager.getSessionDir(id);
          const events = await this.loadRecentEvents(sessionDir, eventLimit);
          return reply.send(events);
        } catch {
          return reply.status(404).send({ error: 'Session not found' });
        }
      },
    );
  }

  /** 注册能力发现 API */
  private registerCapabilityRoutes(): void {
    if (!this.app) return;

    this.app.get('/api/tools', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const tools = components.toolRegistry.getAll().map((t) => ({
        name: t.name,
        description: t.description,
        schema: (t as any).inputSchema ?? null,
      }));
      return reply.send(tools);
    });

    this.app.get('/api/skills', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const skills = components.skillRegistry.getAll().map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
      }));
      return reply.send(skills);
    });

    this.app.get('/api/agents', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const agents = components.agentRegistry.getAll().map((a) => ({
        name: a.name,
        description: a.description,
      }));
      return reply.send(agents);
    });

    this.app.get('/api/workflows', async (_req: FastifyRequest, reply: FastifyReply) => {
      const components = await this.ensureComponents();
      const workflows = components.workflowRegistry.getAll().map((w) => ({
        name: w.name,
        description: w.description,
      }));
      return reply.send(workflows);
    });

    this.app.get('/api/status', async (_req: FastifyRequest, reply: FastifyReply) => {
      return reply.send({
        connectedClients: this.sessions.size,
        channel: 'webui',
        status: this.status,
        cwd: this.cwd,
        provider: this.provider.getProviderType(),
        model: this.provider.getModel(),
      });
    });

    this.app.get('/api/model-status', async (_req: FastifyRequest, reply: FastifyReply) => {
      const status = await this.buildModelStatus();
      return reply.send(status);
    });
  }

  /** 注册配置 API */
  private registerConfigRoutes(): void {
    if (!this.app) return;

    this.app.get('/api/config', async (_req: FastifyRequest, reply: FastifyReply) => {
      // 返回脱敏后的配置
      const configCenter = RuntimeConfigCenter.getInstance();
      let config: Record<string, unknown> = {};
      try {
        config = configCenter.getAll() as unknown as Record<string, unknown>;
      } catch {
        // configCenter 可能尚未初始化，回退到 channel 本地值
      }
      return reply.send({
        cwd: this.cwd,
        maxTurns: config['session'] ? (config['session'] as Record<string, unknown>).maxTurns ?? this.maxTurns : this.maxTurns,
        maxContext: config['session'] ? (config['session'] as Record<string, unknown>).maxContext ?? this.maxContext : this.maxContext,
        context: config['context'] ?? null,
        repair: config['repair'] ?? null,
        safety: config['safety'] ?? null,
        logging: config['logging'] ?? null,
        provider: config['provider'] ?? null,
        kb: config['kb'] ?? null,
      });
    });

    // PATCH: 部分更新安全配置（仅允许白名单路径）
    this.app.patch('/api/config', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Request body must be a JSON object' });
      }

      const configCenter = RuntimeConfigCenter.getInstance();

      // 白名单：只允许通过 WebUI 更新的安全配置路径
      const allowedPaths = [
        'session.maxTurns',
        'session.maxContext',
        'context.compressThreshold',
        'context.emergencyThreshold',
        'context.compressDepth',
        'context.compressionStrategy',
        'repair.scavenge.enabled',
        'repair.storm.enabled',
        'repair.storm.windowSize',
        'repair.storm.threshold',
        'safety.requireConfirmation',
        'safety.dangerousTools',
        'safety.allowedTools',
        'safety.allowedCommands',
        'logging.level',
        'provider.enableThinking',
        'provider.thinkingEffort',
        'provider.showThinking',
        'kb.enabled',
        'kb.zone4',
      ];

      const updated: string[] = [];
      const skipped: string[] = [];

      for (const [key, value] of Object.entries(body)) {
        if (!allowedPaths.includes(key)) {
          skipped.push(key);
          continue;
        }
        try {
          configCenter.set(key, value);
          updated.push(key);
        } catch (err) {
          logger.warn('Failed to set config key', { key, error: String(err) });
          skipped.push(key);
        }
      }

      try {
        await configCenter.save();
        logger.info('WebUI config updated via PATCH', { updated, skipped });
        return reply.send({ ok: true, updated, skipped });
      } catch (err) {
        logger.error('Failed to save config after PATCH', err instanceof Error ? err : new Error(String(err)));
        return reply.status(500).send({
          error: 'Config updated in memory but failed to persist',
          updated,
          skipped,
        });
      }
    });
  }

  /** 注册回滚 API */
  private registerRollbackRoutes(): void {
    if (!this.app) return;

    this.app.get(
      '/api/rollback/status',
      async (_req: FastifyRequest, reply: FastifyReply) => {
        try {
          const rollbackDir = path.join(this.cwd, '.agent', 'rollback');
          const indexFile = path.join(rollbackDir, 'index.json');
          if (!fs.existsSync(indexFile)) {
            return reply.send({ turns: [] });
          }
          const raw = fs.readFileSync(indexFile, 'utf-8');
          const index = JSON.parse(raw);
          return reply.send(index);
        } catch (err) {
          return reply.status(500).send({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    this.app.post(
      '/api/rollback',
      async (req: FastifyRequest, reply: FastifyReply) => {
        // 回滚通过 WebUIWsSession 中的 AgentLoop 执行
        // REST 端点返回提示（实际回滚由 WebSocket 消息驱动）
        return reply.send({
          message: 'Use the rollback tool via chat, or check /api/rollback/status for available turns.',
        });
      },
    );
  }

  /** 注册知识库 API */
  private registerKbRoutes(): void {
    if (!this.app) return;

    this.app.get(
      '/api/kb/query',
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { q } = req.query as { q?: string };
        if (!q) {
          return reply.status(400).send({ error: 'Query parameter "q" is required' });
        }
        try {
          const components = await this.ensureComponents();
          const { structuredStore } = components;
          const results = structuredStore.search(q, 10);
          return reply.send({ results });
        } catch (err) {
          return reply.status(500).send({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

    this.app.get('/api/kb/stats', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const components = await this.ensureComponents();
        const { structuredStore } = components;
        // 使用 search 返回的结果数量作为简单统计
        const results = structuredStore.search('', 1);
        return reply.send({ totalEntries: results.length });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** 注册后台进程 API */
  private registerProcessRoutes(): void {
    if (!this.app) return;

    this.app.get('/api/processes', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const components = await this.ensureComponents();
        const { backgroundRegistry } = components;
        return reply.send(backgroundRegistry.list());
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** 静态文件服务（前端 SPA） */
  private async registerStaticFiles(
    devMode: boolean,
    devServerUrl?: string,
  ): Promise<void> {
    if (!this.app) return;

    if (devMode && devServerUrl) {
      // 开发模式：代理到 Vite dev server
      try {
        // @ts-expect-error @fastify/http-proxy 可选依赖，仅开发模式需要
        const { default: proxy } = await import('@fastify/http-proxy');
        await this.app.register(proxy, {
          upstream: devServerUrl,
          prefix: '/',
          rewritePrefix: '/',
        });
        logger.info(`WebUI dev mode: proxying to ${devServerUrl}`);
      } catch {
        logger.warn('@fastify/http-proxy not installed. Install for dev mode proxy support.');
        this.app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
          return reply.type('text/html').send(this.getFallbackHtml());
        });
      }
    } else {
      // 生产模式：serve 构建产物
      const distDir = path.join(os.homedir(), '.agent', 'webui', 'dist');

      // 检查 dist 目录是否存在
      if (!fs.existsSync(distDir)) {
        logger.warn(`WebUI dist directory not found: ${distDir}`);
        // 注册一个 fallback 路由，显示提示页面
        this.app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
          return reply
            .type('text/html')
            .send(this.getFallbackHtml());
        });
        return;
      }

      try {
        const { default: fastifyStatic } = await import('@fastify/static');
        await this.app.register(fastifyStatic, {
          root: distDir,
          prefix: '/',
        });

        // SPA fallback：所有非 /api 路径返回 index.html
        this.app.setNotFoundHandler(
          async (req: FastifyRequest, reply: FastifyReply) => {
            if (req.url.startsWith('/api/')) {
              return reply.status(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(distDir, 'index.html');
            if (fs.existsSync(indexPath)) {
              return reply.type('text/html').send(
                fs.readFileSync(indexPath, 'utf-8'),
              );
            }
            return reply.status(404).send({ error: 'Not found' });
          },
        );

        logger.info(`WebUI serving static files from ${distDir}`);
      } catch (err) {
        logger.error('Failed to register static file service', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** 注册本地模型 API */
  private registerLocalModelRoutes(): void {
    if (!this.app) return;

    // 检测本地模型后端状态
    this.app.post('/api/local-models/detect', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const detected = await detectLocalBackend();
        const ollamaBin = this.localModelModule.checkOllama();
        const llamacppBin = this.localModelModule.checkLlamacpp();
        return reply.send({
          detected,
          ollamaInstalled: !!ollamaBin,
          ollamaPath: ollamaBin,
          llamacppInstalled: !!llamacppBin,
          llamacppPath: llamacppBin,
          registeredModels: this.localModelModule.list().map((m) => m.name),
        });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 扫描并注册未注册的模型
    this.app.post('/api/local-models/register', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const found = await this.localModelModule.scanUnregistered();
        const registered: string[] = [];
        for (const f of found) {
          this.localModelModule.registerModel({
            name: f.name,
            modelFile: f.modelFile,
            backend: f.backend as 'llama.cpp' | 'ollama' | undefined,
          });
          registered.push(f.name);
        }
        return reply.send({ ok: true, registered, count: registered.length });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 注销模型
    this.app.post('/api/local-models/unregister', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { name?: string } | undefined;
      const name = body?.name;
      if (!name) {
        return reply.status(400).send({ error: 'Model name is required' });
      }
      try {
        const ok = this.localModelModule.unregisterModel(name);
        return reply.send({ ok, name });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 启动模型 / 本地后端
    this.app.post('/api/local-models/start', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { name?: string } | undefined;
      const name = body?.name;
      try {
        const detected = await detectLocalBackend();
        // 无指定名称且 Ollama 可用：优先启动 Ollama 服务
        if (!name) {
          const ollamaBin = this.localModelModule.checkOllama();
          if (ollamaBin) {
            if (detected?.backend === 'ollama') {
              return reply.send({ ok: true, backend: 'ollama', message: 'Ollama 已在运行' });
            }
            const { LifecycleSupervisor } = await import('../../lifecycle/supervisor.js');
            const supervisor = new LifecycleSupervisor();
            const info = await supervisor.startOllamaOnDemand(this.cwd);
            return reply.send({ ok: !!info, backend: 'ollama', info });
          }
          const models = this.localModelModule.list();
          if (models.length === 0) {
            return reply.status(400).send({ error: '没有已注册的本地模型，请先注册或安装 Ollama' });
          }
          const first = models[0]!;
          const info = await this.localModelModule.start(first.name);
          return reply.send({ ok: !!info, name: first.name, info });
        }

        // 指定了 backend 名称
        const backend = name.toLowerCase();
        if (backend === 'ollama') {
          if (detected?.backend === 'ollama') {
            return reply.send({ ok: true, backend: 'ollama', message: 'Ollama 已在运行' });
          }
          const { LifecycleSupervisor } = await import('../../lifecycle/supervisor.js');
          const supervisor = new LifecycleSupervisor();
          const info = await supervisor.startOllamaOnDemand(this.cwd);
          return reply.send({ ok: !!info, backend: 'ollama', info });
        }
        if (backend === 'llamacpp' || backend === 'llama.cpp') {
          const models = this.localModelModule.list();
          if (models.length === 0) {
            return reply.status(400).send({ error: '没有已注册的 llama.cpp 模型' });
          }
          const first = models[0]!;
          const info = await this.localModelModule.start(first.name);
          return reply.send({ ok: !!info, backend: 'llamacpp', name: first.name, info });
        }

        // 指定了模型名
        const model = this.localModelModule.list().find((m) => m.name === name);
        if (!model) {
          return reply.status(404).send({ error: `模型 "${name}" 未注册` });
        }
        const info = await this.localModelModule.start(name);
        return reply.send({ ok: !!info, name, info });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 停止模型 / 本地后端
    this.app.post('/api/local-models/stop', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { name?: string } | undefined;
      const name = body?.name;
      try {
        // 停止指定模型
        if (name) {
          const backend = name.toLowerCase();
          if (backend === 'ollama') {
            const { LifecycleSupervisor } = await import('../../lifecycle/supervisor.js');
            const supervisor = new LifecycleSupervisor();
            await supervisor.stopModel('ollama');
            return reply.send({ ok: true, name: 'ollama' });
          }
          await this.localModelModule.stop(name);
          return reply.send({ ok: true, name });
        }

        // 停止所有运行中的本地模型
        const running = this.localModelModule.getBridge().getAllStatus().filter((s) => s.state === 'running');
        const stopped: string[] = [];
        const detected = await detectLocalBackend();
        if (detected?.backend === 'ollama') {
          const { LifecycleSupervisor } = await import('../../lifecycle/supervisor.js');
          const supervisor = new LifecycleSupervisor();
          await supervisor.stopModel('ollama');
          stopped.push('ollama');
        }
        for (const m of running) {
          await this.localModelModule.getBridge().stop(m.name);
          stopped.push(m.name);
        }
        return reply.send({ ok: true, stopped });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 切换到本地模型（启动并切换 provider）
    this.app.post('/api/local-models/switch', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { name?: string } | undefined;
      const name = body?.name;
      try {
        let targetName = name;
        if (!targetName) {
          const models = this.localModelModule.list();
          if (models.length === 0) {
            return reply.status(400).send({ error: '没有已注册的本地模型' });
          }
          targetName = models[0]!.name;
        }
        const info = await this.localModelModule.switch(targetName);
        if (!info) {
          return reply.status(500).send({ error: `启动本地模型 ${targetName} 失败` });
        }
        // 更新 provider 配置
        const cfg = RuntimeConfigCenter.getInstance();
        cfg.set('provider.local', { type: 'local', model: info.modelFile ?? targetName, baseUrl: info.baseUrl });
        cfg.set('provider.local.modelKey', targetName);
        cfg.set('provider.active', 'local');
        cfg.save().catch(() => {});
        return reply.send({ ok: true, name: targetName, info });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** 注册模型通道路由 API */
  private registerChannelRoutes(): void {
    if (!this.app) return;

    // 列出通道与角色映射
    this.app.get('/api/channels', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const registry = this.getChannelRegistry();
        const channels = registry.listChannels().map((ch) => {
          const info = registry.getChannelInfo(ch.name);
          return {
            name: ch.name,
            provider: info?.provider ?? ch.provider ?? 'unknown',
            model: info?.model ?? ch.model ?? '',
            description: ch.description ?? '',
            roles: info?.roles ?? Object.entries(registry.listRoles())
              .filter(([, cn]) => cn === ch.name)
              .map(([r]) => r),
          };
        });
        return reply.send({ channels, roleMappings: registry.listRoles() });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 新增/更新通道
    this.app.post('/api/channels', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { name?: string; provider?: string; model?: string; description?: string } | undefined;
      const name = body?.name?.trim();
      if (!name) {
        return reply.status(400).send({ error: 'Channel name is required' });
      }
      try {
        const registry = this.getChannelRegistry();
        registry.upsertChannel(name, {
          provider: body?.provider,
          model: body?.model,
          description: body?.description,
        });
        return reply.send({ ok: true, name });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 删除通道
    this.app.delete('/api/channels/:name', async (req: FastifyRequest, reply: FastifyReply) => {
      const { name } = req.params as { name: string };
      try {
        const registry = this.getChannelRegistry();
        registry.removeChannel(name);
        return reply.send({ ok: true, name });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 设置角色映射
    this.app.post('/api/channels/roles', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as { role?: string; channel?: string } | undefined;
      const role = body?.role?.trim();
      const channel = body?.channel?.trim();
      if (!role || !channel) {
        return reply.status(400).send({ error: 'role and channel are required' });
      }
      try {
        const registry = this.getChannelRegistry();
        registry.setRoleMapping(role, channel);
        return reply.send({ ok: true, role, channel });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 运行时切换通道模型（不持久化）
    this.app.post('/api/channels/:name/model', async (req: FastifyRequest, reply: FastifyReply) => {
      const { name } = req.params as { name: string };
      const body = req.body as { provider?: string; model?: string } | undefined;
      const provider = body?.provider?.trim();
      if (!provider) {
        return reply.status(400).send({ error: 'provider is required' });
      }
      try {
        const registry = this.getChannelRegistry();
        registry.setChannelModel(name, provider, body?.model);
        return reply.send({ ok: true, name, provider, model: body?.model });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 重置通道为持久化配置
    this.app.post('/api/channels/:name/reset', async (req: FastifyRequest, reply: FastifyReply) => {
      const { name } = req.params as { name: string };
      try {
        const registry = this.getChannelRegistry();
        registry.resetChannelModel(name);
        return reply.send({ ok: true, name });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** 注册定时任务 API */
  private registerSchedulerRoutes(): void {
    if (!this.app) return;

    // 调度器状态
    this.app.get('/api/scheduler/status', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.send({ running: false, taskCount: 0, enabledTaskCount: 0 });
        }
        return reply.send(scheduler.getStatus());
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 任务列表
    this.app.get('/api/scheduler/tasks', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.send({ tasks: [] });
        }
        return reply.send({ tasks: scheduler.getTasks() });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 新增任务
    this.app.post('/api/scheduler/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Request body is required' });
      }
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.status(503).send({ error: 'Scheduler is not available' });
        }

        const name = String(body.name ?? '').trim();
        if (!name) {
          return reply.status(400).send({ error: 'Task name is required' });
        }

        // 兼容 TUI /schedule-add <name> <HH:mm>：只传 name + time 时创建每日 scheduled 任务
        if (body.time && !body.scheduleType) {
          const time = String(body.time).trim();
          if (!/^\d{2}:\d{2}$/.test(time)) {
            return reply.status(400).send({ error: 'Time must be in HH:mm format' });
          }
          const task = await scheduler.addTask(
            name,
            'daily',
            { time },
            { type: 'scheduled', target: name, payload: {} },
            [],
          );
          return reply.send({ ok: true, task });
        }

        const scheduleType = String(body.scheduleType ?? '');
        if (!['interval', 'cron', 'daily', 'fixed-time', 'random'].includes(scheduleType)) {
          return reply.status(400).send({ error: 'Invalid scheduleType' });
        }

        const schedule = body.schedule as ScheduleConfig;
        const action = (body.action as TaskAction | undefined) ?? { type: 'scheduled', target: name, payload: {} };
        const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
        const task = await scheduler.addTask(name, scheduleType as ScheduledTask['scheduleType'], schedule, action, tags);
        return reply.send({ ok: true, task });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 删除任务
    this.app.delete('/api/scheduler/tasks/:id', async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.status(503).send({ error: 'Scheduler is not available' });
        }
        const ok = await scheduler.deleteTask(id);
        return reply.send({ ok, id });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 启用/禁用切换
    this.app.post('/api/scheduler/tasks/:id/toggle', async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.status(503).send({ error: 'Scheduler is not available' });
        }
        const task = scheduler.getTask(id);
        if (!task) {
          return reply.status(404).send({ error: 'Task not found' });
        }
        const ok = task.enabled ? await scheduler.disableTask(id) : await scheduler.enableTask(id);
        return reply.send({ ok, id, enabled: !task.enabled });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 执行记录
    this.app.get('/api/scheduler/records', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const scheduler = await this.getScheduler();
        if (!scheduler) {
          return reply.send({ records: [] });
        }
        const records = await scheduler.getRecentRecords(20);
        return reply.send({ records });
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  /** 注册命令面板 API */
  private registerCommandRoutes(): void {
    if (!this.app) return;

    this.app.get('/api/commands', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const registry = CommandRegistry.getInstance(this.cwd);
        const commands = registry.getAll();
        const items = commands.flatMap((cmd) => this.flattenCommand(cmd));
        return reply.send(items);
      } catch (err) {
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  private flattenCommand(cmd: SlashCommandDef, prefix = ''): Array<{ id: string; label: string; description: string; category?: string }> {
    const fullName = prefix ? `${prefix}/${cmd.name}` : cmd.name;
    const item: { id: string; label: string; description: string; category?: string } = {
      id: fullName,
      label: fullName,
      description: cmd.description,
      category: cmd.category,
    };
    const children = cmd.children?.flatMap((c) => this.flattenCommand(c, fullName)) ?? [];
    return [item, ...children];
  }

  /** 获取调度器（通过 ensureComponents 复用 factory 创建的实例） */
  private async getScheduler(): Promise<HeartbeatScheduler | null> {
    const components = await this.ensureComponents();
    return components.scheduler ?? null;
  }

  /** 获取模型通道路由注册表（懒加载） */
  private getChannelRegistry(): ModelChannelRegistry {
    if (!this.channelRegistry) {
      this.channelRegistry = new ModelChannelRegistry(this.cwd);
      this.channelRegistry.load();
    }
    return this.channelRegistry;
  }

  /** 构建模型中心状态 */
  private async buildModelStatus(): Promise<Record<string, unknown>> {
    const providerType = this.provider.getProviderType();
    const modelName = this.provider.getModel();

    const onlineProviders = [
      { name: 'Anthropic', type: 'anthropic', description: 'Claude Opus 4, Sonnet 4', status: 'available' as const },
      { name: 'OpenAI', type: 'openai', description: 'GPT-4o, GPT-4.1', status: 'available' as const },
      { name: 'DeepSeek', type: 'deepseek', description: 'DeepSeek V4', status: 'available' as const },
      { name: 'Gemini', type: 'gemini', description: 'Gemini 2.5 Pro', status: 'available' as const },
      { name: 'Groq', type: 'groq', description: 'Llama 4, Mixtral', status: 'available' as const },
      { name: 'xAI', type: 'xai', description: 'Grok 3', status: 'available' as const },
      { name: 'Mistral', type: 'mistral', description: 'Mistral Large 2', status: 'available' as const },
      { name: 'OpenRouter', type: 'openrouter', description: 'Multi-provider routing', status: 'available' as const },
      { name: 'Moonshot', type: 'moonshot', description: 'Moonshot (Kimi)', status: 'available' as const },
      { name: 'Qwen', type: 'qwen', description: 'Qwen (阿里百炼)', status: 'available' as const },
      { name: 'Zhipu', type: 'zhipu', description: 'Zhipu (智谱)', status: 'available' as const },
      { name: 'MiniMax', type: 'minimax', description: 'MiniMax', status: 'available' as const },
      { name: 'MiMo', type: 'mimo', description: 'MiMo (小米)', status: 'available' as const },
    ];

    // 本地模型状态
    const detected = await detectLocalBackend();
    const registeredModels = this.localModelModule.list();
    const runningModels = this.localModelModule.getBridge().getAllStatus();
    const localModel = {
      detected: !!(detected || this.localModelModule.checkOllama() || this.localModelModule.checkLlamacpp()),
      backend: detected?.backend ?? (this.localModelModule.checkOllama() ? 'ollama' : this.localModelModule.checkLlamacpp() ? 'llamacpp' : null),
      running: runningModels.some((s) => s.state === 'running'),
      registeredModels: registeredModels.map((m) => m.name),
      note: '本地模型服务状态',
    };

    // Thinking 配置
    const configCenter = RuntimeConfigCenter.getInstance();
    let thinkingConfig: Record<string, unknown> = {};
    try {
      thinkingConfig = (configCenter.get('provider') as Record<string, unknown>) ?? {};
    } catch {
      // configCenter 可能尚未初始化
    }
    const thinking = {
      enableThinking: thinkingConfig['enableThinking'] ?? false,
      thinkingEffort: thinkingConfig['thinkingEffort'] ?? null,
      showThinking: thinkingConfig['showThinking'] ?? false,
      note: '',
    };

    // 模型通道路由
    const registry = this.getChannelRegistry();
    const channels = registry.listChannels().map((ch) => {
      const info = registry.getChannelInfo(ch.name);
      return {
        name: ch.name,
        provider: info?.provider ?? ch.provider ?? 'unknown',
        model: info?.model ?? ch.model ?? '',
        description: ch.description ?? '',
        roles: info?.roles ?? Object.entries(registry.listRoles())
          .filter(([, cn]) => cn === ch.name)
          .map(([r]) => r),
      };
    });

    return {
      provider: providerType,
      model: modelName,
      routing: {
        mode: 'auto',
        isLocal: providerType === 'local',
      },
      onlineProviders,
      localModel,
      thinking,
      channels,
      roleMappings: registry.listRoles(),
      note: '模型中心实时状态',
    };
  }

  /** 确保 AgentComponents 已创建（懒加载） */
  private async ensureComponents(): Promise<AgentComponents> {
    if (!this.activeComponents) {
      const { createAgent } = await import('../../gateway/factory.js');

      // 创建一个轻量的 output handler（不需要完整 OutputHandler）
      const dummyHandler = {
        onText: () => {},
        onThinking: () => {},
        onToolUse: () => {},
        onToolResult: () => {},
        onStatus: () => {},
        onTurnStart: () => {},
        onFlush: () => {},
        onInterrupt: () => {},
      } as OutputHandler;

      this.activeComponents = await createAgent({
        cwd: this.cwd,
        provider: this.provider,
        maxTurns: this.maxTurns,
        maxContext: this.maxContext,
        outputHandler: dummyHandler,
        personaDir: this.personaDir,
      });

      // 覆盖 ensureComponents 调度器的执行处理器：
      // command 类型直接执行 shell；scheduled 类型优先转发给活跃的 WebSocket session，否则回退到当前 loop。
      this.activeComponents.scheduler.setHandler(async (task) => {
        if (task.action.type === 'command') {
          const { exec } = await import('node:child_process');
          exec(task.action.target, { timeout: 30000 }, (err, stdout, stderr) => {
            if (err) logger.error(`Scheduled command failed: ${task.name}`, err, { stderr: stderr.trim() });
            else logger.info(`Scheduled command OK: ${task.name}`, { stdout: stdout.trim() });
          });
          return;
        }

        for (const session of this.sessions.values()) {
          try {
            await session.notifyTask(task.name);
            return;
          } catch {
            // session 未初始化，尝试下一个
          }
        }

        // 没有可用 WebSocket session，回退到当前 loop
        await this.activeComponents!.loop.notifyTaskFired(task.name);
      });
    }
    return this.activeComponents;
  }

  /** 加载最近的历史事件 */
  private async loadRecentEvents(
    sessionDir: string,
    limit: number,
  ): Promise<unknown[]> {
    try {
      const { readRecentEvents } = await import('../../event-store.js');
      return await readRecentEvents(sessionDir, limit);
    } catch {
      return [];
    }
  }

  /** Fallback HTML（dist 目录不存在时显示） */
  private getFallbackHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepThink WebUI</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0d1117; color: #c9d1d9; }
    .container { text-align: center; max-width: 500px; padding: 2rem; }
    h1 { color: #58a6ff; font-size: 1.8rem; margin-bottom: 1rem; }
    code { background: #21262d; padding: 0.2em 0.5em; border-radius: 4px; font-size: 0.9em; }
    .hint { color: #8b949e; margin-top: 2rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>DeepThink WebUI</h1>
    <p>The WebUI frontend is not built yet.</p>
    <p>Run the frontend build step to generate the static files:</p>
    <p><code>cd webui && npm run build</code></p>
    <p class="hint">The WebSocket server is running — you can connect at <code>/ws</code></p>
  </div>
</body>
</html>`;
  }
}
