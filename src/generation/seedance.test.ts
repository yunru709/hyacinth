/**
 * Seedance 异步适配器测试 — 验证 M1 抽象中的异步轮询路径
 *
 * 这是 M1 骨架里"异步路径"（submitTask → 轮询 → 转存）的第一个真实实现验证：
 *   1. submitTask 返回 taskId，不填 initialStatus（区别于同步的 Seedream）
 *   2. service.generate() 检测到无 initialStatus → 进入轮询分支
 *   3. getTaskStatus 状态映射（queued/running/succeeded/failed/expired）
 *   4. 轮询直到 success → 下载转存
 *   5. 多模态 content[] 请求构造（text + image_url + video_url + audio_url）
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerationRegistry, GenerationService } from './index.js';
import { VolcSeedanceProvider } from './adapters/volc-seedance.js';
import type { GenerationProviderConfig } from './interface.js';

const cfg: GenerationProviderConfig = {
  type: 'volc-seedance',
  model: 'doubao-seedance-2-0',
  apiKey: 'test-key',
};

function makeRegistry(): GenerationRegistry {
  return new GenerationRegistry({
    providers: { volc: cfg },
    defaults: { video: 'volc' },
  });
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

describe('VolcSeedanceProvider capabilities', () => {
  it('声明为异步视频生成，支持多模态参考', () => {
    const p = new VolcSeedanceProvider('volc', cfg);
    const caps = p.getCapabilities();
    expect(caps.modality).toBe('video');
    expect(caps.supportsAsync).toBe(true);
    expect(caps.supportsReferenceImage).toBe(true);
    expect(caps.supportsReferenceVideo).toBe(true);
    expect(caps.supportsReferenceAudio).toBe(true);
    expect(caps.supportsFirstLastFrame).toBe(true);
  });
});

// ─── 2. submitTask 异步语义 ───────────────────────────────────────────

describe('VolcSeedanceProvider submitTask', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('返回 taskId，不填 initialStatus（区别于同步 Seedream）', async () => {
    const p = new VolcSeedanceProvider('volc', cfg);
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
    expect(task.provider).toBe('volc-seedance');
    vi.unstubAllGlobals();
  });

  it('多模态参考构造 content[] 数组（text+image+video+audio）', async () => {
    const p = new VolcSeedanceProvider('volc', cfg);
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
    const p = new VolcSeedanceProvider('volc', cfg);
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

// ─── 3. getTaskStatus 状态映射 ────────────────────────────────────────

describe('VolcSeedanceProvider getTaskStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('映射 queued → queuing, succeeded → success 并带结果 URL', async () => {
    const p = new VolcSeedanceProvider('volc', cfg);
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

    const task = { taskId: 'task-1', provider: 'volc-seedance' };
    const queued = await p.getTaskStatus(task);
    expect(queued.status).toBe('queuing');

    const done = await p.getTaskStatus(task);
    expect(done.status).toBe('success');
    expect(done.resultUrl).toBe('https://cdn.example.com/v.mp4');
    expect(done.thumbnailUrl).toBe('https://cdn.example.com/f.png');
    vi.unstubAllGlobals();
  });
});

// ─── 4. service 全链路：异步轮询 + 转存 ───────────────────────────────

describe('GenerationService async flow', () => {
  let tmpDir: string;
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-async-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('异步任务走轮询：submit → queuing → processing → success → 下载转存', async () => {
    const registry = makeRegistry();
    const svc = new GenerationService(registry, tmpDir);

    // 4 次调用：submit(返回taskId) → status(queued) → status(succeeded) → 下载
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
        pollIntervalMs: 1, // 测试加速
        onStatus: s => onStatus.push(s.status),
      },
    );

    // 状态流：先 queuing 再 success（同步接口没有 queuing，异步有——差异正确）
    expect(onStatus).toEqual(['queuing', 'queuing', 'success']);
    expect(fs.existsSync(artifact.localPath)).toBe(true);
    expect(artifact.mediaType).toBe('video/mp4');
    expect(artifact.byteSize).toBe(11); // 'video-bytes'.length
    expect(artifact.sourceUrl).toBe('https://cdn.example.com/v.mp4');
  });

  it('异步任务失败：轮询到 failed 抛错', async () => {
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
