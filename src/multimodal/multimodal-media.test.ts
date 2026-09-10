/**
 * 多模态输入管线（P2 多模态视频/音频）单测。
 *
 * 覆盖：
 * - detectVideoPaths / detectAudioPaths；
 * - buildUserContentWithMedia 决策链：原生内联（模型支持+未超限）/ 抽帧降级 / 占位；
 * - view_media 工具：视频抽帧注入 / 音频原生注入。
 * ffmpeg 用 vi.mock 控制（可选依赖语义）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./ffmpeg.js', () => ({
  ffmpegAvailable: vi.fn().mockResolvedValue(false),
  extractFrames: vi.fn().mockResolvedValue([]),
}));

import {
  ImageStore,
  detectVideoPaths,
  detectAudioPaths,
  buildUserContentWithMedia,
  createViewMediaTool,
} from './index.js';
import { extractFrames } from './ffmpeg.js';
import type { MessageContent } from '../types.js';

let tmpDir: string;
let mp4Path: string;
let wavPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-media-'));
  mp4Path = path.join(tmpDir, 'clip.mp4');
  wavPath = path.join(tmpDir, 'voice.wav');
  fs.writeFileSync(mp4Path, Buffer.alloc(2048, 1)); // 2KB 假视频
  fs.writeFileSync(wavPath, Buffer.alloc(1024, 2)); // 1KB 假音频
  vi.mocked(extractFrames).mockResolvedValue([]);
  vi.mocked(extractFrames).mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('路径检测', () => {
  it('detectVideoPaths / detectAudioPaths 识别本地文件', () => {
    expect(detectVideoPaths(`看这个 ${mp4Path}`)).toEqual([mp4Path]);
    expect(detectAudioPaths(`听这个 ${wavPath}`)).toEqual([wavPath]);
    expect(detectVideoPaths('没有路径')).toEqual([]);
  });
});

describe('buildUserContentWithMedia（双轨决策链）', () => {
  it('轨道一：模型支持 video 且未超限 → 原生 VideoContent', async () => {
    const content = await buildUserContentWithMedia(`分析 ${mp4Path}`, {
      imageStore: new ImageStore(),
      supportsVideo: true,
    });
    const blocks = Array.isArray(content) ? content : [content];
    const v = blocks.find((b): b is Extract<MessageContent, { type: 'video' }> => b.type === 'video');
    expect(v).toBeTruthy();
    expect(v!.source).toMatchObject({ type: 'base64', media_type: 'video/mp4' });
  });

  it('轨道二：模型不支持 video 且 ffmpeg 抽帧 → 图片数组', async () => {
    vi.mocked(extractFrames).mockResolvedValue([Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2])]);
    const store = new ImageStore();
    const content = await buildUserContentWithMedia(`分析 ${mp4Path}`, { imageStore: store, supportsVideo: false });
    const blocks = Array.isArray(content) ? content : [content];
    const imgs = blocks.filter((b) => b.type === 'image');
    expect(imgs.length).toBe(2);
    expect(extractFrames).toHaveBeenCalledWith(mp4Path, expect.objectContaining({ max_frames: 16 }));
  });

  it('轨道三：不支持 video 且无 ffmpeg → 占位文本', async () => {
    const content = await buildUserContentWithMedia(`分析 ${mp4Path}`, {
      imageStore: new ImageStore(),
      supportsVideo: false,
    });
    const text = Array.isArray(content) ? content.map((b) => (b as { text?: string }).text).join('') : '';
    expect(text).toContain('[Video file:');
    expect(text).toContain('无法抽帧');
  });

  it('音频：模型支持且未超限 → 原生 AudioContent', async () => {
    const content = await buildUserContentWithMedia(`转写 ${wavPath}`, {
      imageStore: new ImageStore(),
      supportsAudio: true,
    });
    const blocks = Array.isArray(content) ? content : [content];
    const a = blocks.find((b): b is Extract<MessageContent, { type: 'audio' }> => b.type === 'audio');
    expect(a).toBeTruthy();
    expect(a!.source).toMatchObject({ type: 'base64', media_type: 'audio/wav' });
  });
});

describe('view_media 工具', () => {
  it('视频：ffmpeg 抽帧 → 注入图片队列', async () => {
    vi.mocked(extractFrames).mockResolvedValue([Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    const pendingImgs: Array<{ imgId: string; data: string; media_type: string }> = [];
    const pendingMedia: Array<{ type: 'video' | 'audio'; media_type: string; data: string }> = [];
    const tool = createViewMediaTool(new ImageStore(), pendingImgs, pendingMedia);
    const out = await tool.execute({ media_path: mp4Path });
    expect(out).toContain('frames extracted');
    expect(pendingImgs.length).toBe(1);
    expect(pendingMedia.length).toBe(0);
  });

  it('视频：模型支持原生且未超限 → 注入原生视频队列', async () => {
    const pendingImgs: Array<{ imgId: string; data: string; media_type: string }> = [];
    const pendingMedia: Array<{ type: 'video' | 'audio'; media_type: string; data: string }> = [];
    const tool = createViewMediaTool(new ImageStore(), pendingImgs, pendingMedia, {
      getInputTypes: () => ['text', 'video'],
    });
    const out = await tool.execute({ media_path: mp4Path });
    expect(out).toContain('native injection');
    expect(pendingMedia.length).toBe(1);
    expect(pendingMedia[0]).toMatchObject({ type: 'video', media_type: 'video/mp4' });
  });

  it('音频：模型支持原生 → 注入原生音频队列', async () => {
    const pendingImgs: Array<{ imgId: string; data: string; media_type: string }> = [];
    const pendingMedia: Array<{ type: 'video' | 'audio'; media_type: string; data: string }> = [];
    const tool = createViewMediaTool(new ImageStore(), pendingImgs, pendingMedia, {
      getInputTypes: () => ['text', 'audio'],
    });
    const out = await tool.execute({ media_path: wavPath });
    expect(out).toContain('native injection');
    expect(pendingMedia[0]).toMatchObject({ type: 'audio', media_type: 'audio/wav' });
  });
});
