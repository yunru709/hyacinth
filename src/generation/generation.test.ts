/**
 * 生成能力冒烟测试 — 同步适配器全链路 + 骨架路由
 *
 * 核心验证：
 *   1. 同步适配器（火山 Seedream）：submitTask 直接返回 initialStatus=success，
 *      service.generate() 检测到后跳过轮询，直接下载转存
 *   2. 负向提示词拼接 `--neg:`
 *   3. referenceImages 映射到 image 字段
 *   4. 失败时返回 initialStatus=failed，service 抛错
 *   5. registry 内置适配器注册 + 模态默认路由
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerationRegistry, GenerationService } from './index.js';
import { VolcSeedreamProvider } from './adapters/volc-seedream.js';
import type { GenerationProviderConfig } from './interface.js';

// ─── Helpers ───────────────────────────────────────────────────────────

const cfg: GenerationProviderConfig = {
  type: 'volc-seedream',
  model: 'doubao-seedream-5-0-lite-260128',
  apiKey: 'test-key',
};

/** mock fetch：返回可控的火山响应 */
function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** 构造一个已注册 volc-seedream 的 registry */
function makeRegistry(providerCfg: GenerationProviderConfig = cfg): GenerationRegistry {
  const registry = new GenerationRegistry({
    providers: { volc: providerCfg },
    defaults: { image: 'volc', video: 'volc' },
  });
  return registry;
}

// ─── 1. 能力声明 ───────────────────────────────────────────────────────

describe('VolcSeedreamProvider capabilities', () => {
  it('声明为同步图片生成，支持文生图/图生图', () => {
    const p = new VolcSeedreamProvider('volc', cfg);
    const caps = p.getCapabilities();
    expect(caps.modality).toBe('image');
    expect(caps.supportsAsync).toBe(false);
    expect(caps.taskTypes).toContain('text_to_image');
    expect(caps.taskTypes).toContain('image_to_image');
    expect(caps.supportsNegativePrompt).toBe(true);
    expect(caps.supportsReferenceImage).toBe(true);
  });
});

// ─── 2. 请求构造：负向提示词 / 参考图 ─────────────────────────────────

describe('VolcSeedreamProvider request building', () => {
  it('负向提示词拼接 --neg: 到 prompt 尾部', async () => {
    const p = new VolcSeedreamProvider('volc', cfg);
    const fetchMock = mockFetchOnce({
      data: [{ url: 'https://example.com/img.png', size: '1024x1024' }],
      model: 'test',
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await p.submitTask({
      provider: 'volc',
      taskType: 'text_to_image',
      prompt: '赛博朋克小猫',
      negativePrompt: '模糊，低画质',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.prompt).toBe('赛博朋克小猫 --neg: 模糊，低画质');
    expect(body.response_format).toBe('url');
    expect(body.sequential_image_generation).toBe('disabled');
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toBe('https://example.com/img.png');
    vi.unstubAllGlobals();
  });

  it('referenceImages 映射到 image 字段（单图 → string）', async () => {
    const p = new VolcSeedreamProvider('volc', cfg);
    const fetchMock = mockFetchOnce({ data: [{ url: 'https://example.com/out.png' }] });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'volc',
      taskType: 'image_to_image',
      prompt: '改成水墨画',
      referenceImages: [{ type: 'url', url: 'https://example.com/in.jpg', role: 'reference' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.image).toBe('https://example.com/in.jpg');
    vi.unstubAllGlobals();
  });

  it('base64 参考图剥离 data: 前缀', async () => {
    const p = new VolcSeedreamProvider('volc', cfg);
    const fetchMock = mockFetchOnce({ data: [{ url: 'https://example.com/out.png' }] });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'volc',
      taskType: 'image_to_image',
      prompt: '改风格',
      referenceImages: [{ type: 'base64', base64: 'data:image/png;base64,QUJDREVG' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.image).toBe('QUJDREVG');
    vi.unstubAllGlobals();
  });

  it('失败响应返回 initialStatus=failed', async () => {
    const p = new VolcSeedreamProvider('volc', cfg);
    vi.stubGlobal('fetch', mockFetchOnce(
      { error: { code: 'QuotaExhausted', message: 'insufficient balance' } },
      false, 429,
    ));

    const task = await p.submitTask({
      provider: 'volc',
      taskType: 'text_to_image',
      prompt: 'test',
    });

    expect(task.initialStatus?.status).toBe('failed');
    expect(task.initialStatus?.errorCode).toBe('QuotaExhausted');
    vi.unstubAllGlobals();
  });
});

// ─── 3. service 全链路：同步适配器跳过轮询直接转存 ───────────────────

describe('GenerationService sync flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('同步完成 → 跳过轮询 → 下载转存到 outputs', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    // 第一次 fetch = 生成请求；第二次 fetch = 下载图片
    const genFetch = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/img.png' }] });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('fake-png-bytes'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const onStatus: string[] = [];
    const artifact = await svc.generate(
      { provider: 'volc', taskType: 'text_to_image', prompt: '一只猫' },
      { outputDir: path.join(tmpDir, 'outputs', 'generation'), onStatus: s => onStatus.push(s.status) },
    );

    // 落盘成功
    expect(artifact.localPath).toContain('outputs');
    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.byteSize).toBe(14); // 'fake-png-bytes'.length
    expect(artifact.mediaType).toBe('image/png');

    // 状态流：只报 success，不经过 queuing（同步接口无轮询）
    expect(onStatus).toEqual(['success']);
    vi.unstubAllGlobals();
  });

  it('同步失败 → service 抛错，不进入轮询', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    vi.stubGlobal('fetch', mockFetchOnce(
      { error: { code: 'ContentFilter', message: 'blocked' } },
      false, 400,
    ));

    await expect(svc.generate(
      { provider: 'volc', taskType: 'text_to_image', prompt: 'bad content' },
      { outputDir: path.join(tmpDir, 'outputs', 'generation') },
    )).rejects.toThrow(/ContentFilter|blocked/);
    vi.unstubAllGlobals();
  });

  it('未配置供应商 → registry 抛错', () => {
    const registry = new GenerationRegistry({ providers: {}, defaults: {} });
    expect(() => registry.getProvider('nope')).toThrow(/not configured/);
  });
});

// ─── 4. registry 路由 ─────────────────────────────────────────────────

describe('GenerationRegistry routing', () => {
  it('内置适配器自动注册 + 模态默认路由', () => {
    const registry = makeRegistry();
    expect(registry.listProviders()).toEqual(['volc']);
    const p = registry.getDefaultProvider('image');
    expect(p).toBeInstanceOf(VolcSeedreamProvider);
    expect(registry.hasModality('image')).toBe(true);
    expect(registry.hasModality('audio')).toBe(false);
  });
});
