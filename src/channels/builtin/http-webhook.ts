// ============================================================
// HttpWebhookChannel — 内建 HTTP REST API 渠道（企业加固版）
// ============================================================
//
// 端点：/api/health, /api/chat, /api/sessions, /api/tools, /api/skills
// 认证：Bearer Token（DEEPTHINK_API_KEY 环境变量或 --api-key 参数）
// Chat 为同步 request-response 模式。
// ============================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type {
  ChannelHandler,
  ChannelEvent,
  ChannelReply,
  ChannelConfig,
  ChannelStatus,
} from '../interface.js';
import type { Provider } from '../../provider/interface.js';
import type { SessionManager } from '../../memory/session.js';
import type { OutputHandler } from '../../orchestrator/loop.js';
import type { AgentComponents } from '../../gateway/factory.js';
import { createLogger } from '../../logging/logger.js';
import { getModelContextWindow } from '../../setup/model-defaults.js';
import { getDefaultConfig } from '../../runtime/defaults.js';

const logger = createLogger('http-webhook');

// ── 认证 ────────────────────────────────────────────────────────────

function getApiKey(config: ChannelConfig): string | null {
  return (config.apiKey as string)
    || process.env.DEEPTHINK_API_KEY
    || process.env.AGENT_API_KEY
    || null;
}

function authHook(apiKey: string | null) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // /api/health 无需认证
    if (req.url === '/api/health') return;

    if (!apiKey) {
      return reply.status(401).send({
        error: 'API key not configured. Set DEEPTHINK_API_KEY environment variable or pass --api-key.',
      });
    }

    const auth = req.headers['authorization'] ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer !== apiKey) {
      return reply.status(401).send({ error: 'Invalid or missing API key. Use Authorization: Bearer <key>' });
    }
  };
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
    void toolName; void input;
    return Promise.resolve(true) as unknown as Promise<'yes' | 'no' | 'always'>;
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

  private app: FastifyInstance | null = null;
  private status: ChannelStatus = 'registered';
  private eventHandler: ((event: ChannelEvent) => Promise<void>) | null = null;
  private provider!: Provider;
  private sessionManager!: SessionManager;
  private cwd!: string;
  private maxTurns!: number;
  private maxContext!: number;
  private activeComponents: AgentComponents | null = null;

  async start(config: ChannelConfig): Promise<void> {
    const { port = 3000, host = '0.0.0.0' } = config;

    this.provider = config.provider as Provider;
    this.sessionManager = config.sessionManager as SessionManager;
    this.cwd = config.cwd as string;
    this.maxTurns = config.maxTurns as number ?? getDefaultConfig().session.maxTurns;
    this.maxContext = config.maxContext as number ?? getModelContextWindow(this.provider.getProviderType(), this.provider.getModel());

    const apiKey = getApiKey(config);
    if (!apiKey) {
      logger.warn('No DEEPTHINK_API_KEY set — HTTP API will reject all requests except /api/health. Set the environment variable or use --api-key.');
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
      const session = await this.sessionManager.create();
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

    // ── Start ───────────────────────────────────────────────────
    await this.app.listen({ port: port as number, host: host as string });
    this.status = 'active';
    logger.info(`HTTP API listening on ${host}:${port}${apiKey ? ' (auth enabled)' : ' (auth: only /api/health)'}`);
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
}
