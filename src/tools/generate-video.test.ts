/**
 * GenerateVideoTool ???? ?? ?????????????????????
 *
 * ?????
 *   1. prompt ????§µ??
 *   2. ¦Ä???¨´???????????????????????
 *   3. ???¨²???????????????¡¤????mock fetch???????????
 *   4. taskType ????????¦Ï?=text_to_video???§Ó¦Ï??=image_to_video???§Ó¦Ï????=reference_to_video
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerateVideoTool } from './generate-video.js';

/** ???????? fetch mock??submit ?? status(queued) ?? status(succeeded) ?? ???? */
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

  it('prompt ????§µ??', async () => {
    const tool = new GenerateVideoTool(os.tmpdir());
    const result = await tool.execute({});
    expect(result).toContain('prompt is required');
  });

  it('¦Ä???¨´????????????????', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    const tool = new GenerateVideoTool(tmpDir);
    const result = await tool.execute({ prompt: '????' });
    expect(result).toContain('no video generation provider configured');
    expect(result).toContain('generation.json');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('???¨²????????text_to_video???????????¡¤??', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({
      prompt: '????????',
      duration: 5,
      resolution: '720p',
    });

    expect(result).toContain('Video generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('video/mp4');

    // ?????‰Øtext_to_video + ??? + ?????
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.content[0]).toEqual({ type: 'text', text: '????????' });
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe('720p');
    expect(body.model).toBe('doubao-seedance-2-0');

    // ??????????§¹
    const m = result.match(/saved to (.+?)(?:\n|$)/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(m![1])).toBe(true);
    expect(fs.readFileSync(m![1]).toString()).toBe('video-bytes');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('?§Ó¦Ï?????? image_to_video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      prompt: '?????????????',
      reference_images: ['https://img.example.com/frame.jpg'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imageContent = body.content.find((c: { type: string }) => c.type === 'image_url');
    expect(imageContent).toBeTruthy();
    expect(imageContent.image_url.url).toBe('https://img.example.com/frame.jpg');
    expect(imageContent.image_url.role).toBe('first_frame');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('?§Ó¦Ï???????? reference_to_video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      prompt: '???¦Ï????',
      reference_videos: ['https://vid.example.com/ref.mp4'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const videoContent = body.content.find((c: { type: string }) => c.type === 'video_url');
    expect(videoContent).toBeTruthy();
    expect(videoContent.video_url.url).toBe('https://vid.example.com/ref.mp4');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('?????????', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-video-tool-'));
    writeGenerationConfig(tmpDir);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-fail' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'failed', error: { code: 'TaskFailed', message: 'render error' } }),
      }));

    const tool = new GenerateVideoTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({ prompt: 'bad' });
    expect(result).toContain('Error generating video');
    expect(result).toContain('render error');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
