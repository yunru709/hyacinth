/**
 * GenerateMediaTool 测试 — 主 agent 统一多模态生成工具（合并 image/video）
 *
 * 验证点：
 *   1. prompt / modality 必填校验
 *   2. modality 非法值校验
 *   3. 未配置供应商时给出可操作配置指引
 *   4. modality=image 成功生成（text_to_image）+ 负向提示词拼接
 *   5. modality=image + reference_images → image_to_image
 *   6. modality=video 成功生成（text_to_video）
 *   7. modality=video + reference_images → image_to_video（首帧）
 *   8. modality=video + reference_videos → reference_to_video
 *   9. modality=video + first_frame/last_frame 首尾帧透传
 *   10. modality=video + seed 透传
 *   11. modality=audio → audio_tts + voice/speed 透传
 *   12. 视频失败 → Error generating video
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GenerateMediaTool } from './generate-media.js';

// P-Config 收敛后 loadGenerationConfig 只读全局 ~/.agent/generation.json：
// mock homedir → 当前测试临时目录，writeGenerationConfig(tmpDir) 即写全局。
// homeBox 容器在 vi.hoisted 内创建，mock 闭包引用容器而非模块变量，规避 TDZ。
const { mockHomedir, homeBox } = vi.hoisted(() => {
  const homeBox = { path: '' };
  return { homeBox, mockHomedir: vi.fn(() => homeBox.path) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: mockHomedir };
  return { ...mocked, default: mocked };
});

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

/** 视频流程 mock：submit → queued → succeeded → 下载（火山响应格式） */
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

/** 音频流程 mock：submit → Processing → Success+file_id → retrieve → 下载（MiniMax 格式） */
function mockAudioFlow() {
  return vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ task_id: '888', base_resp: { status_code: 0 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'Processing', base_resp: { status_code: 0 } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'Success', file_id: 999, base_resp: { status_code: 0 } }) })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ file: { download_url: 'https://cdn.example.com/a.mp3' }, base_resp: { status_code: 0 } }),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('audio-bytes'),
    });
}

/** 写图+视频（volc）+ 音频（minimax）配置（mock homedir → tmpDir，即写全局） */
function writeGenerationConfig(tmpDir: string) {
  homeBox.path = tmpDir; // homedir → tmpDir：全局配置路径 = tmpDir/.agent/generation.json
  const agentDir = path.join(tmpDir, '.agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'generation.json'),
    JSON.stringify({
      providers: {
        volc: {
          type: 'volcengine',
          models: {
            text_to_image: 'doubao-seedream-5-0-lite-260128',
            text_to_video: 'doubao-seedance-2-0',
            image_to_video: 'doubao-seedance-2-0',
          },
          apiKey: 'test-key',
        },
        minimax: {
          type: 'minimax',
          models: { audio_tts: 'speech-2.8-hd' },
          apiKey: 'test-key',
        },
      },
      defaults: {
        text_to_image: 'volc',
        image_to_image: 'volc',
        text_to_video: 'volc',
        image_to_video: 'volc',
        reference_to_video: 'volc',
        audio_tts: 'minimax',
      },
    }),
  );
}

describe('GenerateMediaTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── 1. 必填校验 ────────────────────────────────────────────────

  it('prompt 必填校验', async () => {
    const tool = new GenerateMediaTool(os.tmpdir());
    const result = await tool.execute({ modality: 'image' });
    expect(result).toContain('prompt is required');
  });

  it('modality 必填校验', async () => {
    const tool = new GenerateMediaTool(os.tmpdir());
    const result = await tool.execute({ prompt: '一只猫' });
    expect(result).toContain('modality');
  });

  it('modality 非法值校验', async () => {
    const tool = new GenerateMediaTool(os.tmpdir());
    const result = await tool.execute({ modality: 'hologram', prompt: 'x' });
    expect(result).toContain('image | video | audio');
  });

  // ── 2. 未配置供应商指引 ───────────────────────────────────────

  it('未配置供应商时返回配置指引', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    homeBox.path = tmpDir; // homedir → 该空目录：全局无 generation.json → 返回配置指引
    const tool = new GenerateMediaTool(tmpDir);
    const result = await tool.execute({ modality: 'image', prompt: '一只猫' });
    expect(result).toContain('no image generation provider configured');
    expect(result).toContain('generation.json');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 3. image 模态 ─────────────────────────────────────────────

  it('modality=image 成功生成并返回本地路径（text_to_image）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';

    const genFetch = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/img.png', size: '1024x1024' }] });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('png-data'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), undefined, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({
      modality: 'image',
      prompt: '赛博朋克小猫',
      negative_prompt: '模糊',
      size: '2K',
    });

    expect(result).toContain('Image generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('image/png');

    // 负向提示词正确拼接（火山格式）
    const body = JSON.parse((genFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.prompt).toContain('--neg: 模糊');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modality=image + reference_images → image_to_image', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';

    const genFetch = mockFetchOnce({ data: [{ url: 'https://cdn.example.com/out.png' }] });
    const dlFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from('png-data'),
    } as unknown as Response);
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(genFetch)
      .mockImplementationOnce(dlFetch));

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), undefined, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      modality: 'image',
      prompt: '改成水墨画',
      reference_images: ['https://img.example.com/in.jpg'],
    });

    const body = JSON.parse((genFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.image).toBe('https://img.example.com/in.jpg'); // 火山单图参考
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 4. video 模态 ─────────────────────────────────────────────

  it('modality=video 成功生成（text_to_video）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({
      modality: 'video',
      prompt: '海浪拍打礁石',
      duration: 5,
      resolution: '720p',
    });

    expect(result).toContain('Video generated and saved to');
    expect(result).toContain('outputs');
    expect(result).toContain('video/mp4');

    // 提交体：text_to_video + 时长 + 分辨率
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.content[0]).toEqual({ type: 'text', text: '海浪拍打礁石' });
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe('720p');
    expect(body.model).toBe('doubao-seedance-2-0');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modality=video + reference_images → image_to_video（首帧）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      modality: 'video',
      prompt: '镜头缓缓推进',
      reference_images: ['https://img.example.com/frame.jpg'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imageContent = body.content.find((c: { type: string }) => c.type === 'image_url');
    expect(imageContent).toBeTruthy();
    expect(imageContent.image_url.url).toBe('https://img.example.com/frame.jpg');
    expect(imageContent.image_url.role).toBe('first_frame');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modality=video + reference_videos → reference_to_video', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      modality: 'video',
      prompt: '模仿这个动作',
      reference_videos: ['https://vid.example.com/ref.mp4'],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const videoContent = body.content.find((c: { type: string }) => c.type === 'video_url');
    expect(videoContent).toBeTruthy();
    expect(videoContent.video_url.url).toBe('https://vid.example.com/ref.mp4');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modality=video + first_frame/last_frame 首尾帧透传', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      modality: 'video',
      prompt: '转场动画',
      first_frame: 'https://img.example.com/first.jpg',
      last_frame: 'https://img.example.com/last.jpg',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const imgs = body.content.filter((c: { type: string }) => c.type === 'image_url');
    expect(imgs.map((c: { image_url: { role: string } }) => c.image_url.role)).toEqual(['first_frame', 'last_frame']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('modality=video + seed 透传', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    const fetchMock = mockVideoFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    await tool.execute({
      modality: 'video',
      prompt: '固定镜头',
      seed: 42,
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.seed).toBe(42);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 5. audio 模态 ─────────────────────────────────────────────

  it('modality=audio → audio_tts + voice/speed 透传', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.MINIMAX_API_KEY = 'test-key';
    const fetchMock = mockAudioFlow();
    vi.stubGlobal('fetch', fetchMock);

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({
      modality: 'audio',
      prompt: '你好，世界',
      voice: 'moss_audio_ce44fc67',
      speed: 1.2,
    });

    expect(result).toContain('Audio generated and saved to');
    expect(result).toContain('audio/mpeg');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('speech-2.8-hd');
    expect(body.text).toBe('你好，世界');
    expect(body.voice_setting.voice_id).toBe('moss_audio_ce44fc67');
    expect(body.voice_setting.speed).toBe(1.2);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 6. 失败路径 ───────────────────────────────────────────────

  it('视频失败 → Error generating video + 错误信息', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-media-'));
    writeGenerationConfig(tmpDir);
    process.env.ARK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-fail' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'failed', error: { code: 'TaskFailed', message: 'render error' } }),
      }));

    const tool = new GenerateMediaTool(tmpDir, path.join(tmpDir, 'outputs', 'generation'), 1, path.join(tmpDir, 'media.sqlite'));
    const result = await tool.execute({ modality: 'video', prompt: 'bad' });
    expect(result).toContain('Error generating video');
    expect(result).toContain('render error');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
