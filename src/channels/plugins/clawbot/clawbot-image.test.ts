/**
 * clawbot-image.test.ts —— 微信 ClawBot 图片「下载 + 解密」协议常量锁定。
 *
 * 为什么必须有这个测试：解密方案（**hex 解码 aeskey → AES-128-ECB / PKCS#7**）
 * 不是从文档抄的，是 2026-09-19 拿**真实抓包样本**试出来的。协议类型里没有任何字段
 * 注释能提醒后人，改动它又不会立刻报错 —— 只会让图片重新变成"静默丢弃"。
 * 所以这里用**自造密文**把方案钉死：改坏了，测试立刻红。
 *
 * 覆盖：成功解密 / aes_key(base64) 兜底还原密钥 / 密钥错→魔数自检拦截 /
 *       缺 media.full_url（旧代码就是死在认 image_item.url）→ 返回 null。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { fetchWeixinImage } from './clawbot-channel.js';
import type { ImageItem } from './clawbot-client.js';

/** 实测样本里的密钥（32 位 hex；hex 解码后即 16 字节 AES-128 key） */
const KEY_HEX = '13308481c2cca9873e9e8902147d0616';

/** 造一张"最小 JPEG"：FFD8FF 开头 + 若干字节，长度足以跨过 PKCS#7 分组边界 */
function fakeJpeg(n = 1000): Buffer {
  const b = Buffer.alloc(n);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  for (let i = 3; i < n; i++) b[i] = i % 251;
  return b;
}

/** 按微信的加密方式回做一遍：AES-128-ECB + PKCS#7 */
function encryptLikeWeixin(plain: Buffer, keyHex: string): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null);
  return Buffer.concat([c.update(plain), c.final()]);
}

function stubFetchWith(body: Buffer): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => new Response(body));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWeixinImage：微信图片下载 + 解密（协议常量锁定）', () => {
  it('AES-128-ECB 解密成功，逐字节还原原始 JPEG', async () => {
    const jpeg = fakeJpeg(1000);
    stubFetchWith(encryptLikeWeixin(jpeg, KEY_HEX));

    const out = await fetchWeixinImage({
      media: { full_url: 'https://example.invalid/c2c/download' },
      aeskey: KEY_HEX,
    });

    expect(out, '解密失败 —— 协议常量被改坏了？').not.toBeNull();
    expect(out!.media_type).toBe('image/jpeg');
    expect(Buffer.from(out!.data, 'base64').equals(jpeg), '还原出的字节与原图不一致').toBe(true);
  });

  it('aeskey 缺失时，从 media.aes_key（base64）还原出同一把密钥', async () => {
    const jpeg = fakeJpeg(500);
    const aesKeyB64 = Buffer.from(KEY_HEX, 'utf8').toString('base64'); // 解开就是那串 hex
    stubFetchWith(encryptLikeWeixin(jpeg, KEY_HEX));

    const out = await fetchWeixinImage({
      media: { full_url: 'https://example.invalid/c2c/download', aes_key: aesKeyB64 },
    });

    expect(out).not.toBeNull();
    expect(Buffer.from(out!.data, 'base64').equals(jpeg)).toBe(true);
  });

  it('密钥不对 → 魔数自检拦住，返回 null（绝不把垃圾字节当图片塞进上下文）', async () => {
    const jpeg = fakeJpeg(300);
    stubFetchWith(encryptLikeWeixin(jpeg, KEY_HEX));

    const out = await fetchWeixinImage({
      media: { full_url: 'https://example.invalid/c2c/download' },
      aeskey: 'ffffffffffffffffffffffffffffffff', // 长度合法但内容错
    });

    expect(out).toBeNull();
  });

  it('缺 media.full_url（旧代码就是死在"只认 image_item.url"）→ 返回 null', async () => {
    const out = await fetchWeixinImage({
      url: 'https://example.invalid/legacy-path-weixin-never-sends',
    } as ImageItem['image_item']);

    expect(out).toBeNull();
  });

  it('HTTP 非 2xx → 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));

    const out = await fetchWeixinImage({
      media: { full_url: 'https://example.invalid/c2c/download' },
      aeskey: KEY_HEX,
    });

    expect(out).toBeNull();
  });
});
