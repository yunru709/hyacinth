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

describe('resolveVendorInheritance — auto-materialize（能力声明即用）', () => {
  let tmpDir: string;
  let llmPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-am-test-'));
    llmPath = path.join(tmpDir, 'providers.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 中转站厂商：一个 key 声明 tts + image + embedding */
  function writeGateway() {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          my_gateway: {
            id: 'my_gateway',
            name: '我的中转站',
            baseUrl: 'https://gateway.example.com/v1',
            defaultModel: 'gpt-4o',
            envKey: 'GATEWAY_API_KEY',
            capabilities: {
              tts: { model: 'tts-1', voice: 'alloy' },
              image: { model: 'dall-e-3' },
              embedding: { model: 'text-embedding-3-small' },
            },
          },
        },
      }),
    );
  }

  it('声明 tts+image+embedding → 物化 openai-compatible 条目（embedding 不进 generation），且默认路由自动写入', () => {
    writeGateway();
    const config: GenerationConfig = { providers: {}, defaults: {} };

    const resolved = resolveVendorInheritance(config, llmPath);

    // 物化条目：type/vendor/models/voice；baseUrl/apiKeyEnv 由 vendor 继承
    const gw = resolved.providers.my_gateway;
    expect(gw).toBeDefined();
    expect(gw!.type).toBe('openai-compatible');
    expect(gw!.vendor).toBe('my_gateway');
    expect(gw!.models).toEqual({ audio_tts: 'tts-1', text_to_image: 'dall-e-3' });
    expect(gw!.voice).toBe('alloy');
    expect(gw!.baseUrl).toBe('https://gateway.example.com/v1'); // 凭证继承
    expect(gw!.apiKeyEnv).toBe('GATEWAY_API_KEY');

    // 声明即用：唯一能力供应商 → 自动默认路由
    expect(resolved.defaults?.audio_tts).toBe('my_gateway');
    expect(resolved.defaults?.text_to_image).toBe('my_gateway');
  });

  it('生成侧已有显式条目同名 → 不物化覆盖（显式优先）', () => {
    writeGateway();
    const config: GenerationConfig = {
      providers: {
        my_gateway: {
          type: 'minimax', // 显式走了别的适配器
          vendor: 'my_gateway',
          baseUrl: 'https://custom.example.com',
          models: { text_to_video: 'm2' },
        },
      },
      defaults: {},
    };

    const resolved = resolveVendorInheritance(config, llmPath);
    expect(resolved.providers.my_gateway.type).toBe('minimax'); // 未被覆盖
    expect(resolved.providers.my_gateway.baseUrl).toBe('https://custom.example.com');
    expect(resolved.providers.my_gateway.models?.text_to_video).toBe('m2');
    // 不产生物化产生的默认路由（显式条目 models 只有 text_to_video，且是唯一供应者 → 自动默认）
    expect(resolved.defaults?.text_to_video).toBe('my_gateway');
  });

  it('两家厂商竞争同一能力 → 不自动默认路由（避免隐式路由意外）', () => {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          gw_a: {
            id: 'gw_a',
            baseUrl: 'https://a.example.com/v1',
            envKey: 'A_API_KEY',
            capabilities: { tts: { model: 'tts-1' } },
          },
          gw_b: {
            id: 'gw_b',
            baseUrl: 'https://b.example.com/v1',
            envKey: 'B_API_KEY',
            capabilities: { tts: { model: 'tts-2' } },
          },
        },
      }),
    );

    const resolved = resolveVendorInheritance({ providers: {}, defaults: {} }, llmPath);
    expect(resolved.providers.gw_a).toBeDefined();
    expect(resolved.providers.gw_b).toBeDefined();
    expect(resolved.defaults?.audio_tts).toBeUndefined(); // 两家竞争 → 不自动
  });

  it('video 无显式 adapter → 跳过并 warning（不物化）', () => {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          gw: {
            id: 'gw',
            baseUrl: 'https://gw.example.com/v1',
            envKey: 'GW_API_KEY',
            capabilities: { video: { model: 'kling-v3' } }, // 无 adapter
          },
        },
      }),
    );

    const resolved = resolveVendorInheritance({ providers: {}, defaults: {} }, llmPath);
    expect(resolved.providers.gw).toBeUndefined();
    expect(resolved.defaults?.text_to_video).toBeUndefined();
  });

  it('显式 adapter 未注册（不在 BUILTIN_ADAPTERS）→ 跳过并 warning，不物化坏条目', () => {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          gw: {
            id: 'gw',
            baseUrl: 'https://gw.example.com/v1',
            envKey: 'GW_API_KEY',
            capabilities: { video: { adapter: 'not-a-real-adapter', model: 'kling-v3' } },
          },
        },
      }),
    );

    const resolved = resolveVendorInheritance({ providers: {}, defaults: {} }, llmPath);
    expect(resolved.providers.gw).toBeUndefined();
    expect(resolved.defaults?.text_to_video).toBeUndefined();
  });

  it('video 带显式 adapter → 物化到指定适配器（如 minimax）', () => {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          gw: {
            id: 'gw',
            baseUrl: 'https://gw.example.com/v1',
            envKey: 'GW_API_KEY',
            capabilities: { video: { adapter: 'minimax', model: 'M2' } },
          },
        },
      }),
    );

    const resolved = resolveVendorInheritance({ providers: {}, defaults: {} }, llmPath);
    expect(resolved.providers.gw?.type).toBe('minimax');
    expect(resolved.providers.gw?.models).toEqual({ text_to_video: 'M2' });
    expect(resolved.defaults?.text_to_video).toBe('gw');
  });

  it('同一厂商多能力走不同适配器 → 拆条目（name 带能力后缀）', () => {
    fs.writeFileSync(
      llmPath,
      JSON.stringify({
        providers: {
          gw: {
            id: 'gw',
            baseUrl: 'https://gw.example.com/v1',
            envKey: 'GW_API_KEY',
            capabilities: {
              tts: { model: 'tts-1' },                    // 默认 openai-compatible
              video: { adapter: 'minimax', model: 'M2' }, // 显式 minimax
            },
          },
        },
      }),
    );

    const resolved = resolveVendorInheritance({ providers: {}, defaults: {} }, llmPath);
    expect(resolved.providers.gw?.type).toBe('openai-compatible'); // 主条目：默认适配器组
    expect(resolved.providers.gw?.models).toEqual({ audio_tts: 'tts-1' });
    expect(resolved.providers['gw-video']?.type).toBe('minimax'); // 后缀条目：另一适配器组
    expect(resolved.providers['gw-video']?.models).toEqual({ text_to_video: 'M2' });
    expect(resolved.defaults?.audio_tts).toBe('gw');
    expect(resolved.defaults?.text_to_video).toBe('gw-video');
  });
});
