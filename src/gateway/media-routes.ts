/**
 * media-routes — 媒体库 / 场景查询 HTTP 路由（供 WebUI 读取）
 *
 * 端点：
 *   GET /api/media                            → 媒体列表（可选 ?type=&source=&character=&limit=）
 *   GET /api/media/:id/file                   → 媒体文件字节（Content-Type 按类型）
 *   GET /api/companion/:character/scene       → 场景元数据（scene.json 内容）
 *   GET /api/companion/:character/scene.png   → 场景图字节（scene.png）
 *
 * 认证策略：媒体/场景为只读 GET 且 WebUI 浏览器无法方便携带 Bearer token，
 * 挂载方（http-webhook authHook）应豁免这些只读端点（同 /api/health）。
 *
 * 安全：角色名路径穿越防护（防 ../../ 逃逸到任意目录）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MediaStore } from '../media/index.js';
import type { MediaType, MediaSource } from '../media/index.js';
import { getSceneDir } from '../generation/index.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('media-routes');

/** 角色名路径穿越防护（与 scene-render 一致的规则） */
function assertSafeCharacter(name: string): void {
  if (!name || !name.trim()) throw new Error('character 不能为空');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('character 含非法路径字符');
  }
}

/** 音频魔数嗅探（本地 TTS 服务器常直接回 WAV，写死 mp3 会标错） */
function sniffAudioMime(buf: Buffer): string {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  return 'audio/mpeg';
}

/** MIME 类型（按媒体库分类） */
function mimeForType(type: MediaType): string {
  switch (type) {
    case 'image':
      return 'image/png';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/mpeg';
  }
}

// ── id→文件路径解析缓存 ────────────────────────────────────────────
// 避免每个文件请求都开关一次 SQLite（MediaStore 构造即 open）。
// 媒体记录一经写入不可变（id→relPath 稳定），TTL 只作变更兜底。
const RESOLVE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX = 256;
interface ResolvedMedia {
  abs: string;
  type: MediaType;
}
const resolveCache = new Map<string, ResolvedMedia & { cachedAt: number }>();

function resolveCacheGet(id: string): ResolvedMedia | null {
  const entry = resolveCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RESOLVE_TTL_MS) {
    resolveCache.delete(id);
    return null;
  }
  return entry;
}

function resolveCacheSet(id: string, abs: string, type: MediaType): void {
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = resolveCache.keys().next().value;
    if (oldest !== undefined) resolveCache.delete(oldest);
  }
  resolveCache.set(id, { abs, type, cachedAt: Date.now() });
}

/**
 * 条件请求协商：请求带 If-None-Match 且与当前 ETag 一致时为真。
 */
function ifNoneMatch(req: FastifyRequest, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  return Boolean(inm) && inm === etag;
}

/**
 * 注册媒体/场景查询路由。
 * @param app  Fastify 实例（由 http-webhook 传入）
 * @param cwd  工作目录（与渠道一致；媒体库默认读全局 ~/.agent/media）
 */
export function registerMediaRoutes(app: FastifyInstance, cwd: string): void {
  void cwd;

  // ── GET /api/media 列表 ─────────────────────────────────────────
  app.get('/api/media', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string | undefined>;
    let store: MediaStore | null = null;
    try {
      store = new MediaStore();
      const items = store.list({
        type: (query.type as MediaType | undefined),
        source: (query.source as MediaSource | undefined),
        character: query.character,
        limit: query.limit ? Number(query.limit) : undefined,
      });
      // 返回记录 + 可访问的文件 URL（不含字节，前端按需拉取）
      return reply.send({
        items: items.map((r) => ({
          ...r,
          fileUrl: `/api/media/${r.id}/file`,
        })),
      });
    } catch (err) {
      logger.error('media list failed', err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `media list failed: ${(err as Error).message}` });
    } finally {
      try {
        store?.close();
      } catch {
        /* ignore */
      }
    }
  });

  // ── GET /api/media/:id/file 文件字节 ────────────────────────────
  // 性能：id→路径缓存免每请求开关 SQLite；ETag/304 协商缓存让浏览器
  // 重复浏览（轮播/刷新）不再重复下载；流式发送避免整图进内存。
  app.get('/api/media/:id/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      let resolved = resolveCacheGet(id);
      if (!resolved) {
        let store: MediaStore | null = null;
        try {
          store = new MediaStore();
          const rec = store.get(id);
          if (!rec) return reply.status(404).send({ error: 'media not found' });
          resolved = { abs: store.resolvePath(rec), type: rec.type };
        } finally {
          try {
            store?.close();
          } catch {
            /* ignore */
          }
        }
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.abs);
      } catch {
        resolveCache.delete(id);
        return reply.status(404).send({ error: 'media file missing' });
      }

      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      reply.header('etag', etag);
      reply.header('last-modified', stat.mtime.toUTCString());
      reply.header('cache-control', 'public, max-age=86400');
      if (ifNoneMatch(req, etag)) return reply.status(304).send();

      resolveCacheSet(id, resolved.abs, resolved.type);
      const mime =
        resolved.type === 'audio'
          ? (await new Promise<string>((resolve) => {
              const chunks: Buffer[] = [];
              const stream = fs.createReadStream(resolved.abs, { start: 0, end: 11 });
              stream.on('data', (c: Buffer) => chunks.push(c));
              stream.on('end', () => resolve(sniffAudioMime(Buffer.concat(chunks))));
              stream.on('error', () => resolve(sniffAudioMime(Buffer.alloc(0))));
            }))
          : mimeForType(resolved.type);
      reply.type(mime).header('content-length', stat.size);
      return reply.send(fs.createReadStream(resolved.abs));
    } catch (err) {
      logger.error('media file failed', err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `media file failed: ${(err as Error).message}` });
    }
  });

  // ── GET /api/companion/:character/scene 场景元数据 ──────────────
  app.get('/api/companion/:character/scene', async (req: FastifyRequest, reply: FastifyReply) => {
    const { character } = req.params as { character: string };
    try {
      assertSafeCharacter(character);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const sceneDir = getSceneDir(character);
    const metaPath = path.join(sceneDir, 'scene.json');
    const imgPath = path.join(sceneDir, 'scene.png');
    if (!fs.existsSync(metaPath) || !fs.existsSync(imgPath)) {
      return reply.status(404).send({ error: 'no scene rendered yet', character });
    }
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return reply.send({
        character,
        meta,
        imageUrl: `/api/companion/${encodeURIComponent(character)}/scene.png`,
      });
    } catch (err) {
      logger.error('scene read failed', err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `scene read failed: ${(err as Error).message}` });
    }
  });

  // ── GET /api/companion/:character/scene.png 场景图字节 ──────────
  // 同 /api/media/:id/file：ETag/304 + 流式（场景图会重渲染，mtime 变化自动失效缓存）
  app.get('/api/companion/:character/scene.png', async (req: FastifyRequest, reply: FastifyReply) => {
    const { character } = req.params as { character: string };
    try {
      assertSafeCharacter(character);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const sceneDir = getSceneDir(character);
    const imgPath = path.join(sceneDir, 'scene.png');
    try {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(imgPath);
      } catch {
        return reply.status(404).send({ error: 'no scene image yet', character });
      }

      const etag = `"${stat.size}-${stat.mtimeMs}"`;
      reply.header('etag', etag);
      reply.header('last-modified', stat.mtime.toUTCString());
      reply.header('cache-control', 'public, max-age=86400');
      if (ifNoneMatch(req, etag)) return reply.status(304).send();

      reply.type('image/png').header('content-length', stat.size);
      return reply.send(fs.createReadStream(imgPath));
    } catch (err) {
      logger.error('scene image failed', err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `scene image failed: ${(err as Error).message}` });
    }
  });
}

/** 供 authHook 判断豁免的只读端点前缀（media/companion 为 WebUI 只读展示） */
export function isPublicReadRoute(url: string): boolean {
  const path = url.split('?')[0];
  return (
    path === '/api/health' ||
    path.startsWith('/api/media') ||
    path.startsWith('/api/companion/')
  );
}
