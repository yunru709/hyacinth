// ============================================================
// media-routes 冒烟测试（真实 Fastify + 真实 MediaStore SQLite）
// ============================================================
// 覆盖 /api/media/:id/file 与 /api/companion/:character/scene*
// 的关键行为：
//   1. 媒体列表 + 文件字节端点 200（字节、Content-Type、ETag）
//   2. If-None-Match 命中 → 304（协商缓存，浏览器重复浏览不再重下）
//   3. 未知 id / 缺文件 → 404
//   4. 场景元数据 + 场景图（同样支持 304）
//   5. 角色名路径穿越 → 400
//
// ★ 隔离：os.homedir 指向一次性临时目录（MediaStore 的
//   ~/.agent/media 与场景的 ~/.agent/companion 都基于 homedir），
//   不读写测试机真实媒体库。
// ============================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fastify from 'fastify';
import { registerMediaRoutes } from './media-routes.js';
import { recordMediaFile } from '../media/media-store.js';

const hoisted = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const pathMod = await import('node:path');
  const home = pathMod.join(
    actual.tmpdir(), `hyacinth-media-routes-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  hoisted.home = home;
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home } as typeof actual;
});

// 1×1 透明 PNG（最小合法图片字节）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let mediaId = '';

beforeAll(async () => {
  // ── 种子数据（全部落在临时 home）──
  const srcFile = path.join(hoisted.home, 'seed.png');
  fs.mkdirSync(hoisted.home, { recursive: true });
  fs.writeFileSync(srcFile, PNG_BYTES);
  const rec = recordMediaFile(srcFile, {
    type: 'image',
    source: 'scene',
    character: '小蝶',
    prompt: 'test seed',
  });
  if (!rec) throw new Error('seed media record failed');
  mediaId = rec.id;

  const sceneDir = path.join(hoisted.home, '.agent', 'companion', '小蝶');
  fs.mkdirSync(sceneDir, { recursive: true });
  fs.writeFileSync(path.join(sceneDir, 'scene.png'), PNG_BYTES);
  fs.writeFileSync(path.join(sceneDir, 'scene.json'), JSON.stringify({ desc: '测试场景' }), 'utf-8');
});

afterAll(() => {
  // 临时目录留给系统 tmp 清理（避免 safe-delete shim 在测试内 rmSync 出问题）
});

function makeApp() {
  const app = fastify({ logger: false });
  registerMediaRoutes(app, hoisted.home);
  return app;
}

describe('media-routes 冒烟', () => {
  it('GET /api/media 列表含 fileUrl，GET /api/media/:id/file 返回正确字节 + ETag', async () => {
    const app = makeApp();
    try {
      const list = await app.inject({ method: 'GET', url: '/api/media' });
      expect(list.statusCode).toBe(200);
      const body = JSON.parse(list.body) as { items: Array<{ id: string; fileUrl: string }> };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0]!.fileUrl).toBe(`/api/media/${body.items[0]!.id}/file`);

      const file = await app.inject({ method: 'GET', url: `/api/media/${mediaId}/file` });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toContain('image/png');
      expect(file.headers.etag).toBeTruthy();
      expect(file.headers['cache-control']).toContain('max-age');
      expect(file.rawPayload).toEqual(PNG_BYTES);
    } finally {
      await app.close();
    }
  });

  it('If-None-Match 命中 ETag → 304（媒体文件与场景图均生效）', async () => {
    const app = makeApp();
    try {
      const first = await app.inject({ method: 'GET', url: `/api/media/${mediaId}/file` });
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();

      const second = await app.inject({
        method: 'GET', url: `/api/media/${mediaId}/file`, headers: { 'if-none-match': etag },
      });
      expect(second.statusCode).toBe(304);
      expect(second.body).toBe('');

      const sceneFirst = await app.inject({ method: 'GET', url: '/api/companion/小蝶/scene.png' });
      expect(sceneFirst.statusCode).toBe(200);
      const sceneSecond = await app.inject({
        method: 'GET', url: '/api/companion/小蝶/scene.png',
        headers: { 'if-none-match': sceneFirst.headers.etag as string },
      });
      expect(sceneSecond.statusCode).toBe(304);
    } finally {
      await app.close();
    }
  });

  it('未知 id → 404；场景元数据 200 且带 imageUrl；路径穿越 → 400', async () => {
    const app = makeApp();
    try {
      const missing = await app.inject({ method: 'GET', url: '/api/media/img_999/file' });
      expect(missing.statusCode).toBe(404);

      const scene = await app.inject({ method: 'GET', url: '/api/companion/小蝶/scene' });
      expect(scene.statusCode).toBe(200);
      const sceneBody = JSON.parse(scene.body) as { character: string; imageUrl: string };
      expect(sceneBody.character).toBe('小蝶');
      expect(sceneBody.imageUrl).toContain('scene.png');

      const evil = await app.inject({ method: 'GET', url: '/api/companion/..%2F..%2Fetc/scene.png' });
      expect(evil.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
