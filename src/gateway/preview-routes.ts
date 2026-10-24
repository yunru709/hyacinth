/**
 * preview-routes — 文件预览的 HTTP 传输面（供 WebUI 右侧「预览」栏）
 *
 * ⚠️ 2026-10-24 起本文件只是**薄传输层**：全部 fs 逻辑（路径校验 / 列目录 /
 * 读文本 / 换根 / 目录选择器）搬进了 preview-service.ts，与 ui-protocol 的
 * preview.* 契约域共享同一实例与同一套 fail-closed 校验（安全只有一份实现）。
 * 数据（JSON）面走 WS 契约域；这里保留 HTTP 是因为字节流必须走 HTTP ——
 * <img>/<iframe>/<a download> 由浏览器直接加载，塞不进 JSON RPC。契约域通过
 * read 结果的 url 字段 / preview.rawUrl 签发本组端点的地址（前端不再硬编码）。
 *
 * 端点：
 *   GET  /api/fs/meta              → 当前根路径 / 名称 / 各项上限
 *   GET  /api/fs/list?path=&all=1  → 某个目录的一级条目
 *   GET  /api/fs/read?path=        → 文本文件内容（UTF-8，超长截断）
 *   GET  /api/fs/raw?path=         → 原始字节（图片 / PDF / HTML / 其它二进制）
 *   GET  /api/fs/browse?dir=       → 目录选择器用：列**子目录**（只回环可达）
 *   POST /api/fs/root              → 切换预览根目录（只回环可达）
 *
 * 认证策略（与 /api/media **相反**）：
 *   媒体端点豁免钥匙，是因为 <img src> 没法带 Authorization 头；
 *   本组端点是 fetch 调用的，能带。而它能读到根目录里**任何**文件——源码、
 *   配置、可能含密钥的 .env——没有理由放宽，因此不进 isPublicReadRoute。
 *   唯一例外：raw 被 <img>/<iframe> 加载时无法带头，authHook 对它特批
 *   `?token=`（地址由契约域签发，token 由服务端嵌入）。
 *
 * 只读是本模块的硬边界：没有写、没有删、没有移动。要改文件走 agent 的工具
 * （带审批），不要在这里开口子。
 */

import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '../logging/logger.js';
import {
  createPreviewService,
  isLoopbackRemoteAddress,
  PreviewError,
  // 以下仅为兼容既有 import 路径的 re-export（真源在 preview-service）
  MAX_TEXT_BYTES,
  MAX_RAW_BYTES,
  MAX_LIST_ENTRIES,
  resolveInside,
  classifyFile,
  type PreviewService,
} from './preview-service.js';

const logger = createLogger('preview-routes');

export { MAX_TEXT_BYTES, MAX_RAW_BYTES, MAX_LIST_ENTRIES, resolveInside, classifyFile, PreviewError };
export type { PreviewService };

/** 统一错误出口：PreviewError 带状态码，其它是意外错误一律 500 并记日志 */
function fail(reply: FastifyReply, err: unknown, where: string) {
  if (err instanceof PreviewError) {
    return reply.status(err.status).send({ error: err.message });
  }
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(`fs ${where} failed: ${e.message}`);
  return reply.status(500).send({ error: `${where} failed: ${e.message}` });
}

/**
 * 注册文件预览路由。
 * @param app Fastify 实例（由 http-webhook 传入）
 * @param svc 预览服务（与 preview.* 契约域共享同一实例；测试用 createPreviewService 自建）
 */
export function registerPreviewRoutes(app: FastifyInstance, svc: PreviewService): void {
  const isLoopbackRequest = (req: FastifyRequest): boolean =>
    isLoopbackRemoteAddress(req.socket?.remoteAddress);

  // ── GET /api/fs/meta ────────────────────────────────────────────
  app.get('/api/fs/meta', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send(svc.meta());
  });

  // ── GET /api/fs/list ────────────────────────────────────────────
  app.get('/api/fs/list', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    const showAll = q.all === '1' || q.all === 'true';
    try {
      return reply.send(await svc.list(q.path, showAll));
    } catch (err) {
      return fail(reply, err, 'list');
    }
  });

  // ── GET /api/fs/read ────────────────────────────────────────────
  app.get('/api/fs/read', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      return reply.send(await svc.read(q.path));
    } catch (err) {
      return fail(reply, err, 'read');
    }
  });

  // ── GET /api/fs/raw ─────────────────────────────────────────────
  app.get('/api/fs/raw', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string | undefined>;
    try {
      const info = await svc.rawInfo(q.path);
      reply.type(info.mime);
      reply.header('Cache-Control', 'private, max-age=60');
      // inline：图片/PDF 要在页面里显示，不能触发下载
      reply.header('Content-Disposition', 'inline');

      // SVG 是**可执行**内容：同源内联渲染时里面的 <script> 会跑，等于给工作区
      // 里任意 svg 一个 XSS 通道 ✗。CSP 收紧到 default-src 'none'，脚本不执行，
      // 样式仍允许内联（否则图形丢色）。
      if (info.rel.toLowerCase().endsWith('.svg')) {
        reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      }

      const stream = fs.createReadStream(info.abs);
      return reply.send(stream);
    } catch (err) {
      return fail(reply, err, 'raw');
    }
  });

  // ── GET /api/fs/browse ─────────────────────────────────────────
  // 目录选择器专用（接受绝对路径，意义就是走到当前根之外去挑新根）：
  // 只回目录名、不回文件内容，且只限本机。
  app.get('/api/fs/browse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackRequest(req)) {
      return reply.status(403).send({ error: '选择目录只允许在本机操作' });
    }
    const q = req.query as Record<string, string | undefined>;
    try {
      return reply.send(await svc.browse(q.dir));
    } catch (err) {
      return fail(reply, err, 'browse');
    }
  });

  // ── POST /api/fs/root ──────────────────────────────────────────
  // 换根：只改"预览看哪儿"，不动 agent 的工作目录，也不动工具围栏。只限本机。
  app.post('/api/fs/root', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackRequest(req)) {
      return reply.status(403).send({ error: '切换根目录只允许在本机操作' });
    }
    const body = (req.body ?? {}) as { root?: unknown };
    try {
      return reply.send(await svc.setRoot(typeof body.root === 'string' ? body.root : undefined));
    } catch (err) {
      return fail(reply, err, 'root');
    }
  });
}

// createPreviewService 一并再导出：装配侧（http-webhook）只需 import 本模块
export { createPreviewService };
