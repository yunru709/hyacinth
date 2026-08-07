/**
 * MiniMax 适配器（MiniMaxProvider）测试 — 图/视频/音频三模态
 *
 * 核心验证：
 *   1. 单 Provider 声明三能力：modalities=['image','video','audio']
 *   2. baseUrl 归一化：剥掉 vendor 继承的 /anthropic 后缀
 *   3. 图片（同步）：submitTask 填 initialStatus=success → service 跳过轮询
 *   4. 图生图：subject_reference 映射（character 主体参考）
 *   5. 视频（异步）：submitTask 返回 taskId（mm-video- 前缀）→ 轮询 → 转存
 *   6. 音频（异步）：submitTask 返回 taskId（mm-audio- 前缀）→ 轮询 + file_id→retrieve 拿 URL
 *   7. registry 自动注册 + 按 taskType 默认路由
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerationRegistry, GenerationService } from './index.js';
import { MiniMaxProvider } from './adapters/minimax.js';
import type { GenerationProviderConfig } from './interface.js';

// ─── Helpers ───────────────────────────────────────────────────────────

const cfg: GenerationProviderConfig = {
  type: 'minimax',
  models: {
    text_to_image: 'image-01',
    image_to_image: 'image-01',
    text_to_video: 'MiniMax-H3',
    image_to_video: 'MiniMax-H3',
    reference_to_video: 'MiniMax-H3',
    audio_tts: 'speech-2.8-hd',
  },
  apiKey: 'test-key',
};

/** mock fetch：返回可控的 MiniMax 响应 */
function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** 构造一个已注册 minimax 的 registry */
function makeRegistry(providerCfg: GenerationProviderConfig = cfg): GenerationRegistry {
  const registry = new GenerationRegistry({
    providers: { minimax: providerCfg },
    defaults: {
      text_to_image: 'minimax',
      text_to_video: 'minimax',
      audio_tts: 'minimax',
    },
  });
  return registry;
}

/** 构造视频链路 mock：submit → poll(queued) → poll(succeeded) → 下载 */
function mockVideoSequence() {
  return vi.fn()
    .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ task_id: '424010985738629' }) }))
    .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ task: { status: 'queued' } }) }))
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ task: { status: 'succeeded', content: { url: 'https://cdn.example.com/v.mp4' } } }),
    }))
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: async () => Buffer.from('video-bytes'),
    }));
}

/** 构造音频链路 mock：submit → poll(Processing) → poll(Success+file_id) → retrieve → 下载 */
function mockAudioSequence() {
  return vi.fn()
    // 1. 提交
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ task_id: '888', base_resp: { status_code: 0 } }),
    }))
    // 2. 查询 → Processing（进行中）
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ status: 'Processing', base_resp: { status_code: 0 } }),
    }))
    // 3. 查询 → Success + file_id
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ status: 'Success', file_id: 999, base_resp: { status_code: 0 } }),
    }))
    // 4. 文件检索 → download_url
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ file: { download_url: 'https://cdn.example.com/a.mp3' }, base_resp: { status_code: 0 } }),
    }))
    // 5. 下载
    .mockImplementationOnce(() => Promise.resolve({
      ok: true, status: 200,
      arrayBuffer: async () => Buffer.from('audio-bytes'),
    }));
}

// ─── 1. 能力声明 ───────────────────────────────────────────────────────

describe('MiniMaxProvider capabilities', () => {
  it('单 Provider 声明图+视频+音频三能力', () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const caps = p.getCapabilities();
    expect(caps.modalities).toEqual(expect.arrayContaining(['image', 'video', 'audio']));
    expect(caps.taskTypes).toContain('text_to_image');
    expect(caps.taskTypes).toContain('image_to_image');
    expect(caps.taskTypes).toContain('text_to_video');
    expect(caps.taskTypes).toContain('image_to_video');
    expect(caps.taskTypes).toContain('reference_to_video');
    expect(caps.taskTypes).toContain('audio_tts');
    expect(caps.supportsReferenceImage).toBe(true);
    expect(caps.supportsReferenceVideo).toBe(true);
    expect(caps.supportsReferenceAudio).toBe(true);
    expect(caps.supportsFirstLastFrame).toBe(true);
    expect(caps.supportsAsync).toBe(true); // 视频/音频异步（图片同步，内部统一）
    expect(caps.maxCount).toBe(9);
  });

  it('baseUrl 归一化：剥掉 vendor 继承的 /anthropic 后缀', async () => {
    // LLM 侧 baseUrl 是 https://api.minimaxi.com/anthropic，生成侧要裸域名
    const p = new MiniMaxProvider('minimax', { ...cfg, baseUrl: 'https://api.minimaxi.com/anthropic' });
    const fetchMock = mockFetchOnce({ data: { image_urls: ['https://cdn.example.com/x.png'] }, base_resp: { status_code: 0 } });
    vi.stubGlobal('fetch', fetchMock);
    await p.submitTask({ provider: 'minimax', taskType: 'text_to_image', prompt: 'x' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('https://api.minimaxi.com/v1/image_generation');
    expect(url).not.toContain('/anthropic');
    vi.unstubAllGlobals();
  });
});

// ─── 2. 图片请求构造（同步路径）────────────────────────────────────────

describe('MiniMaxProvider image request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('文生图：提交返回 initialStatus=success + URL', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({
      data: { image_urls: ['https://cdn.example.com/img.png'] },
      base_resp: { status_code: 0 },
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await p.submitTask({
      provider: 'minimax',
      taskType: 'text_to_image',
      prompt: '一只赛博朋克小猫',
      aspectRatio: '16:9',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('image-01');
    expect(body.prompt).toBe('一只赛博朋克小猫');
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.response_format).toBe('url');
    expect(task.initialStatus?.status).toBe('success');
    expect(task.initialStatus?.resultUrl).toBe('https://cdn.example.com/img.png');
    vi.unstubAllGlobals();
  });

  it('图生图：referenceImages 映射到 subject_reference（character）', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({
      data: { image_urls: ['https://cdn.example.com/out.png'] },
      base_resp: { status_code: 0 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'minimax',
      taskType: 'image_to_image',
      prompt: '改成水墨画',
      referenceImages: [{ type: 'url', url: 'https://example.com/in.jpg', role: 'reference' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject_reference).toEqual([{ type: 'character', image_file: 'https://example.com/in.jpg' }]);
    vi.unstubAllGlobals();
  });

  it('base64 参考图包 data: 前缀', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({
      data: { image_urls: ['https://cdn.example.com/out.png'] },
      base_resp: { status_code: 0 },
    });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'minimax',
      taskType: 'image_to_image',
      prompt: 'x',
      referenceImages: [{ type: 'base64', base64: 'aGVsbG8=', role: 'reference' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject_reference[0].image_file).toBe('data:image/jpeg;base64,aGVsbG8=');
    vi.unstubAllGlobals();
  });

  it('图片失败：base_resp.status_code ≠ 0 → initialStatus failed', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({
      base_resp: { status_code: 1004, status_msg: '鉴权失败' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = await p.submitTask({ provider: 'minimax', taskType: 'text_to_image', prompt: 'x' });
    expect(task.initialStatus?.status).toBe('failed');
    expect(task.initialStatus?.errorCode).toBe('1004');
    expect(task.initialStatus?.errorMessage).toContain('鉴权失败');
    vi.unstubAllGlobals();
  });
});

// ─── 3. 视频请求构造（异步路径）────────────────────────────────────────

describe('MiniMaxProvider video request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('文生视频：content 仅含 text，返回 mm-video- taskId', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({ task_id: '424010985738629' });
    vi.stubGlobal('fetch', fetchMock);

    const task = await p.submitTask({
      provider: 'minimax',
      taskType: 'text_to_video',
      prompt: '海浪拍打礁石',
      duration: 5,
      aspectRatio: '16:9',
      resolution: '2K',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('MiniMax-H3');
    expect(body.content[0]).toEqual({ type: 'text', text: '海浪拍打礁石' });
    expect(body.duration).toBe(5);
    expect(body.ratio).toBe('16:9');
    expect(body.resolution).toBe('2K');
    expect(task.taskId).toBe('mm-video-424010985738629');
    expect(task.initialStatus).toBeUndefined(); // 异步，无 initialStatus
    vi.unstubAllGlobals();
  });

  it('图生视频：首尾帧 → content image_url first/last_frame', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({ task_id: '424010985738630' });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'minimax',
      taskType: 'image_to_video',
      prompt: '镜头推进',
      firstFrame: { type: 'url', url: 'https://img.example.com/first.jpg' },
      lastFrame: { type: 'url', url: 'https://img.example.com/last.jpg' },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imgs = body.content.filter((c: { type: string }) => c.type === 'image_url');
    expect(imgs.map((c: { image_url: { role: string } }) => c.image_url.role)).toEqual(['first_frame', 'last_frame']);
    vi.unstubAllGlobals();
  });

  it('多模态参考：referenceImages/Videos/Audio → reference_* roles', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    const fetchMock = mockFetchOnce({ task_id: '424010985738631' });
    vi.stubGlobal('fetch', fetchMock);

    await p.submitTask({
      provider: 'minimax',
      taskType: 'reference_to_video',
      prompt: '角色跳舞',
      referenceImages: [{ type: 'url', url: 'https://img.example.com/ref.jpg', role: 'reference' }],
      referenceVideos: [{ type: 'url', url: 'https://vid.example.com/ref.mp4', role: 'reference_video' }],
      referenceAudio: { type: 'url', url: 'https://aud.example.com/ref.wav', role: 'reference_audio' },
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const roles = body.content.map((c: {
      type: string;
      image_url?: { role?: string };
      video_url?: { role?: string };
      audio_url?: { role?: string };
    }) => c.image_url?.role || c.video_url?.role || c.audio_url?.role || c.type);
    expect(roles).toEqual(expect.arrayContaining(['reference_image', 'reference_video', 'reference_audio']));
    vi.unstubAllGlobals();
  });
});

// ─── 4. 状态映射 ───────────────────────────────────────────────────────

describe('MiniMaxProvider getTaskStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('视频：queued → queuing, succeeded → success + URL', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task: { status: 'queued' } }) })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          task: { status: 'succeeded', content: { url: 'https://cdn.example.com/v.mp4' }, duration: 5 },
        }),
      }));

    const task = { taskId: 'mm-video-123', provider: 'minimax' };
    const queued = await p.getTaskStatus(task);
    expect(queued.status).toBe('queuing');

    const done = await p.getTaskStatus(task);
    expect(done.status).toBe('success');
    expect(done.resultUrl).toBe('https://cdn.example.com/v.mp4');
    expect(done.duration).toBe(5);
    vi.unstubAllGlobals();
  });

  it('视频失败：映射 failed + error', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ task: { status: 'failed', error: { code: '1026', message: 'sensitive content' } } }),
    }));

    const status = await p.getTaskStatus({ taskId: 'mm-video-1', provider: 'minimax' });
    expect(status.status).toBe('failed');
    expect(status.errorCode).toBe('1026');
    vi.unstubAllGlobals();
  });

  it('音频：Processing → success 后调 retrieve 拿 download_url', async () => {
    const p = new MiniMaxProvider('minimax', cfg);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'Processing' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'Success', file_id: 999 }) })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ file: { download_url: 'https://cdn.example.com/a.mp3' }, base_resp: { status_code: 0 } }),
      }));

    const task = { taskId: 'mm-audio-888', provider: 'minimax' };
    const processing = await p.getTaskStatus(task);
    expect(processing.status).toBe('processing');

    const done = await p.getTaskStatus(task);
    expect(done.status).toBe('success');
    expect(done.resultUrl).toBe('https://cdn.example.com/a.mp3');
    vi.unstubAllGlobals();
  });
});

// ─── 5. service 全链路 ────────────────────────────────────────────────

describe('GenerationService minimax flows', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('图片同步：跳过轮询直接转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    const genFetch = mockFetchOnce({
      data: { image_urls: ['https://cdn.example.com/img.png'] },
      base_resp: { status_code: 0 },
    });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => Buffer.from('fake-png-bytes'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const onStatus: string[] = [];
    const artifact = await svc.generate(
      { provider: 'minimax', taskType: 'text_to_image', prompt: '一只猫' },
      { outputDir: path.join(tmpDir, 'outputs', 'generation'), onStatus: s => onStatus.push(s.status) },
    );

    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.byteSize).toBe(14);
    expect(artifact.mediaType).toBe('image/png');
    expect(onStatus).toEqual(['success']);
    vi.unstubAllGlobals();
  });

  it('视频异步：轮询到 success 后转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    vi.stubGlobal('fetch', mockVideoSequence());

    const onStatus: string[] = [];
    const artifact = await svc.generate(
      { provider: 'minimax', taskType: 'text_to_video', prompt: '海浪' },
      {
        outputDir: path.join(tmpDir, 'outputs', 'generation'),
        pollIntervalMs: 1,
        onStatus: s => onStatus.push(s.status),
      },
    );

    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.byteSize).toBe(11); // 'video-bytes'.length
    expect(artifact.mediaType).toBe('video/mp4');
    expect(onStatus).toEqual(expect.arrayContaining(['queuing', 'success']));
    vi.unstubAllGlobals();
  });

  it('音频异步：轮询 + file_id→retrieve 转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    vi.stubGlobal('fetch', mockAudioSequence());

    const onStatus: string[] = [];
    const artifact = await svc.generate(
      { provider: 'minimax', taskType: 'audio_tts', prompt: '你好，世界' },
      {
        outputDir: path.join(tmpDir, 'outputs', 'generation'),
        pollIntervalMs: 1,
        onStatus: s => onStatus.push(s.status),
      },
    );

    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.byteSize).toBe(11); // 'audio-bytes'.length
    expect(artifact.mediaType).toBe('audio/mpeg');
    expect(onStatus).toEqual(expect.arrayContaining(['processing', 'success']));
    vi.unstubAllGlobals();
  });

  it('registry 默认路由：audio_tts → minimax', () => {
    const registry = makeRegistry();
    expect(registry.getDefaultProviderName('audio_tts')).toBe('minimax');
    expect(registry.getDefaultProviderName('text_to_image')).toBe('minimax');
  });
});
