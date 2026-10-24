// ============================================================
// UI 契约层 — 文件预览域测试
// ============================================================
// 重点不是"能读文件"，而是：
//   1. 方法面齐全：meta / list / read / browse / setRoot / rawUrl
//   2. read 结果自带签发的 url（前端不硬编码 HTTP 路径的根基）
//   3. 安全边界与 HTTP 路由**同源**：越界/绝对路径拒绝、browse/setRoot
//      仅限回环连接（loopback 缺省 false = fail-closed）
//   4. 服务未装配时报错清晰（TUI 等无预览栏的 UI 通道）
//
// ★ 服务用真实的 createPreviewService（gateway/preview-service.ts）——
//   域与服务是同一条安全核心的两面，分开 mock 反而测不出分叉。
// ★ 走完整协议装配（InProcAdapter + UiProtocolServer），与 process 域测试
//   同一模式：方法面、错误包装（UiError）一并覆盖。
// ★ 隔离：整个工作区是一次性临时目录，结束后删除。
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UiProtocolServer } from '../server.js';
import { InProcAdapter } from '../adapter.js';
import { createPreviewDomain } from './preview.js';
import { createPreviewService, type PreviewService } from '../../gateway/preview-service.js';
import type { UiResponse } from '../types.js';

let root: string;
let outside: string;
let stateFile: string;
let svc: PreviewService;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-pv-domain-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hyacinth-pv-domain-out-'));
  stateFile = path.join(root, '..', `hyacinth-pv-domain-state-${process.pid}.json`);
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  fs.writeFileSync(path.join(root, 'a.txt'), '你好，工作区', 'utf-8');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(outside, 'sub'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), '工作区外的秘密', 'utf-8');
  svc = createPreviewService(root, { stateFile });
});

afterAll(() => {
  try { fs.rmSync(stateFile, { force: true }); } catch { /* ignore */ }
  for (const d of [root, outside]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 走完整协议装配（与 process 域测试同一模式） */
function setup(opts: { loopback?: boolean; service?: PreviewService | null } = {}) {
  const client = new InProcAdapter('client');
  const serverAdp = new InProcAdapter('server');
  client.connect(serverAdp);
  const server = new UiProtocolServer();
  server.registerDomain('preview', createPreviewDomain({
    getService: () => (opts.service !== undefined ? opts.service : svc),
    makeRawUrl: (rel) => '/api/fs/raw?path=' + encodeURIComponent(rel) + '&token=x',
    loopback: opts.loopback ?? true,
  }));
  server.attach(serverAdp);

  const responses: UiResponse[] = [];
  client.onMessage((m) => {
    if (m.kind === 'response') responses.push(m);
  });
  const req = async (method: string, params?: unknown): Promise<UiResponse> => {
    const id = 'r' + Math.random().toString(36).slice(2);
    client.send({ kind: 'request', id, method, params });
    const start = Date.now();
    for (;;) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      if (Date.now() - start > 3000) throw new Error(`timeout waiting for ${id}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { req };
}

describe('方法面（契约 = HTTP 路由同一份能力）', () => {
  it('preview.meta：返回根与上限', async () => {
    const { req } = setup();
    const resp = await req('preview.meta');
    expect(resp.ok).toBe(true);
    const m = resp.result as { exists: boolean; name: string; maxTextBytes: number };
    expect(m.exists).toBe(true);
    expect(m.name).toBe(path.basename(root));
    expect(m.maxTextBytes).toBeGreaterThan(0);
  });

  it('preview.list：.git 恒不列（all=true 也不放行，硬排除）', async () => {
    const { req } = setup();
    const plain = await req('preview.list', { path: '.' });
    const names = (plain.result as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
    expect(names).toContain('a.txt');
    expect(names).not.toContain('.git');

    const all = await req('preview.list', { path: '.', all: true });
    expect((all.result as { entries: Array<{ name: string }> }).entries.map((e) => e.name))
      .not.toContain('.git');
  });

  it('preview.read：文本带内容与签发的 url', async () => {
    const { req } = setup();
    const resp = await req('preview.read', { path: 'a.txt' });
    expect(resp.ok).toBe(true);
    const r = resp.result as { content: string; binary: boolean; url: string };
    expect(r.content).toBe('你好，工作区');
    expect(r.binary).toBe(false);
    expect(r.url).toBe('/api/fs/raw?path=a.txt&token=x');
  });

  it('preview.read：二进制回 binary 标记 + url（前端改走字节流）', async () => {
    const { req } = setup();
    const resp = await req('preview.read', { path: 'blob.bin' });
    const r = resp.result as { binary: boolean; content: string; url: string };
    expect(r.binary).toBe(true);
    expect(r.content).toBe('');
    expect(r.url).toContain('blob.bin');
  });

  it('preview.rawUrl：签发相对路径；越界/绝对路径先校验不签发', async () => {
    const { req } = setup();
    const ok = await req('preview.rawUrl', { path: 'src/../a.txt' });
    expect(ok.result).toEqual({ url: '/api/fs/raw?path=a.txt&token=x', path: 'a.txt' });

    const bad = await req('preview.rawUrl', { path: '../outside/secret.txt' });
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('越出工作区');

    const abs = await req('preview.rawUrl', { path: '/etc/passwd' });
    expect(abs.ok).toBe(false);
    expect(abs.error?.message).toContain('相对路径');
  });

  it('list/read 的越界与绝对路径拒绝（与 HTTP 路由同一套 fail-closed）', async () => {
    const { req } = setup();
    const out = await req('preview.list', { path: '../outside' });
    expect(out.ok).toBe(false);
    expect(out.error?.message).toContain('越出工作区');

    const abs = await req('preview.read', { path: 'C:\\Windows\\win.ini' });
    expect(abs.ok).toBe(false);
    expect(abs.error?.message).toContain('相对路径');

    // 归一化后仍在工作区内则放行（不是无脑拒绝 ..）
    const ok = await req('preview.read', { path: 'src/../a.txt' });
    expect((ok.result as { content: string }).content).toBe('你好，工作区');
  });
});

describe('回环边界（browse / setRoot 仅限本机）', () => {
  it('loopback=false = fail-closed：browse / setRoot 直接拒绝', async () => {
    const { req } = setup({ loopback: false });
    const b = await req('preview.browse', {});
    expect(b.ok).toBe(false);
    expect(b.error?.message).toContain('只允许在本机');

    const r = await req('preview.setRoot', { root: outside });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('只允许在本机');
  });

  it('loopback=true：数据面读操作不受回环限制（鉴权在传输层，与 HTTP 路由一致）', async () => {
    const { req } = setup({ loopback: true });
    const ok = await req('preview.list', { path: '.' });
    expect(ok.ok).toBe(true);
  });

  it('loopback=true：browse 支持绝对路径下钻，setRoot 换根生效', async () => {
    const { req } = setup({ loopback: true });
    const b = await req('preview.browse', { dir: outside });
    expect(b.ok).toBe(true);
    const bj = b.result as { dir: string; entries: Array<{ name: string }> };
    expect(bj.dir).toBe(outside);
    // browse 只回目录名：secret.txt（文件）不入列，sub（目录）入列
    expect(bj.entries.map((e) => e.name)).toEqual(['sub']);

    const r = await req('preview.setRoot', { root: outside });
    const m = r.result as { root: string; isCustom: boolean };
    expect(path.resolve(m.root)).toBe(path.resolve(outside));
    expect(m.isCustom).toBe(true);
    // 换根后相对路径改指新根 —— 与 HTTP 路由共享同一服务实例的语义
    const read = await req('preview.read', { path: 'secret.txt' });
    expect((read.result as { content: string }).content).toContain('工作区外的秘密');
    // 越界基准跟着换：原来的工作区现在反而在"外面"
    const back = await req('preview.read', { path: '../' + path.basename(root) + '/a.txt' });
    expect(back.ok).toBe(false);
    expect(back.error?.message).toContain('越出工作区');
    // 复位
    await req('preview.setRoot', { root: 'default' });
  });
});

describe('服务未装配', () => {
  it('preview.* 报"服务未装配"（TUI 等通道不传 previewService）', async () => {
    const { req } = setup({ service: null });
    const r = await req('preview.list', { path: '.' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('未装配');

    const m = await req('preview.meta');
    expect(m.ok).toBe(false);
    expect(m.error?.message).toContain('未装配');
  });
});
