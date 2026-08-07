/**
 * generation-wizard 纯函数测试 — 验证配置构建逻辑
 */

import { describe, it, expect } from 'vitest';
import {
  suggestEnvKey,
  expandModalities,
  buildGenerationConfig,
} from './generation-wizard.js';

describe('suggestEnvKey', () => {
  it('已收录厂商返回建议 envKey', () => {
    expect(suggestEnvKey('volcengine')).toBe('ARK_API_KEY');
    expect(suggestEnvKey('kling')).toBe('KLING_API_KEY');
    expect(suggestEnvKey('minimax')).toBe('MINIMAX_API_KEY');
  });

  it('未收录厂商 fallback 为 TYPE_API_KEY', () => {
    expect(suggestEnvKey('runway')).toBe('RUNWAY_API_KEY');
  });
});

describe('expandModalities', () => {
  const supported = [
    'text_to_image',
    'image_to_image',
    'text_to_video',
    'image_to_video',
    'reference_to_video',
    'audio_tts',
  ] as const;

  it('图片模态 → 展开 image 相关 taskType', () => {
    const result = expandModalities(['image'], [...supported]);
    expect(result).toContain('text_to_image');
    expect(result).toContain('image_to_image');
    expect(result).not.toContain('text_to_video');
    expect(result).not.toContain('audio_tts');
  });

  it('视频模态 → 展开 video 相关 taskType', () => {
    const result = expandModalities(['video'], [...supported]);
    expect(result).toContain('text_to_video');
    expect(result).toContain('image_to_video');
    expect(result).toContain('reference_to_video');
  });

  it('音频模态 → 展开 audio taskType', () => {
    const result = expandModalities(['audio'], [...supported]);
    expect(result).toEqual(['audio_tts']);
  });

  it('多模态 → 合并去重', () => {
    const result = expandModalities(['image', 'video'], [...supported]);
    expect(result).toHaveLength(5);
  });

  it('厂商不支持某模态 → 空结果', () => {
    const onlyImage = ['text_to_image', 'image_to_image'] as const;
    expect(expandModalities(['video'], [...onlyImage])).toEqual([]);
  });
});

describe('buildGenerationConfig', () => {
  it('构建 providers + defaults', () => {
    const config = buildGenerationConfig('volcengine', 'volcengine', {
      text_to_image: 'seedream',
      text_to_video: 'seedance',
    }, 'ARK_API_KEY');
    expect(config.providers.volcengine).toEqual({
      type: 'volcengine',
      apiKeyEnv: 'ARK_API_KEY',
      models: { text_to_image: 'seedream', text_to_video: 'seedance' },
    });
    expect(config.defaults).toEqual({
      text_to_image: 'volcengine',
      text_to_video: 'volcengine',
    });
  });

  it('无 apiKeyEnv 时省略字段', () => {
    const config = buildGenerationConfig('volc', 'volcengine', {
      text_to_image: 'seedream',
    });
    expect(config.providers.volc).toEqual({
      type: 'volcengine',
      models: { text_to_image: 'seedream' },
    });
  });
});
