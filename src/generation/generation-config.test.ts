import { describe, it, expect, afterEach } from 'vitest';
import type { RuntimeConfigCenter } from '../runtime/config-center.js';
import {
  injectGenerationConfigCenter,
  pollIntervalMs,
  videoPollIntervalMs,
  maxPollAttempts,
  minimaxDefaultVoiceId,
  minimaxAudioFormat,
} from './generation-config.js';

function stubConfigCenter(values: Record<string, unknown>): RuntimeConfigCenter {
  return {
    get: (path: string) => values[path],
  } as unknown as RuntimeConfigCenter;
}

afterEach(() => {
  injectGenerationConfigCenter(null);
});

describe('generation 配置出口', () => {
  it('未注入时回退硬编码默认值（与重构前一致）', () => {
    expect(pollIntervalMs()).toBe(3000);
    expect(videoPollIntervalMs()).toBe(15000);
    expect(maxPollAttempts()).toBe(600);
    expect(minimaxDefaultVoiceId()).toBe('moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85');
    expect(minimaxAudioFormat()).toBe('mp3');
  });

  it('注入后读取 generation.* 配置', () => {
    injectGenerationConfigCenter(
      stubConfigCenter({
        'generation.pollIntervalMs': 1000,
        'generation.videoPollIntervalMs': 8000,
        'generation.maxPollAttempts': 100,
        'generation.minimaxDefaultVoiceId': 'custom-voice-id',
        'generation.minimaxAudioFormat': 'wav',
      }),
    );
    expect(pollIntervalMs()).toBe(1000);
    expect(videoPollIntervalMs()).toBe(8000);
    expect(maxPollAttempts()).toBe(100);
    expect(minimaxDefaultVoiceId()).toBe('custom-voice-id');
    expect(minimaxAudioFormat()).toBe('wav');
  });

  it('部分键未配置时回退默认值', () => {
    injectGenerationConfigCenter(stubConfigCenter({ 'generation.pollIntervalMs': 500 }));
    expect(pollIntervalMs()).toBe(500);
    expect(videoPollIntervalMs()).toBe(15000);
    expect(maxPollAttempts()).toBe(600);
  });

  it('get 抛异常时回退默认值（不炸生成链路）', () => {
    injectGenerationConfigCenter({
      get: () => {
        throw new Error('boom');
      },
    } as unknown as RuntimeConfigCenter);
    expect(pollIntervalMs()).toBe(3000);
    expect(minimaxAudioFormat()).toBe('mp3');
  });
});

describe('GenerationService 轮询参数走配置（回归闸）', () => {
  it('生成服务实例化与配置注入共存（无副作用）', async () => {
    const { GenerationService } = await import('./service.js');
    const registry = { getProvider: () => null } as never;
    const svc = new GenerationService(registry, process.cwd());
    expect(svc).toBeInstanceOf(GenerationService);
    expect(() => injectGenerationConfigCenter(stubConfigCenter({}))).not.toThrow();
  });
});

describe('MiniMax 适配器音色/格式走配置（回归闸）', () => {
  it('注入配置后 buildAudioRequest 使用配置音色与格式', async () => {
    const { MiniMaxProvider } = await import('./adapters/minimax.js');
    injectGenerationConfigCenter(
      stubConfigCenter({
        'generation.minimaxDefaultVoiceId': 'cfg-voice',
        'generation.minimaxAudioFormat': 'wav',
      }),
    );
    // 直接构造 provider（cfg.baseUrl/apiKey 必填），反射调用私有方法验证载荷
    const provider = new MiniMaxProvider('minimax', {
      type: 'minimax',
      baseUrl: 'https://api.minimaxi.com',
      apiKey: 'test-key',
    });
    const body = (
      provider as unknown as {
        buildAudioRequest(req: { prompt: string; voice?: string }): {
          voice_setting: { voice_id: string };
          audio_setting: { format: string };
        };
      }
    ).buildAudioRequest({ prompt: '你好' });

    expect(body.voice_setting.voice_id).toBe('cfg-voice');
    expect(body.audio_setting.format).toBe('wav');

    // req.voice 仍优先于配置
    const body2 = (
      provider as unknown as {
        buildAudioRequest(req: { prompt: string; voice?: string }): {
          voice_setting: { voice_id: string };
        };
      }
    ).buildAudioRequest({ prompt: '你好', voice: 'req-voice' });
    expect(body2.voice_setting.voice_id).toBe('req-voice');
  });
});
