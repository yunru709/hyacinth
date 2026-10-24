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
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerPreviewRoutes, MAX_TEXT_BYTES, MAX_RAW_BYTES } from './preview-routes.js';
import { createPreviewService, sanitizeDocxHtml, MAX_DOCX_BYTES } from './preview-service.js';
import { buildZip } from '../ui-protocol/util/zip.js';

let root: string;
let app: FastifyInstance;
/** 工作区外的目录（用于验证越界被拒） */
let outside: string;
/** 根目录偏好的临时落盘文件：绝不能写真实的 ~/.agent/preview-root.json */
let stateFile: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-preview-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-outside-'));
  stateFile = path.join(root, '..', `hyacinth-preview-state-${process.pid}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  fs.writeFileSync(path.join(outside, 'secret.txt'), '工作区外的秘密', 'utf-8');
  fs.mkdirSync(path.join(outside, 'sub'));

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
  registerPreviewRoutes(app, createPreviewService(root, { stateFile }));
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
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

  it('HTML 被标成 html：前端据此走沙箱 iframe 而不是代码视图', async () => {
    fs.writeFileSync(path.join(root, 'p.html'), '<html><body>x</body></html>', 'utf-8');
    try {
      const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=p.html' });
      const j = res.json();
      expect(j.kind).toBe('html');
      expect(j.lang).toBe('html');
    } finally {
      fs.unlinkSync(path.join(root, 'p.html'));
    }
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

// ============================================================
// docx 语义预览（mammoth 转语义 HTML）
// ============================================================
// 测试用的 docx 由 buildZip 现场构造（最小 OOXML 三件套：Content_Types /
// rels / document.xml），不引入二进制夹具文件。
describe('docx 预览', () => {
  function makeDocx(bodyXml: string[]): Buffer {
    const paras = bodyXml.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('');
    return buildZip([
      { path: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
      { path: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
      { path: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`) },
    ]);
  }

  it('docx → kind=docx + 语义 HTML（binary=false）', async () => {
    fs.writeFileSync(path.join(root, '样例.docx'), makeDocx(['你好，文档', '第二段']));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=' + encodeURIComponent('样例.docx') });
      expect(res.statusCode).toBe(200);
      const j = res.json();
      expect(j.kind).toBe('docx');
      expect(j.binary).toBe(false);
      expect(j.content).toContain('<p>你好，文档</p>');
      expect(j.content).toContain('<p>第二段</p>');
      expect(j.truncated).toBe(false);
    } finally {
      fs.unlinkSync(path.join(root, '样例.docx'));
    }
  });

  it('超过上限的 docx 回退 binary（mammoth 转换是 CPU 活，超大不伺候）', async () => {
    // 文件体积（zip deflate **之后**）必须 > MAX_DOCX_BYTES ⇒ 用低压缩率的随机
    // base64（熵 ~6bit/字符，deflate 后仍 ≈75% 原大）填充，原文取 3 倍上限保压缩后仍超限。
    const big = Buffer.from(randomBase64(MAX_DOCX_BYTES * 3)).toString('utf8');
    fs.writeFileSync(path.join(root, 'big.docx'), makeDocx([big]));
    try {
      const st = fs.statSync(path.join(root, 'big.docx'));
      expect(st.size).toBeGreaterThan(MAX_DOCX_BYTES);   // 夹具自检：确实超限
      const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=big.docx' });
      const j = res.json();
      expect(j.binary).toBe(true);
      expect(j.kind).toBe('binary');
    } finally {
      fs.unlinkSync(path.join(root, 'big.docx'));
    }
  });

  it('损坏的 docx（不是合法 zip）回退 binary，不 500', async () => {
    fs.writeFileSync(path.join(root, 'broken.docx'), Buffer.from('这不是一个 zip'));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/fs/read?path=broken.docx' });
      expect(res.statusCode).toBe(200);
      const j = res.json();
      expect(j.binary).toBe(true);
      expect(j.kind).toBe('binary');
    } finally {
      fs.unlinkSync(path.join(root, 'broken.docx'));
    }
  });
});

describe('sanitizeDocxHtml（服务端消毒直测）', () => {
  it('剥 script/style 容器、on* 事件属性、javascript: 协议', () => {
    const dirty = '<p onclick="evil()">a</p><script>alert(1)</script><style>x</style>'
      + '<a href="javascript:alert(2)">b</a><img src="javascript:alert(3)">';
    const clean = sanitizeDocxHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('href="#"');
  });

  it('正常内容原样保留', () => {
    const ok = '<h1>标题</h1><p>正文 <strong>加粗</strong></p><table><tr><td>x</td></tr></table>';
    expect(sanitizeDocxHtml(ok)).toBe(ok);
  });
});

function randomBase64(n: number): string {
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) {
    crypto.randomBytes(Math.min(65536, n - i)).copy(bytes, i);
  }
  return bytes.toString('base64');
}

describe('GET /api/fs/raw', () => {
  it('下发原始字节 + 正确 Content-Type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/raw?path=blob.bin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.rawPayload.length).toBe(5);
  });

  it('HTML：text/html 且**不带 charset**（带了会让 gb2312 老页面整页乱码）', async () => {
    fs.writeFileSync(
      path.join(root, 'enc.html'),
      '<html><head><meta charset="gb2312"></head><body>中文</body></html>',
      'utf-8',
    );
    try {
      const res = await app.inject({ method: 'GET', url: '/api/fs/raw?path=enc.html' });
      expect(res.statusCode).toBe(200);
      // 精确断言：HTTP 头的 charset 优先级高于 <meta>，一旦有人"顺手"加上 utf-8，
      // 预览栏里的老页面就会变成一片乱码（这个 bug 已经踩过一次）
      expect(res.headers['content-type']).toBe('text/html');
    } finally {
      fs.unlinkSync(path.join(root, 'enc.html'));
    }
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

// ============================================================
// 换根（browse / root）
// ============================================================
// 这组的重点是"换根真的生效，但只能本机做"：
//   1. browse 只回子目录、能浏览到工作区**之外**（选择器的正当用途）
//   2. 非回环发起 → 403（否则局域网客户端能把根设成 C:/ 再读全盘）
//   3. POST 之后 meta.isCustom 翻转、旧相对路径改指向新根
//   4. 'default' 回工作区；相对路径 / 不存在 → 400 / 404
//   5. 偏好写盘后，新实例启动即恢复（"重启后还记得"）
describe('换根', () => {
  const remoteOutside = { remoteAddress: '10.1.2.3' };

  it('browse 列出子目录（不含文件、不含 .git），并支持绝对路径下钻', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/browse' });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.dir).toBe(root);
    expect(j.entries.map((e: { name: string }) => e.name)).toContain('src');
    expect(j.entries.map((e: { name: string }) => e.name)).not.toContain('.git');
    // 文件不入列（只有目录才是"位置"）
    expect(j.entries.map((e: { name: string }) => e.name)).not.toContain('a.txt');
    // 快捷位置至少要有工作区
    expect(j.shortcuts.some((s: { kind: string }) => s.kind === 'workspace')).toBe(true);

    const out = await app.inject({
      method: 'GET',
      url: '/api/fs/browse?dir=' + encodeURIComponent(outside),
    });
    expect(out.statusCode).toBe(200);
    const oj = out.json();
    expect(oj.dir).toBe(outside);
    expect(oj.entries.map((e: { name: string }) => e.name)).toEqual(['sub']);
    expect(oj.parent).toBe(path.dirname(outside));
  });

  it('browse 拒绝相对路径与不存在的目录', async () => {
    const rel = await app.inject({ method: 'GET', url: '/api/fs/browse?dir=src' });
    expect(rel.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/fs/browse?dir=' + encodeURIComponent(path.join(outside, 'nope')),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('非本机发起：browse / root 都 403', async () => {
    const b = await app.inject({ method: 'GET', url: '/api/fs/browse', ...remoteOutside });
    expect(b.statusCode).toBe(403);
    const r = await app.inject({
      method: 'POST', url: '/api/fs/root',
      payload: { root: outside }, ...remoteOutside,
    });
    expect(r.statusCode).toBe(403);
  });

  it('POST 换根后：meta 翻转、旧相对路径改指新根', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/fs/root', payload: { root: outside },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(path.resolve(m.root)).toBe(path.resolve(outside));
    expect(m.isCustom).toBe(true);
    expect(path.resolve(m.defaultRoot)).toBe(path.resolve(root));

    // 换根前 'secret.txt' 在工作区里不存在；换到 outside 后应能读到
    const read = await app.inject({ method: 'GET', url: '/api/fs/read?path=secret.txt' });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toContain('工作区外的秘密');

    // 越界判定基准也跟着换了：原来的工作区现在反而在"外面"
    const back = await app.inject({
      method: 'GET', url: '/api/fs/read?path=' + encodeURIComponent('../' + path.basename(root) + '/a.txt'),
    });
    expect(back.statusCode).toBe(403);
  });

  it('偏好的确落盘（含 recent）', async () => {
    const prefs = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(path.resolve(prefs.root)).toBe(path.resolve(outside));
    expect(prefs.recent.length).toBeGreaterThan(0);
  });

  it('root 校验：相对路径 400、不存在 404', async () => {
    const rel = await app.inject({ method: 'POST', url: '/api/fs/root', payload: { root: 'src' } });
    expect(rel.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST', url: '/api/fs/root',
      payload: { root: path.join(outside, 'nope') },
    });
    expect(missing.statusCode).toBe(404);
    // 失败的切换不该把当前根弄坏
    const meta = await app.inject({ method: 'GET', url: '/api/fs/meta' });
    expect(path.resolve(meta.json().root)).toBe(path.resolve(outside));
  });

  it("'default' 回到工作区", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/fs/root', payload: { root: 'default' } });
    expect(res.statusCode).toBe(200);
    expect(path.resolve(res.json().root)).toBe(path.resolve(root));
    expect(res.json().isCustom).toBe(false);
  });

  it('重启（新实例 + 同一 stateFile）恢复上次的根', async () => {
    await app.inject({ method: 'POST', url: '/api/fs/root', payload: { root: outside } });
    const app2 = fastify({ logger: false });
    registerPreviewRoutes(app2, createPreviewService(root, { stateFile }));
    await app2.ready();
    const meta = await app2.inject({ method: 'GET', url: '/api/fs/meta' });
    expect(path.resolve(meta.json().root)).toBe(path.resolve(outside));
    await app2.close();
    // 复位，避免影响后续（本文件内没有后续，但保持对称）
    await app.inject({ method: 'POST', url: '/api/fs/root', payload: { root: 'default' } });
  });

  it('记录里的目录被删掉时，退回工作区而不是卡在空根', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-gone-'));
    await app.inject({ method: 'POST', url: '/api/fs/root', payload: { root: gone } });
    fs.rmSync(gone, { recursive: true, force: true });
    const app3 = fastify({ logger: false });
    registerPreviewRoutes(app3, createPreviewService(root, { stateFile }));
    await app3.ready();
    const meta = await app3.inject({ method: 'GET', url: '/api/fs/meta' });
    expect(path.resolve(meta.json().root)).toBe(path.resolve(root));
    await app3.close();
  });
});

// ============================================================
// 契约守卫：/api/fs 面「全只读 + 唯一一个受控 POST」
// ============================================================
// 这一组的用意不是测行为，而是**钉死形状**：
// 预览栏的 fs 面必须只有 GET（读）+ 一个 POST /api/fs/root（换根，仅回环）。
// 以后有人想加 POST /api/fs/write、DELETE /api/fs/entry 之类，这里会先红 ——
// 想清楚"为什么预览栏需要写文件"再改，而不是顺手加一个。
describe('契约：fs 面只读，唯一可变入口是 root', () => {
  const routes: Array<{ method: string; url: string }> = [];

  beforeAll(async () => {
    const app2 = fastify({ logger: false });
    registerPreviewRoutes(app2, createPreviewService(root, { stateFile }));
    await app2.ready();
    // printRoutes({ commonPrefix: false }) 输出形如：
    //   ├── /api/fs/meta (GET, HEAD)
    //   末行用 └──。前导是绘制树形的字符，必须先剥掉再匹配。
    // 注意 GET 会被自动补一个 HEAD —— 那是同一读路径的伴生方法，不算写。
    for (const raw of app2.printRoutes({ commonPrefix: false }).split('\n')) {
      const line = raw.replace(/^[\s│├└─╮╯╰┬┴┼]*/, '').trim();
      const m = /^(\/api\/fs\S*)\s+\(([A-Z, ]+)\)/.exec(line);
      if (m) for (const meth of m[2].split(',').map((x) => x.trim())) routes.push({ method: meth, url: m[1] });
    }
    // 一条都没解析出来 ⇒ 解析逻辑对不上框架输出格式。此时"没违规"只是空集假象，
    // 必须显式失败，否则这条守卫会静默通过（第一次写就踩到了：正则是 ^ 锚定，
    // 被树形前缀挡住，路由 0 条）。
    expect(routes.length).toBeGreaterThan(0);
    await app2.close();
  });

  it('除 POST /api/fs/root 外，全部是 GET（HEAD 是 GET 的伴生，不算写）', () => {
    const writes = routes.filter(
      (r) => r.method !== 'GET' && r.method !== 'HEAD' && r.url !== '/api/fs/root',
    );
    expect(writes).toEqual([]);
  });

  it('POST 有且仅有 /api/fs/root 一个', () => {
    const posts = routes.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.url)).toEqual(['/api/fs/root']);
  });

  it('解析出的读端点齐全（防止解析器漏行导致守卫被架空）', () => {
    const gets = new Set(routes.filter((r) => r.method === 'GET').map((r) => r.url));
    for (const p of ['/api/fs/meta', '/api/fs/list', '/api/fs/read', '/api/fs/raw', '/api/fs/browse']) {
      expect(gets.has(p)).toBe(true);
    }
  });
});
