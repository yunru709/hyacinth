/**
 * 多模态/图片管线（P2）单测 —— view_image 路径回看 + loadImageFileToStore。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageStore, loadImageFileToStore, createViewImageTool } from './index.js';

let tmpDir: string;
let imgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  // 写入一个"图片文件"（内容任意，工具只做 base64 编码）
  imgPath = path.join(tmpDir, 'test.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadImageFileToStore（本地图片文件 → ImageStore）', () => {
  it('读取文件、入索引、返回 id/data/media_type', async () => {
    const store = new ImageStore();
    const loaded = await loadImageFileToStore(imgPath, store);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toMatch(/^img_/);
    expect(loaded!.media_type).toBe('image/png');
    expect(loaded!.data.length).toBeGreaterThan(0);
    // 已入索引，可被 ID 查到
    expect(store.get(loaded!.id)?.source_path).toBe(imgPath);
  });

  it('非文件/不存在 → null', async () => {
    const store = new ImageStore();
    expect(await loadImageFileToStore(path.join(tmpDir, 'nope.png'), store)).toBeNull();
    expect(await loadImageFileToStore(tmpDir, store)).toBeNull(); // 目录
  });
});

describe('view_image（ID + 路径双通道）', () => {
  it('ID 命中：走索引回看（原行为）', async () => {
    const store = new ImageStore();
    const pending: Array<{ imgId: string; data: string; media_type: string }> = [];
    const tool = createViewImageTool(store, pending);
    store.store('QUJDRA==', 'image/png'); // 索引一条
    const out = await tool.execute({ image_id: 'img_001' });
    expect(out).toContain('retrieved');
    expect(pending.length).toBe(1);
  });

  it('ID 未命中但传入的是本地图片路径：自动读取+索引+注入', async () => {
    const store = new ImageStore();
    const pending: Array<{ imgId: string; data: string; media_type: string }> = [];
    const tool = createViewImageTool(store, pending);
    const out = await tool.execute({ image_id: imgPath });
    expect(out).toContain('loaded from');
    expect(out).toContain('img_001');
    expect(pending.length).toBe(1);
    expect(pending[0].media_type).toBe('image/png');
  });

  it('既不是 ID 也不是可读路径：报错并列出可用图片', async () => {
    const store = new ImageStore();
    const tool = createViewImageTool(store, []);
    const out = await tool.execute({ image_id: 'img_999' });
    expect(out).toContain('not found');
    expect(out).toContain('不是可读取的本地图片路径');
  });
});

/**
 * 回归防护（C-03，2026-10-22 修复）：内容指纹必须真正含内容。
 *
 * 旧实现把 `head.length` / `tail.length` 拼进哈希，而 head/tail 恒取 512 字符
 * ⇒ 对任何 >768 字节的图后两段恒为 512 ⇒ 哈希退化成「媒体类型 + 总长度」
 * ⇒ 同类型、同字节长度的**不同**图会静默复用同一 id（用户看到的是上一张图）。
 */
describe('ImageStore 内容指纹（C-03 回归）', () => {
  // 两张**等长但内容不同**的 base64（模拟同尺寸、同格式的两张不同截图）
  const A = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=';
  const B = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

  it('前提：两张样本确实等长（否则本组用例证明不了退化）', () => {
    expect(A.length).toBe(B.length);
  });

  it('等长但内容不同 → 不同 id，且各自保留自己的 source_path', () => {
    const store = new ImageStore();
    const ida = store.store(A, 'image/png', '/tmp/a.png');
    const idb = store.store(B, 'image/png', '/tmp/b.png');

    expect(idb).not.toBe(ida);
    expect(store.get(idb)?.source_path).toBe('/tmp/b.png');
    expect(store.list().length).toBe(2);
  });

  it('内容完全相同 → 复用同一 id（去重仍生效，别把修复做成"永远不去重"）', () => {
    const store = new ImageStore();
    const id1 = store.store(A, 'image/png', '/tmp/a.png');
    const id2 = store.store(A, 'image/png', '/tmp/a-copy.png');
    expect(id2).toBe(id1);
    expect(store.list().length).toBe(1);
  });

  it('内容相同但媒体类型不同 → 不同 id（类型参与指纹）', () => {
    const store = new ImageStore();
    expect(store.store(A, 'image/png')).not.toBe(store.store(A, 'image/gif'));
  });
});