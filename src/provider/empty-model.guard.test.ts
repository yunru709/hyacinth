/**
 * 空串模型名守卫 —— 2026-11-08 事故的可执行记忆。
 *
 * 事故：`~/.agent/config.json` 的 `provider.active = "opencode"`，但**没有**
 * `provider.opencode` 段，顶层 `model` 也没写 ⇒ `DEFAULT_CONFIG` 的 `model: ''`
 * （**空串，不是 undefined**）成为最终值 ⇒ 因为回落链用的是 `??`，而 `??` 只认
 * null/undefined，空串一路穿透到请求体 ⇒ 上游 400 `model must be a non-empty string`。
 * 症状极具误导性：**主对话（走 model-channels 通道）完全正常，只有主 provider 路径 400**。
 *
 * 判据：空字符串不是合法模型名 ⇒ 任何 model 回落链都必须把 `''` 当作"未配置"。
 * 本文件锁两件事：
 *   ① 静态：provider 工厂/装配层不得再用 `X?.model ?? ...defaultModel`（会被空串短路）；
 *   ② 行为：显式传 `model: ''` 必须回落到该厂商的 defaultModel，而不是拿到空串。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProviderConfigLoader, __setProviderConfigLoaderForTest } from './config.js';
import { createMiMoProvider } from './mimo.js';

const PROVIDER_DIR = path.join(process.cwd(), 'src', 'provider');

/** 命中「用 ?? 取 model」的写法（`??` 右侧紧跟 defaultModel） */
const NULLISH_MODEL_RE = /(?:config|cfg)\?\.model\s*\?\?/;

afterEach(() => {
  __setProviderConfigLoaderForTest(undefined);
});

describe('空串模型名守卫', () => {
  it('model 回落链不得用 ?? —— 空串会短路掉厂商默认模型', () => {
    const offenders: string[] = [];
    const files = fs
      .readdirSync(PROVIDER_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    for (const file of files) {
      const src = fs.readFileSync(path.join(PROVIDER_DIR, file), 'utf-8');
      src.split('\n').forEach((line, i) => {
        if (NULLISH_MODEL_RE.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      `model 回落链必须用 ||（空串视为缺失），这些位置仍是 ??：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('显式传空串模型 → 回落到该厂商的 defaultModel', async () => {
    const tmp = path.join(os.tmpdir(), `hyacinth-guard-providers-${process.pid}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        providers: {
          mimo: {
            id: 'mimo',
            name: 'MiMo',
            baseUrl: 'https://example.invalid/anthropic',
            defaultModel: 'guard-default-model',
            envKey: 'MIMO_API_KEY',
          },
        },
      }),
      'utf-8',
    );

    try {
      const loader = new ProviderConfigLoader(process.cwd(), tmp);
      await loader.load();
      __setProviderConfigLoaderForTest(loader);

      const provider = createMiMoProvider({ apiKey: 'test-key', model: '' });
      expect(provider.getModel()).toBe('guard-default-model');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
