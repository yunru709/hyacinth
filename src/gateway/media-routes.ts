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
  app.get('/api/media/:id/file', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    let store: MediaStore | null = null;
    try {
      store = new MediaStore();
      const rec = store.get(id);
      if (!rec) return reply.status(404).send({ error: 'media not found' });
      const abs = store.resolvePath(rec);
      if (!fs.existsSync(abs)) return reply.status(404).send({ error: 'media file missing' });
      return reply.type(mimeForType(rec.type)).send(fs.readFileSync(abs));
    } catch (err) {
      logger.error('media file failed', err instanceof Error ? err : new Error(String(err)));
      return reply.status(500).send({ error: `media file failed: ${(err as Error).message}` });
    } finally {
      try {
        store?.close();
      } catch {
        /* ignore */
      }
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
  app.get('/api/companion/:character/scene.png', async (req: FastifyRequest, reply: FastifyReply) => {
    const { character } = req.params as { character: string };
    try {
      assertSafeCharacter(character);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
    const sceneDir = getSceneDir(character);
    const imgPath = path.join(sceneDir, 'scene.png');
    if (!fs.existsSync(imgPath)) {
      return reply.status(404).send({ error: 'no scene image yet', character });
    }
    return reply.type('image/png').send(fs.readFileSync(imgPath));
  });
}

/** 供 authHook 判断豁免的只读端点前缀（media/companion 为 WebUI 只读展示） */
export function isPublicReadRoute(url: string): boolean {
  return (
    url === '/api/health' ||
    url.startsWith('/api/media') ||
    url.startsWith('/api/companion/')
  );
}
