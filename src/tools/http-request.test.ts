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
    if (req.url === '/api/search') {
      // select（字段投影）的回归点：一个端点同时覆盖
      //   ① 数组遍历 results[] ② 多字段选择 {a,b,c} ③ 未选中字段必须被丢弃
      //   ④ 倒排索引（abstract_inverted_index 形状）必须还原成正文
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        meta: { count: 2 },
        results: [
          {
            title: 'Paper A',
            publication_year: 2024,
            doi: '10.1/a',
            abstract_inverted_index: { The: [0], quick: [1], brown: [2], fox: [3] },
            extra: 'MUST BE DROPPED',
          },
          { title: 'Paper B', publication_year: 2025, doi: '10.1/b', extra: 'MUST BE DROPPED' },
        ],
      }));
      return;
    }
    if (req.url === '/bigjson') {
      // select 回归闸的夹具（见文末 describe）：体积必须**明显大于**测试里压小的
      // tools.http.maxResponseBytes（闸里压到 200 字节），且必须是**完整合法 JSON** ——
      // 这样"能不能 parse"才是可判别信号：若投影晚于截断，decoded 会变成半截
      // ⇒ JSON.parse 失败 ⇒ 恒定回 "[select] ignored"（就是那条真实踩过的 bug）。
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pad: 'x'.repeat(2000) }));
      return;
    }
    if (req.url === '/shell') {
      // JS 壳页：体积不小（>4KB），但几乎没有可读正文。
      // 复刻真实场景：Bing / ecosia 这类搜索页抓回来 51KB 静态 HTML，
      // 结果全在 JS 里，抽取后只剩几十字符。
      const filler = `var payload='${'a'.repeat(6000)}';`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>壳</title><script>${filler}</script></head><body><div id="root"></div></body></html>`);
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
    // 注意：措辞需保留历史子串 "url is required" —— 既有契约测试断言它（见 builtin-tool-contracts）
    expect(await tool.execute({})).toContain('url is required');
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

  it('抽取近乎为空时给出出路提示与原始头，而不是只丢一句 format:raw', async () => {
    const r = await tool.execute({ url: `${base}/shell` });
    expect(r).toContain('[extract]');
    expect(r).toContain('extraction nearly empty');
    expect(r).toContain('[hint]');
    expect(r).toContain('format=rss');      // 明确指向"机器口"
    expect(r).toContain('[raw head]');      // 附一段原始头，便于一眼分辨壳页/反爬墙
  });
});

describe('http_request · select（JSON 字段投影）', () => {
  it('数组遍历 + 多字段：只留指定字段，未选中的被丢弃', async () => {
    const r = await tool.execute({ url: `${base}/api/search`, select: 'results[].{title,doi}' });
    expect(r).toContain('[select]');
    expect(r).toContain('Paper A');
    expect(r).toContain('10.1/a');
    expect(r).toContain('Paper B');
    // 未选中的字段必须消失（这是投影存在的理由：少占上下文）
    expect(r).not.toContain('MUST BE DROPPED');
    expect(r).not.toContain('publication_year');
    expect(r).not.toContain('meta');
  });

  it('普通路径：meta.count', async () => {
    const r = await tool.execute({ url: `${base}/api/search`, select: 'meta.count' });
    expect(r).toContain('[select]');
    expect(r).toContain('2');
    expect(r).not.toContain('Paper A');
  });

  it('倒排索引（abstract_inverted_index 形状）自动还原成正文字符串', async () => {
    const r = await tool.execute({
      url: `${base}/api/search`,
      select: 'results[].{abstract_inverted_index}',
    });
    expect(r).toContain('The quick brown fox');
    // 还原后不该再看到「词 → 位置数组」的形状
    expect(r).not.toContain('"brown": [');
  });

  it('路径不匹配 ⇒ 加提示并回退原响应体（不报错）', async () => {
    const r = await tool.execute({ url: `${base}/api/search`, select: 'nope.missing' });
    expect(r).toContain('[select] ignored');
    expect(r).toContain('MUST BE DROPPED'); // 回退 = 原响应体仍在
  });

  it('JSON 但表达式合法：小响应也能投影', async () => {
    const r = await tool.execute({ url: `${base}/json`, select: 'n' });
    expect(r).toContain('[select]');
    expect(r).toContain('42');
  });

  it('format:"raw" 时跳过投影（raw 的语义就是原样）', async () => {
    const r = await tool.execute({ url: `${base}/api/search`, select: 'meta.count', format: 'raw' });
    expect(r).not.toContain('[select]');
    expect(r).toContain('MUST BE DROPPED');
  });
});

/**
 * ── select 的回归闸：投影必须早于截断 ──
 *
 * 曾真实踩过的 bug：投影写在了 reader 截断**之后**（见 http-request.ts fetchOne 的说明）。
 * 触发条件是"响应体 > tools.http.maxResponseBytes"：
 *   超限 ⇒ reader.cancel() 截断 ⇒ decoded 是半截 JSON ⇒ JSON.parse 失败
 *   ⇒ **恒定回 "[select] ignored"**。而投影存在的唯一理由恰恰是处理大响应 ——
 *   它就这么静静地永不工作。
 *
 * 当时所有测试都放它过去：本地 fixture 都极小（19B / 2874B），永远碰不到截断。
 * 所以这条闸的做法是**把上限压到比夹具还小**，强行把那条路径逼出来。
 * 第二个 it 是对照组：证明"上限确实生效" —— 否则第一个 it 可能是假绿。
 */
const { injectToolConfigCenter } = await import('./tool-config.js');

describe('http_request · select 回归闸（投影必须早于截断）', () => {
  // 只覆盖 tools.http.maxResponseBytes，其余键回退各自默认值
  const tinyCap = { get: (p: string) => (p === 'tools.http.maxResponseBytes' ? 200 : undefined) };

  it('响应超过 tools.http.maxResponseBytes 时，select 仍必须生效', async () => {
    injectToolConfigCenter(tinyCap as never);
    try {
      const r = await tool.execute({ url: `${base}/bigjson`, select: 'ok' });
      expect(r).not.toContain('[select] ignored');
      expect(r).toContain('[select]');
      expect(r).toContain('true');
    } finally {
      injectToolConfigCenter(null);
    }
  });

  it('对照组：同样压小上限、不带 select ⇒ 确实被截断（证明上限真的生效）', async () => {
    injectToolConfigCenter(tinyCap as never);
    try {
      const r = await tool.execute({ url: `${base}/bigjson` });
      expect(r).toContain('truncated');
    } finally {
      injectToolConfigCenter(null);
    }
  });
});
