/**
 * http-request.test.ts — 按需深挖（keepLinks / section / urls）的回归点
 *
 * 用本地 HTTP 服务器（`isPrivateHost('localhost')` 默认放行 loopback），
 * 不依赖外网、不引入 flake。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpRequestTool } from './http-request.js';

const FIXTURE = `<!doctype html><html><head><title>Fixture 页</title></head><body>
<nav>站点导航：首页 关于</nav>
<h1>总览</h1><p>总览内容。</p>
<h2>安装</h2><p>安装步骤一。</p><p>见 <a href="https://example.com/install">安装文档</a>。</p>
<h2>配置</h2><p>配置内容。</p><h3>高级配置</h3><p>高级内容。</p>
<h2>卸载</h2><p>卸载内容。</p>
<div style="display:none">隐藏指令不该出现</div>
</body></html>`;

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: 42 }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const tool = new HttpRequestTool();

describe('http_request 按需深挖', () => {
  it('默认提取正文：剥离 nav 与隐藏元素，带 [extract] 统计', async () => {
    const r = await tool.execute({ url: `${base}/doc` });
    expect(r).toContain('[extract]');
    expect(r).toContain('[title] Fixture 页');
    expect(r).toContain('总览内容。');
    expect(r).not.toContain('站点导航');
    expect(r).not.toContain('隐藏指令不该出现');
    expect(r).toContain('hidden stripped');
  });

  it('section 只取该节（含子标题，不含同级后一节）', async () => {
    const r = await tool.execute({ url: `${base}/doc`, section: '配置' });
    expect(r).toContain('[section] matched "配置"');
    expect(r).toContain('配置内容。');
    // 子标题属于本节的区间
    expect(r).toContain('高级配置');
    expect(r).toContain('高级内容。');
    // 同级后一节与前一节都不该出现
    expect(r).not.toContain('卸载内容。');
    expect(r).not.toContain('安装步骤一。');
  });

  it('section 未命中时给出可操作引导，而不是静默返回全文', async () => {
    const r = await tool.execute({ url: `${base}/doc`, section: '不存在的标题' });
    expect(r).toContain('[section]');
    expect(r).toContain('no heading contained');
    // 仍返回全文，便于自行挑标题
    expect(r).toContain('总览内容。');
  });

  it('keepLinks=true 把链接渲染成「文本 (url)」', async () => {
    const r = await tool.execute({ url: `${base}/doc`, keepLinks: true });
    expect(r).toContain('安装文档 (https://example.com/install)');
    expect(r).toContain('links on');
  });

  it('urls 一次抓多个，逐个标注来源', async () => {
    const r = await tool.execute({ urls: [`${base}/a`, `${base}/b`] });
    expect(r).toContain(`########## ${base}/a`);
    expect(r).toContain(`########## ${base}/b`);
    // 两份内容各出现一次以上（总览内容。）
    expect(r.split('总览内容。').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('urls 超过上限时截断并说明', async () => {
    const list = Array.from({ length: 7 }, (_, i) => `${base}/p${i}`);
    const r = await tool.execute({ urls: list });
    expect(r).toContain('more url(s) skipped');
    expect(r).toContain('at most 5');
  });

  it('既没给 url 也没给 urls 时报错', async () => {
    expect(await tool.execute({})).toContain('url (or urls) is required');
  });

  it('JSON 响应不受提取影响（保持原样）', async () => {
    const r = await tool.execute({ url: `${base}/json` });
    expect(r).toContain('"ok":true');
    expect(r).not.toContain('[extract]');
  });

  it('format=raw 时 section 被忽略并说明', async () => {
    const r = await tool.execute({ url: `${base}/doc`, format: 'raw', section: '配置' });
    expect(r).toContain('<h2>配置</h2>');
    expect(r).toContain('[section] ignored');
  });

  it('urls 中的单个失败不影响其余结果', async () => {
    const addr = server.address() as AddressInfo;
    const dead = `http://127.0.0.1:${addr.port + 1}/dead`;
    const r = await tool.execute({ urls: [`${base}/a`, dead] });
    expect(r).toContain(`########## ${base}/a`);
    expect(r).toContain('总览内容。');
    expect(r).toContain('Error');
  });
});
