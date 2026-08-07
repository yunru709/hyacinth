/**
 * vendor 引用机制测试 — 生成侧厂商从 LLM 侧继承 baseUrl/apiKeyEnv
 *
 * 核心验证：
 *   1. vendor 指向 LLM 侧存在的厂商 → baseUrl/apiKeyEnv 继承
 *   2. 显式填了 baseUrl/apiKeyEnv → 优先用显式的
 *   3. vendor 指向不存在的厂商 → 保留原样（适配器兜底报错）
 *   4. 无 vendor 的独立生成厂商 → 原样不动
 *   5. LLM providers.json 缺失 → 返回空，不崩溃
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveVendorInheritance } from './index.js';
import type { GenerationConfig } from './index.js';

describe('resolveVendorInheritance', () => {
  let tmpDir: string;
  let llmPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-test-'));
    llmPath = path.join(tmpDir, 'providers.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 构造一个含 minimax/volc 的 LLM 侧 providers.json */
  function writeLlmProviders() {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          minimax: {
            id: 'minimax',
            baseUrl: 'https://api.minimaxi.com/anthropic',
            envKey: 'MINIMAX_API_KEY',
            defaultModel: 'MiniMax-M3',
          },
          volc: {
            id: 'volc',
            baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
            envKey: 'ARK_API_KEY',
            defaultModel: 'doubao-...',
          },
        },
      }),
    );
  }

  it('vendor 指向存在的 LLM 厂商 → 继承 baseUrl/apiKeyEnv', () => {
    writeLlmProviders();
    const config: GenerationConfig = {
      providers: {
        minimax: {
          type: 'minimax',
          vendor: 'minimax',
          models: { text_to_video: 'minimax-video-1' },
        },
      },
      defaults: { text_to_video: 'minimax' },
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    expect(resolved.providers.minimax.baseUrl).toBe('https://api.minimaxi.com/anthropic');
    expect(resolved.providers.minimax.apiKeyEnv).toBe('MINIMAX_API_KEY');
    expect(resolved.providers.minimax.models?.text_to_video).toBe('minimax-video-1'); // 只补凭证，不动能力
  });

  it('显式填了 baseUrl/apiKeyEnv → 优先用显式的', () => {
    writeLlmProviders();
    const config: GenerationConfig = {
      providers: {
        minimax: {
          type: 'minimax',
          vendor: 'minimax',
          baseUrl: 'https://custom.example.com', // 显式覆盖
          models: { text_to_video: 'x' },
        },
      },
      defaults: {},
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    expect(resolved.providers.minimax.baseUrl).toBe('https://custom.example.com'); // 未被覆盖
    expect(resolved.providers.minimax.apiKeyEnv).toBe('MINIMAX_API_KEY'); // 缺失的仍继承
  });

  it('vendor 指向不存在的厂商 → 保留原样（不崩溃）', () => {
    writeLlmProviders();
    const config: GenerationConfig = {
      providers: {
        runway: {
          type: 'runway',
          vendor: 'runway', // LLM 侧没有
          baseUrl: 'https://api.runwayml.com',
          apiKeyEnv: 'RUNWAY_API_KEY',
          models: { text_to_video: 'gen3' },
        },
      },
      defaults: {},
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    // 保留自己的 baseUrl/apiKeyEnv（适配器用它）
    expect(resolved.providers.runway.baseUrl).toBe('https://api.runwayml.com');
    expect(resolved.providers.runway.apiKeyEnv).toBe('RUNWAY_API_KEY');
  });

  it('无 vendor 的独立生成厂商 → 原样不动', () => {
    writeLlmProviders();
    const config: GenerationConfig = {
      providers: {
        volc: {
          type: 'volcengine',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          apiKeyEnv: 'ARK_API_KEY',
          models: { text_to_image: 'seedream' },
        },
      },
      defaults: { text_to_image: 'volc' },
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    expect(resolved.providers.volc).toEqual(config.providers.volc); // 无 vendor 完全不动
  });

  it('LLM providers.json 缺失 → 返回空元数据，配置原样保留', () => {
    // 不写 llmPath → 文件不存在
    const config: GenerationConfig = {
      providers: {
        volc: {
          type: 'volcengine',
          vendor: 'volc', // 指向不存在
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          models: { text_to_image: 'seedream' },
        },
      },
      defaults: {},
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    expect(resolved.providers.volc.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(resolved.providers.volc.apiKeyEnv).toBeUndefined(); // 继承不到，保持未定义
  });
});
