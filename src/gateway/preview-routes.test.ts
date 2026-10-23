// ============================================================
// preview-routes 测试（真实 Fastify + 真实临时工作区）
// ============================================================
// 重点不是"能列出文件"，而是**不能列出工作区外的文件**：
//   1. meta / list / read / raw 基本行为
//   2. ../ 越界 → 403；绝对路径 → 400
//   3. 符号链接指向工作区外 → 403（只看 resolve 后的字符串会被骗过去）
//   4. .git 永不列出；node_modules 默认隐藏、?all=1 可显示
//   5. 超长文本截断；二进制识别；超大文件 raw → 413
//   6. SVG 下发带 CSP（同源内联的 svg 能执行脚本，是个 XSS 通道）
//
// ★ 隔离：整个工作区是一次性临时目录，结束后删除。
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerPreviewRoutes, MAX_TEXT_BYTES, MAX_RAW_BYTES } from './preview-routes.js';

let root: string;
let app: FastifyInstance;
/** 工作区外的目录（用于验证越界被拒） */
let outside: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-preview-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), '工作区外的秘密', 'utf-8');

  fs.writeFileSync(path.join(root, 'a.txt'), '你好，工作区', 'utf-8');
  fs.writeFileSync(path.join(root, 'README.md'), '# 标题\n\n正文', 'utf-8');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf-8');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]', 'utf-8');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'module.exports = 1;\n', 'utf-8');
  // 含 NUL ⇒ 二进制
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

  app = fastify({ logger: false });
  registerPreviewRoutes(app, root);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  for (const d of [root, outside]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('GET /api/fs/meta', () => {
  it('返回工作区根与各项上限', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/meta' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.exists).toBe(true);
    expect(j.name).toBe(path.basename(root));
    expect(j.maxTextBytes).toBe(MAX_TEXT_BYTES);
  });
});

describe('GET /api/fs/list', () => {
  it('列出根目录，目录排在前', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/list' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    const names = j.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('src');
    // 目录在前：src 必须排在 a.txt 之前
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('a.txt'));
    expect(j.entries.find((e: { name: string }) => e.name === 'src').type).toBe('dir');
  });

  it('默认隐藏 .git 与 node_modules；?all=1 时 node_modules 出现但 .git 仍不出现', async () => {
    const plain = await app.inject({ method: 'GET', url: '/api/fs/list' });
    const names = plain.json().entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');

    const all = await app.inject({ method: 'GET', url: '/api/fs/list?all=1' });
    const names2 = all.json().entries.map((e: { name: string }) => e.name);
    expect(names2).toContain('node_modules');
    // .git 是硬排除，?all=1 也不放行
    expect(names2).not.toContain('.git');
  });

  it('子目录与不存在/非目录输入的分支', async () => {
    const sub = await app.inject({ method: 'GET', url: '/api/fs/list?path=src' });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().entries.map((e: { name: string }) => e.name)).toEqual(['index.ts']);

    const missing = await app.inject({ method: 'GET', url: '/api/fs/list?path=nope' });
    expect(missing.statusCode).toBe(404);

    const file = await app.inject({ method: 'GET', url: '/api/fs/list?path=a.txt' });
    expect(file.statusCode).toBe(400);
  });
});

describe('路径安全（fail-closed）', () => {
  it('../ 越界 → 403', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/read?path=${encodeURIComponent('../outside-x/secret.txt')}` });
    expect(res.statusCode).toBe(403);
  });

  it('多级 ../ 拼回工作区内后仍能读（说明不是无脑拒绝 ..）', async () => {
    // src/../a.txt 归一化后仍是工作区内的 a.txt ⇒ 应当允许
    const res = await app.inject({ method: 'GET', url: `/api/fs/read?path=${encodeURIComponent('src/../a.txt')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('你好，工作区');
  });

  it('绝对路径 → 400（Windows 上 path.resolve 会整体丢弃根，必须显式挡）', async () => {
    const abs = path.join(outside, 'secret.txt');
    const res = await app.inject({ method: 'GET', url: `/api/fs/read?path=${encodeURIComponent(abs)}` });
    expect(res.statusCode).toBe(400);
  });

  it('符号链接指向工作区外 → 403', async () => {
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), link, 'file');
    } catch {
      // 无权限建符号链接（常见于未提权的 Windows）：跳过而不是假装通过
      return;
    }
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=escape' });
    expect(res.statusCode).toBe(403);
    fs.unlinkSync(link);
  });

  it('不存在的文件 → 404（与 403 区分开，前端才知道该提示什么）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=src/nope.ts' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/fs/read', () => {
  it('文本文件：返回内容 + 语言 + 大小', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=src/index.ts' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.content).toBe('export const x = 1;\n');
    expect(j.lang).toBe('typescript');
    expect(j.binary).toBe(false);
    expect(j.truncated).toBe(false);
  });

  it('Markdown 被标成 markdown，交给前端渲染', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=README.md' });
    const j = res.json();
    expect(j.kind).toBe('markdown');
    expect(j.content).toContain('# 标题');
  });

  it('二进制：不下发内容，只给信号让前端改走 raw', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=blob.bin' });
    const j = res.json();
    expect(j.binary).toBe(true);
    expect(j.content).toBe('');
  });

  it('超长文本：截断并标记，不把几百 KB 全塞进响应体', async () => {
    const big = path.join(root, 'big.txt');
    const line = 'x'.repeat(1024) + '\n';
    const fh = fs.openSync(big, 'w');
    try {
      for (let i = 0; i < (MAX_TEXT_BYTES / 1024) + 200; i++) fs.writeSync(fh, line);
    } finally {
      fs.closeSync(fh);
    }
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=big.txt' });
    const j = res.json();
    expect(j.truncated).toBe(true);
    expect(Buffer.byteLength(j.content, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(j.size).toBeGreaterThan(MAX_TEXT_BYTES);
    fs.unlinkSync(big);
  });

  it('目录 → 400（读目录请用 list）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=src' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/fs/raw', () => {
  it('下发原始字节 + 正确 Content-Type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/raw?path=blob.bin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.rawPayload.length).toBe(5);
  });

  it('SVG 带 CSP：内联 svg 能跑脚本，是个 XSS 通道', async () => {
    fs.writeFileSync(path.join(root, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf-8');
    const res = await app.inject({ method: 'GET', url: '/api/fs/raw?path=x.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(String(res.headers['content-security-policy'] || '')).toContain("default-src 'none'");
    fs.unlinkSync(path.join(root, 'x.svg'));
  });

  it('超过上限 → 413（用稀疏文件，不真写 20MB）', async () => {
    const huge = path.join(root, 'huge.bin');
    const fh = fs.openSync(huge, 'w');
    fs.ftruncateSync(fh, MAX_RAW_BYTES + 1024);
    fs.closeSync(fh);
    const res = await app.inject({ method: 'GET', url: '/api/fs/raw?path=huge.bin' });
    expect(res.statusCode).toBe(413);
    fs.unlinkSync(huge);
  });

  it('同样拒绝越界', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/fs/raw?path=${encodeURIComponent('../nope/secret.txt')}` });
    expect(res.statusCode).toBe(403);
  });
});
