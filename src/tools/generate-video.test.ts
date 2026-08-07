/**
 * GenerateVideoTool 测试 — 验证视频生成工具串起基建层
 *
 * 验证点：
 *   1. prompt 必填校验
 *   2. 未配置供应商时给出可操作的配置指引
 *   3. 配置后成功生成并返回本地路径（mock fetch，含异步轮询）
 *   4. taskType 自动选择：无参考=text_to_video，有参考图=image_to_video，有参考视频=reference_to_video
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerateVideoTool } from './generate-video.js';

/** 按顺序返回的 fetch mock：submit → status(queued) → status(succeeded) → 下载 */
function mockVideoFlow(videoUrl = 'https://cdn.example.com/v.mp4') {
  return vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-v1', status: 'queued' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'queued' }) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'succeeded', content: { video_url: videoUrl } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('video-bytes'),
    });
}

function writeGenerationConfig(tmpDir: string) {
  const agentDir = path.join(tmpDir, '.agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'generation.json'),
    JSON.stringify({
      providers: {
        volc: {
          type: 'volcengine',
          models: { text_to_video: 'doubao-seedance-2-0', image_to_video: 'doubao-seedance-2-0' },
          apiKey: 'test-key',
        },
      },
      defaults: { text_to_video: 'volc', image_to_video: 'volc', reference_to_video: 'volc' },
    }),
  );
}

describe('GenerateVideoTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prompt 必填校验', async () => {
    const tool = new GenerateVideoTool(os.tmpdir());
    const result = await tool.execute({});
    expect(result).toContain('prompt is required');
  });

  it('未配置供应商时返回配置指引', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    const tool = new GenerateVideoTool(tmpDir);
    const result = await tool.execute({ prompt: '海浪' });
    expect(result).toContain('no video generation provider configured');
    expect(result).toContain('generation.json');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('配置后成功生成（text_to_video）并返回本地路径', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1);
    const result = await tool.execute({
      prompt: '海浪拍打礁石',
      duration: 5,
      resolution: '720p',
    });

    expect(result).toContain('Video generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('video/mp4');

    // 请求体：text_to_video + 时长 + 分辨率
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.content[0]).toEqual({ type: 'text', text: '海浪拍打礁石' });
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe('720p');
    expect(body.model).toBe('doubao-seedance-2-0');

    // 产物落盘有效
    const m = result.match(/saved to (.+?)(?:\n|$)/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(m![1])).toBe(true);
    expect(fs.readFileSync(m![1]).toString()).toBe('video-bytes');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('有参考图时选择 image_to_video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1);
    await tool.execute({
      prompt: '让这张图动起来',
      reference_images: ['https://img.example.com/frame.jpg'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imageContent = body.content.find((c: { type: string }) => c.type === 'image_url');
    expect(imageContent).toBeTruthy();
    expect(imageContent.image_url.url).toBe('https://img.example.com/frame.jpg');
    expect(imageContent.image_url.role).toBe('first_frame');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('有参考视频时选择 reference_to_video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1);
    await tool.execute({
      prompt: '结合参考视频',
      reference_videos: ['https://vid.example.com/ref.mp4'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const videoContent = body.content.find((c: { type: string }) => c.type === 'video_url');
    expect(videoContent).toBeTruthy();
    expect(videoContent.video_url.url).toBe('https://vid.example.com/ref.mp4');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('视频失败抛错', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-fail' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'failed', error: { code: 'TaskFailed', message: 'render error' } }),
      }));

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1);
    const result = await tool.execute({ prompt: 'bad' });
    expect(result).toContain('Error generating video');
    expect(result).toContain('render error');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
