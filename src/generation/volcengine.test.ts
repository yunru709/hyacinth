/**
 * 火山适配器（VolcengineProvider）测试 — 一厂商一适配器，图/视频双路径
 *
 * 核心验证（重构后）：
 *   1. 单 Provider 声明多能力：modalities=['image','video']，taskTypes 含图+视频
 *   2. 图片（同步）：submitTask 填 initialStatus=success → service 跳过轮询直接转存
 *   3. 视频（异步）：submitTask 返回 taskId（无 initialStatus）→ service 轮询 → 转存
 *   4. 负向提示词拼接 --neg:、参考图映射、base64 剥前缀
 *   5. 多模态 content[] 构造（text+image+video+audio）
 *   6. 状态映射（queued/running/succeeded/failed/expired）
 *   7. registry 自动注册 + 按 taskType 默认路由
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerationRegistry, GenerationService } from './index.js';
import { VolcengineProvider } from './adapters/volcengine.js';
import type { GenerationProviderConfig } from './interface.js';

// ─── Helpers ───────────────────────────────────────────────────────────

const cfg: GenerationProviderConfig = {
  type: 'volcengine',
  models: {
    text_to_image: 'doubao-seedream-5-0-lite-260128',
    text_to_video: 'doubao-seedance-2-0',
  },
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

/** 构造一个已注册 volcengine 的 registry */
function makeRegistry(providerCfg: GenerationProviderConfig = cfg): GenerationRegistry {
  const registry = new GenerationRegistry({
    providers: { volc: providerCfg },
    defaults: { text_to_image: 'volc', text_to_video: 'volc' },
  });
  return registry;
}

/** 构造按顺序返回的 fetch mock：先 submit，再依次 status，最后下载 */
function mockSequence(responses: unknown[]) {
  return vi.fn()
    .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => responses[0] }))
    .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => responses[1] }))
    .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => responses[2] }))
    .mockImplementationOnce(() => Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('video-bytes'),
    }));
}

// ─── 1. 能力声明 ───────────────────────────────────────────────────────

describe('VolcengineProvider capabilities', () => {
  it('单 Provider 声明图+视频多能力', () => {
    const p = new VolcengineProvider('volc', cfg);
    const caps = p.getCapabilities();
    expect(caps.modalities).toEqual(expect.arrayContaining(['image', 'video']));
    expect(caps.taskTypes).toContain('text_to_image');
    expect(caps.taskTypes).toContain('image_to_image');
    expect(caps.taskTypes).toContain('text_to_video');
    expect(caps.taskTypes).toContain('image_to_video');
    expect(caps.taskTypes).toContain('reference_to_video');
    expect(caps.supportsNegativePrompt).toBe(true);
    expect(caps.supportsReferenceImage).toBe(true);
    expect(caps.supportsReferenceVideo).toBe(true);
    expect(caps.supportsReferenceAudio).toBe(true);
    expect(caps.supportsFirstLastFrame).toBe(true);
    expect(caps.supportsAsync).toBe(true); // 视频异步（图片同步，内部统一）
  });
});

// ─── 2. 图片请求构造（同步路径）────────────────────────────────────────

describe('VolcengineProvider image request building', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('负向提示词拼接 --neg: 到 prompt 尾部', async () => {
    const p = new VolcengineProvider('volc', cfg);
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
    // 模型按 taskType 从 models 解析
    expect(body.model).toBe('doubao-seedream-5-0-lite-260128');
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toBe('https://example.com/img.png');
    vi.unstubAllGlobals();
  });

  it('referenceImages 映射到 image 字段（单图 → string）', async () => {
    const p = new VolcengineProvider('volc', cfg);
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

  it('base64 参考图剥离 data: 前缀（图片接口）', async () => {
    const p = new VolcengineProvider('volc', cfg);
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
    const p = new VolcengineProvider('volc', cfg);
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

// ─── 3. 视频提交（异步路径）───────────────────────────────────────────

describe('VolcengineProvider video submitTask', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('返回 taskId，不填 initialStatus（区别于图片同步）', async () => {
    const p = new VolcengineProvider('volc', cfg);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'task-123', status: 'queued' }),
    }));

    const task = await p.submitTask({
      provider: 'volc',
      taskType: 'text_to_video',
      prompt: '一只猫在雨中奔跑',
      duration: 5,
      resolution: '1080p',
      aspectRatio: '16:9',
    });

    expect(task.taskId).toBe('task-123');
    expect(task.initialStatus).toBeUndefined(); // 关键：走轮询
    expect(task.provider).toBe('volcengine');
    vi.unstubAllGlobals();
  });

  it('多模态参考构造 content[] 数组（text+image+video+audio）', async () => {
    const p = new VolcengineProvider('volc', cfg);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'task-456' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'volc',
      taskType: 'reference_to_video',
      prompt: '结合参考图',
      referenceImages: [{ type: 'url', url: 'https://img.example.com/a.jpg', role: 'reference' }],
      referenceVideos: [{ type: 'url', url: 'https://vid.example.com/b.mp4', role: 'reference_video' }],
      referenceAudio: { type: 'url', url: 'https://aud.example.com/c.wav' },
      firstFrame: { type: 'url', url: 'https://img.example.com/first.jpg' },
      lastFrame: { type: 'url', url: 'https://img.example.com/last.jpg' },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const types = body.content.map((c: { type: string }) => c.type);
    expect(types).toContain('text');
    expect(types).toContain('image_url');
    expect(types).toContain('video_url');
    expect(types).toContain('audio_url');
    // 模型按 taskType 从 models 解析
    expect(body.model).toBe('doubao-seedance-2-0');
    // 首尾帧角色
    const imgRoles = body.content
      .filter((c: { type: string }) => c.type === 'image_url')
      .map((c: { image_url: { role?: string } }) => c.image_url.role);
    expect(imgRoles).toContain('first_frame');
    expect(imgRoles).toContain('last_frame');
    expect(imgRoles).toContain('reference');
    vi.unstubAllGlobals();
  });

  it('提交失败抛错（含错误码）', async () => {
    const p = new VolcengineProvider('volc', cfg);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'QuotaExhausted', message: 'no balance' } }),
    }));

    await expect(p.submitTask({
      provider: 'volc',
      taskType: 'text_to_video',
      prompt: 'x',
    })).rejects.toThrow(/QuotaExhausted|no balance/);
    vi.unstubAllGlobals();
  });
});

// ─── 4. 状态映射 ───────────────────────────────────────────────────────

describe('VolcengineProvider getTaskStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('映射 queued → queuing, succeeded → success 并带结果 URL', async () => {
    const p = new VolcengineProvider('volc', cfg);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'queued' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'succeeded',
          content: { video_url: 'https://cdn.example.com/v.mp4', last_frame_url: 'https://cdn.example.com/f.png' },
        }),
      }));

    const task = { taskId: 'task-1', provider: 'volcengine' };
    const queued = await p.getTaskStatus(task);
    expect(queued.status).toBe('queuing');

    const done = await p.getTaskStatus(task);
    expect(done.status).toBe('success');
    expect(done.resultUrl).toBe('https://cdn.example.com/v.mp4');
    expect(done.thumbnailUrl).toBe('https://cdn.example.com/f.png');
    vi.unstubAllGlobals();
  });
});

// ─── 5. service 全链路：同步 + 异步 ────────────────────────────────────

describe('GenerationService flows', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('图片同步：跳过轮询直接转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

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

    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.byteSize).toBe(14); // 'fake-png-bytes'.length
    expect(artifact.mediaType).toBe('image/png');
    // 状态流：只报 success，不经过 queuing（同步接口无轮询）
    expect(onStatus).toEqual(['success']);
    vi.unstubAllGlobals();
  });

  it('视频异步：轮询到 success 后转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    vi.stubGlobal('fetch', mockSequence([
      { id: 'task-789', status: 'queued' },
      { status: 'queued' },
      { status: 'succeeded', content: { video_url: 'https://cdn.example.com/v.mp4' } },
    ]));

    const onStatus: string[] = [];
    const artifact = await svc.generate(
      { provider: 'volc', taskType: 'text_to_video', prompt: '海浪' },
      {
        outputDir: path.join(tmpDir, 'outputs', 'generation'),
        pollIntervalMs: 1,
        onStatus: s => onStatus.push(s.status),
      },
    );

    expect(onStatus).toEqual(['queuing', 'queuing', 'success']);
    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.mediaType).toBe('video/mp4');
    expect(artifact.byteSize).toBe(11); // 'video-bytes'.length
    expect(artifact.sourceUrl).toBe('https://cdn.example.com/v.mp4');
    vi.unstubAllGlobals();
  });

  it('图片同步失败 → service 抛错', async () => {
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

  it('视频异步失败：轮询到 failed 抛错', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    vi.stubGlobal('fetch', mockSequence([
      { id: 'task-fail', status: 'queued' },
      { status: 'failed', error: { code: 'TaskFailed', message: 'render error' } },
    ]));

    await expect(svc.generate(
      { provider: 'volc', taskType: 'text_to_video', prompt: 'x' },
      { outputDir: path.join(tmpDir, 'outputs', 'generation'), pollIntervalMs: 1 },
    )).rejects.toThrow(/render error|TaskFailed/);
  });
});

// ─── 6. registry 路由 ─────────────────────────────────────────────────

describe('GenerationRegistry routing', () => {
  it('内置适配器自动注册 + 按 taskType 默认路由', () => {
    const registry = makeRegistry();
    expect(registry.listProviders()).toEqual(['volc']);
    expect(registry.listAdapterTypes()).toContain('volcengine');
    const p = registry.getDefaultProvider('text_to_image');
    expect(p).toBeInstanceOf(VolcengineProvider);
    expect(registry.getDefaultProviderName('text_to_video')).toBe('volc');
    expect(registry.hasTaskType('text_to_image')).toBe(true);
    expect(registry.hasTaskType('audio_tts')).toBe(false);
  });

  it('未配置供应商 → registry 抛错', () => {
    const registry = new GenerationRegistry({ providers: {}, defaults: {} });
    expect(() => registry.getProvider('nope')).toThrow(/not configured/);
  });

  it('未知适配器类型 → 报错并列出可用类型', () => {
    const registry = new GenerationRegistry({
      providers: { x: { type: 'nope-type', apiKey: 'k' } },
      defaults: {},
    });
    expect(() => registry.getProvider('x')).toThrow(/not registered.*volcengine/);
  });
});
