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
  private activeComponents: AgentComponents | null = null;

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
      if (request.url === '/ws' && this.wss) {
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

    this.wss.on('connection', (ws: import('./webui-ws-session.js').WsLike) => {
      const sessionId = this.generateSessionId();
      const session = new WebUIWsSession(ws, sessionId);

      session.onClose((sid) => {
        this.sessions.delete(sid);
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
    this.app.post('/api/sessions', async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const session = await this.sessionManager.create('normal', 'webui');
        return reply.send({ id: session.id, createdAt: session.createdAt });
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
          return reply.send({ id: session.id, createdAt: session.createdAt });
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
  }

  /** 注册配置 API */
  private registerConfigRoutes(): void {
    if (!this.app) return;

    this.app.get('/api/config', async (_req: FastifyRequest, reply: FastifyReply) => {
      // 返回脱敏后的配置
      return reply.send({
        cwd: this.cwd,
        maxTurns: this.maxTurns,
        maxContext: this.maxContext,
      });
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
