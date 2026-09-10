/**
 * OpenAI 兼容系适配器 视频/音频 内容块映射（P2 多模态）。
 *
 * 覆盖：支持 video 的模型 → video_url（base64 + 采样提示）；
 *       支持 audio 的模型 → input_audio；不支持 → 文本占位；file 引用 → 占位提示。
 */
import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from './compatible.js';
import type { Message } from '../types.js';

function makeProvider(providerType: string, model: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerType,
    model,
    baseUrl: 'http://localhost:1',
    apiKey: 'test-key',
  } as never);
}

function convert(p: OpenAICompatibleProvider, content: Message['content']): unknown {
  return (p as unknown as { convertMessages(m: Message[]): unknown }).convertMessages([
    { role: 'user', content },
  ] as Message[]);
}

describe('compatible 适配器：视频/音频内容块映射', () => {
  it('支持 video 的模型（qwen3.8-max）→ video_url + base64 data URI + 采样提示', () => {
    const p = makeProvider('qwen', 'qwen3.8-max');
    const out = convert(p, [
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'QUFBQQ==' }, media_type: 'video/mp4', sampling: { fps: 1, max_frames: 8 } },
    ]) as Array<{ content: unknown[] }>;
    const parts = out[0]!.content as Array<{ type: string; video_url?: { url: string; fps?: number; max_frames?: number } }>;
    const vp = parts.find((c) => c.type === 'video_url');
    expect(vp).toBeTruthy();
    expect(vp!.video_url!.url).toBe('data:video/mp4;base64,QUFBQQ==');
    expect(vp!.video_url!.fps).toBe(1);
    expect(vp!.video_url!.max_frames).toBe(8);
  });

  it('支持 audio 的模型（mimo-v2.5）→ input_audio + format 映射', () => {
    const p = makeProvider('mimo', 'mimo-v2.5');
    const out = convert(p, [
      { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'UVdF' }, media_type: 'audio/wav' },
    ]) as Array<{ content: Array<{ type: string; input_audio?: { data: string; format: string } }> }>;
    const ap = out[0]!.content.find((c) => c.type === 'input_audio');
    expect(ap).toBeTruthy();
    expect(ap!.input_audio).toEqual({ data: 'UVdF', format: 'wav' });
  });

  it('不支持 video 的模型（deepseek-v4-flash）→ 文本占位', () => {
    const p = makeProvider('deepseek', 'deepseek-v4-flash');
    const out = convert(p, [
      { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'QUFBQQ==' }, media_type: 'video/mp4' },
    ]) as Array<{ content: string }>;
    expect(typeof out[0]!.content).toBe('string');
    expect(out[0]!.content).toContain('[Video: video/mp4]');
  });

  it('不支持 audio 的模型（deepseek-v4-flash）→ 文本占位', () => {
    const p = makeProvider('deepseek', 'deepseek-v4-flash');
    const out = convert(p, [
      { type: 'audio', source: { type: 'base64', media_type: 'audio/mpeg', data: 'QUFB' }, media_type: 'audio/mpeg' },
    ]) as Array<{ content: string }>;
    expect(out[0]!.content).toContain('[Audio: audio/mpeg]');
  });

  it('file 引用视频 → 占位提示需先抽帧/内联', () => {
    const p = makeProvider('qwen', 'qwen3.8-max');
    const out = convert(p, [
      { type: 'video', source: { type: 'file', path: '/tmp/c.mp4' }, media_type: 'video/mp4' },
    ]) as Array<{ content: string }>;
    expect(out[0]!.content).toContain('需先抽帧/内联');
  });
});
